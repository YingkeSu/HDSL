/**
 * S5 (#79) network negative control: GitHub 403/429 precision.
 *
 * The frozen contract D11 maps any `403`/`429` to `RATE_LIMITED`. This test
 * documents the CURRENT behaviour for responses that carry NO reliable
 * rate-limit signal (no `retry-after` / `x-ratelimit-reset`), which is exactly
 * the case where GitHub can also return 403 for permission/authentication
 * reasons: the adapter does NOT distinguish those today and returns
 * `RATE_LIMITED` with NO fabricated `retryAfterSeconds`.
 *
 * This is a coverage/precision limitation recorded for #79 (and pending an
 * adjudication of the contract text vs behaviour); it is NOT a claim that a
 * permission-class 403 is correctly identified as rate limiting.
 */
import { describe, expect, it } from 'vitest';
import { createGitHubPluginSource } from '@hdsl/runtime';

const source = (response: Response) =>
  createGitHubPluginSource({
    fetch: () => Promise.resolve(response),
    now: () => new Date('2026-01-02T03:04:05Z'),
  });

describe('GitHub 403/429 without a reliable rate-limit signal (S5 #79)', () => {
  it('403 with no retry-after/x-ratelimit-reset: RATE_LIMITED per D11 and no fabricated retryAfterSeconds', async () => {
    const outcome = await source(new Response('{}', { status: 403 })).search('q', new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RATE_LIMITED'); // D11 literal: 403 -> RATE_LIMITED
    expect(outcome.retryAfterSeconds).toBeUndefined(); // never invented
  });

  it('429 with no retry-after/x-ratelimit-reset: RATE_LIMITED with no fabricated retryAfterSeconds', async () => {
    const outcome = await source(new Response('{}', { status: 429 })).search('q', new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('RATE_LIMITED');
    expect(outcome.retryAfterSeconds).toBeUndefined();
  });
});
