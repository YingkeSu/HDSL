/**
 * Issue #95 (was S5 #79 negative control): GitHub 403 precision.
 *
 * GitHub returns `403` for three different situations:
 *  1. primary/secondary rate limiting (documented reliable signals exist),
 *  2. missing permission / bad authentication (`Resource not accessible by ...`),
 *  3. abuse protection (an explicit message).
 *
 * Decision B (recorded on #95): a `403` is `RATE_LIMITED` (retryable) ONLY when
 * GitHub gives one of its documented rate-limit signals: a `retry-after`
 * header, an exhausted `x-ratelimit-remaining: 0`, or an explicit
 * rate-limit/abuse message. A bare `x-ratelimit-reset` is present on every
 * response and is NOT evidence. A `403` without evidence maps to the new,
 * non-retryable `SOURCE_ACCESS_DENIED`; `429` stays `RATE_LIMITED`.
 *
 * The adapter never fabricates `retryAfterSeconds`: a value only comes from
 * `retry-after`, or from `x-ratelimit-reset` when `x-ratelimit-remaining: 0`.
 */
import { isRetryable } from '@hdsl/contracts';
import { createGitHubPluginSource } from '@hdsl/runtime';
import { describe, expect, it } from 'vitest';

const source = (response: Response) =>
  createGitHubPluginSource({
    fetch: () => Promise.resolve(response),
    now: () => new Date('2026-01-02T03:04:05Z'),
  });

const json403 = (message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ message }), {
    status: 403,
    headers: { 'content-type': 'application/json', ...headers },
  });

const signal = (): AbortSignal => new AbortController().signal;

describe('GitHub 403 with reliable rate-limit evidence stays RATE_LIMITED (#95)', () => {
  it('403 with retry-after is RATE_LIMITED with that delay', async () => {
    const outcome = await source(json403('x', { 'retry-after': '42' })).search('q', signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RATE_LIMITED');
    expect(isRetryable(outcome.code)).toBe(true);
    expect(outcome.retryAfterSeconds).toBe(42);
  });

  it('403 with x-ratelimit-remaining: 0 is RATE_LIMITED and derives the delay only from reset', async () => {
    const outcome = await source(
      json403('x', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767318246' }),
    ).search('q', signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RATE_LIMITED');
    // 2026-01-02T03:04:05Z is epoch 1767323045; the reset is in the past → clamp 1.
    expect(outcome.retryAfterSeconds).toBe(1);
  });

  it('403 with an explicit secondary-limit message is RATE_LIMITED and invents no delay', async () => {
    const outcome = await source(
      json403('You have exceeded a secondary rate limit. Please wait a few minutes before you try again.'),
    ).search('q', signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RATE_LIMITED');
    expect(outcome.retryAfterSeconds).toBeUndefined();
  });

  it('403 with an abuse-detection message is RATE_LIMITED', async () => {
    const outcome = await source(
      json403('You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.'),
    ).inspect({ owner: 'octo', name: 'demo' }, signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RATE_LIMITED');
  });

  it('429 is RATE_LIMITED even without any rate-limit header; no fabricated delay', async () => {
    const outcome = await source(new Response('{}', { status: 429 })).search('q', signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RATE_LIMITED');
    expect(isRetryable(outcome.code)).toBe(true);
    expect(outcome.retryAfterSeconds).toBeUndefined();
  });
});

describe('GitHub 403 without evidence is a non-retryable SOURCE_ACCESS_DENIED (#95)', () => {
  it('403 with no headers is SOURCE_ACCESS_DENIED, non-retryable, no retryAfterSeconds', async () => {
    const outcome = await source(new Response('{}', { status: 403 })).search('q', signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('SOURCE_ACCESS_DENIED');
    expect(isRetryable(outcome.code)).toBe(false);
    expect(outcome.retryAfterSeconds).toBeUndefined();
  });

  it('403 with x-ratelimit-reset but remaining>0 is SOURCE_ACCESS_DENIED (N2 regression)', async () => {
    const outcome = await source(
      json403('Resource not accessible by personal access token', {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '57',
        'x-ratelimit-reset': '1767328246',
      }),
    ).search('q', signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('SOURCE_ACCESS_DENIED');
    expect(outcome.retryAfterSeconds).toBeUndefined();
  });

  it('403 with a permission message is SOURCE_ACCESS_DENIED and never leaks the raw body', async () => {
    const canary = 'canary-95-secret';
    const outcome = await source(
      json403(`Resource not accessible by personal access token ${canary}`),
    ).search('q', signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('SOURCE_ACCESS_DENIED');
    expect(outcome.message).not.toContain(canary);
    expect(outcome.message).not.toContain('personal access token');
    expect(outcome.retryAfterSeconds).toBeUndefined();
  });

  it('applies to inspect and preview, not only search', async () => {
    const inspected = await source(new Response('{}', { status: 403 })).inspect(
      { owner: 'octo', name: 'demo' },
      signal(),
    );
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) {
      expect(inspected.code).toBe('SOURCE_ACCESS_DENIED');
    }

    const previewed = await source(new Response('{}', { status: 403 })).previewSource(
      { owner: 'octo', name: 'demo' },
      signal(),
    );
    expect(previewed.ok).toBe(false);
    if (!previewed.ok) {
      expect(previewed.code).toBe('SOURCE_ACCESS_DENIED');
      expect(previewed.retryAfterSeconds).toBeUndefined();
    }
  });

  it('a stalled 403 body still resolves to a controlled non-retryable failure', async () => {
    const stalled = {
      ok: false,
      status: 403,
      headers: new Headers(),
      text: () => new Promise<never>(() => undefined),
    } as unknown as Response;
    const outcome = await createGitHubPluginSource({
      fetch: () => Promise.resolve(stalled),
      timeoutMs: 5,
    }).search('q', signal());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('SOURCE_ACCESS_DENIED');
  });
});
