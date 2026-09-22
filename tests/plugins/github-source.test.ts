/**
 * GitHub read adapter unit tests (issue #75, S1).
 *
 * These use a **controlled** `fetch` double: they assert the exact query that
 * is sent, the D11 error mapping, the 1000-result ceiling and that no GitHub
 * credential is read. They are NOT evidence about the real GitHub API (ADR 0005
 * D19): a real read-only probe is opt-in and bounded, not part of default CI.
 */
import { describe, expect, it } from 'vitest';
import { createGitHubPluginSource, rateLimitRetryAfterSeconds } from '@hdsl/runtime';

interface RecordedRequest {
  readonly url: string;
  readonly init: { readonly headers?: Readonly<Record<string, string>>; readonly signal?: AbortSignal } | undefined;
}

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const setup = (
  respond: (request: RecordedRequest) => Promise<Response>,
  options: { readonly timeoutMs?: number; readonly now?: () => Date } = {},
) => {
  const calls: RecordedRequest[] = [];
  const source = createGitHubPluginSource({
    fetch: (url, init) => {
      const request: RecordedRequest = { url, init };
      calls.push(request);
      return respond(request);
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    now: options.now ?? (() => new Date('2026-01-02T03:04:05Z')),
  });
  return { source, calls };
};

const repository = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  full_name: 'octo/dsh-plugin-demo',
  name: 'dsh-plugin-demo',
  owner: { login: 'octo' },
  description: 'demo plugin',
  html_url: 'https://github.com/octo/dsh-plugin-demo',
  stargazers_count: 12,
  topics: ['dsh-plugin'],
  default_branch: 'main',
  updated_at: '2026-01-01T00:00:00Z',
  archived: false,
  fork: false,
  license: { spdx_id: 'MIT', name: 'MIT License' },
  homepage: 'https://example.invalid/demo',
  ...overrides,
});

describe('plugins.search (GitHub read-only adapter)', () => {
  it('sends the query character for character and echoes it in the terminal payload', async () => {
    const query = 'topic:dsh-plugin fork:false archived:false';
    const { source, calls } = setup(() =>
      Promise.resolve(jsonResponse({ total_count: 1, incomplete_results: false, items: [repository()] })),
    );
    const outcome = await source.search(query, new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.query).toBe(query);
    const sent = new URL(calls[0]?.url ?? '');
    expect(sent.pathname).toBe('/search/repositories');
    expect(sent.searchParams.get('q')).toBe(query);
    expect(calls[0]?.url).toContain(`q=${encodeURIComponent(query)}`);
    expect(outcome.value.hits[0]?.fullName).toBe('octo/dsh-plugin-demo');
    expect(outcome.value.hits[0]?.license).toBe('MIT');
    expect(outcome.value.hasMore).toBe(false);
    expect(outcome.value.fetchedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('reports the 1000-result ceiling through totalCount and hasMore instead of truncating silently', async () => {
    const { source } = setup(() =>
      Promise.resolve(
        jsonResponse({ total_count: 4321, incomplete_results: true, items: [repository()] }),
      ),
    );
    const outcome = await source.search('topic:dsh-plugin', new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.totalCount).toBe(4321);
    expect(outcome.value.incompleteResults).toBe(true);
    expect(outcome.value.hasMore).toBe(true);
  });

  it('accepts real GitHub repository names containing "_"/"."', async () => {
    const { source } = setup(() =>
      Promise.resolve(
        jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            repository({
              full_name: 'octo/AI_Animation',
              name: 'AI_Animation',
              html_url: 'https://github.com/octo/AI_Animation',
            }),
          ],
        }),
      ),
    );
    const outcome = await source.search('topic:dsh-plugin', new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.hits[0]?.name).toBe('AI_Animation');
    expect(outcome.value.hits[0]?.htmlUrl).toBe('https://github.com/octo/AI_Animation');
  });

  it('maps 403/429 to RATE_LIMITED with a machine-readable retry delay', async () => {
    const retryAfter = setup(() =>
      Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '42' } })),
    );
    const retryOutcome = await retryAfter.source.search('q', new AbortController().signal);
    expect(retryOutcome.ok).toBe(false);
    if (retryOutcome.ok) return;
    expect(retryOutcome.code).toBe('RATE_LIMITED');
    expect(retryOutcome.retryAfterSeconds).toBe(42);

    const reset = setup(() =>
      Promise.resolve(
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-reset': String(1_000_120) },
        }),
      ),
      { now: () => new Date(1_000_000 * 1000) },
    );
    const resetOutcome = await reset.source.search('q', new AbortController().signal);
    expect(resetOutcome.ok).toBe(false);
    if (resetOutcome.ok) return;
    expect(resetOutcome.code).toBe('RATE_LIMITED');
    expect(resetOutcome.retryAfterSeconds).toBe(120);
  });

  it('maps a connection failure to NETWORK_UNAVAILABLE', async () => {
    const { source } = setup(() => Promise.reject(new Error('dns failure; /Users/secret')));
    const outcome = await source.search('q', new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NETWORK_UNAVAILABLE');
    expect(JSON.stringify(outcome)).not.toContain('/Users/secret');
  });

  it('maps a timeout before any response to NETWORK_UNAVAILABLE', async () => {
    const { source } = setup(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      { timeoutMs: 5 },
    );
    const outcome = await source.search('q', new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NETWORK_UNAVAILABLE');
  });

  it('keeps the body read inside the 15s deadline: a stalled body still times out', async () => {
    const stalledBody = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise<never>(() => undefined),
    } as unknown as Response;
    const { source } = setup(() => Promise.resolve(stalledBody), { timeoutMs: 5 });
    const outcome = await source.search('q', new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NETWORK_UNAVAILABLE');
  });

  it('lets caller cancellation interrupt a stalled body read', async () => {
    const stalledBody = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise<never>(() => undefined),
    } as unknown as Response;
    const { source } = setup(() => Promise.resolve(stalledBody), { timeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = source.search('q', controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 5);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NETWORK_UNAVAILABLE');
  });

  it('clips oversized free-text description instead of failing the whole search', async () => {
    const { source } = setup(() =>
      Promise.resolve(
        jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [repository({ description: 'x'.repeat(900) })],
        }),
      ),
    );
    const outcome = await source.search('topic:dsh-plugin', new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const description = outcome.value.hits[0]?.description ?? '';
    expect([...description].length).toBeLessThanOrEqual(512);
    expect(description.endsWith('…')).toBe(true);
    expect(outcome.value.incompleteResults).toBe(false);
  });

  it('drops a structurally invalid hit but keeps the valid hits and flags incompleteness', async () => {
    const { source } = setup(() =>
      Promise.resolve(
        jsonResponse({
          total_count: 2,
          incomplete_results: false,
          items: [
            repository(),
            // A repository name is a schema-invalid structural identifier; the
            // hit must be dropped, not silently corrupted by clipping.
            repository({ full_name: 'octo/bad name', name: 'bad name', html_url: 'https://github.com/octo/bad name' }),
          ],
        }),
      ),
    );
    const outcome = await source.search('topic:dsh-plugin', new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.hits.length).toBe(1);
    expect(outcome.value.hits[0]?.name).toBe('dsh-plugin-demo');
    expect(outcome.value.incompleteResults).toBe(true);
  });

  it('sends no GitHub credential, even when GITHUB_TOKEN is present in the environment', async () => {
    const previous = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'canary-token-should-not-be-read';
    try {
      const { source, calls } = setup(() =>
        Promise.resolve(jsonResponse({ total_count: 0, incomplete_results: false, items: [] })),
      );
      await source.search('q', new AbortController().signal);
      const headers = calls[0]?.init?.headers ?? {};
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
      expect(JSON.stringify(calls[0]?.init)).not.toContain('canary-token-should-not-be-read');
    } finally {
      if (previous === undefined) {
        delete process.env['GITHUB_TOKEN'];
      } else {
        process.env['GITHUB_TOKEN'] = previous;
      }
    }
  });

  it('maps a malformed body to DOWNLOAD_FAILED and 404 to SOURCE_NOT_FOUND', async () => {
    const malformed = setup(() => Promise.resolve(new Response('not json', { status: 200 })));
    const malformedOutcome = await malformed.source.search('q', new AbortController().signal);
    expect(malformedOutcome.ok).toBe(false);
    if (!malformedOutcome.ok) {
      expect(malformedOutcome.code).toBe('DOWNLOAD_FAILED');
    }

    const missing = setup(() => Promise.resolve(jsonResponse({ message: 'Not Found' }, 404)));
    const missingOutcome = await missing.source.search('q', new AbortController().signal);
    expect(missingOutcome.ok).toBe(false);
    if (!missingOutcome.ok) {
      expect(missingOutcome.code).toBe('SOURCE_NOT_FOUND');
    }
  });
});

describe('plugins.inspect (GitHub read-only adapter)', () => {
  it('returns public repository detail and echoes the requested source', async () => {
    const { source, calls } = setup(() => Promise.resolve(jsonResponse(repository())));
    const outcome = await source.inspect(
      { owner: 'octo', name: 'dsh-plugin-demo', ref: 'main' },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(calls[0]?.url).toContain('/repos/octo/dsh-plugin-demo');
    expect(outcome.value.source).toEqual({ owner: 'octo', name: 'dsh-plugin-demo', ref: 'main' });
    expect(outcome.value.repository.stars).toBe(12);
    expect(outcome.value.repository.topics).toEqual(['dsh-plugin']);
    expect(outcome.value.repository.homepage).toBe('https://example.invalid/demo');
  });

  it('maps an unknown repository to SOURCE_NOT_FOUND', async () => {
    const { source } = setup(() => Promise.resolve(jsonResponse({ message: 'Not Found' }, 404)));
    const outcome = await source.inspect({ owner: 'octo', name: 'nope' }, new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('SOURCE_NOT_FOUND');
    }
  });
});

describe('rateLimitRetryAfterSeconds', () => {
  const headers = (values: Record<string, string>) => ({
    get: (name: string) => values[name] ?? null,
  });

  it('prefers retry-after, falls back to the reset epoch and clamps at one second', () => {
    expect(rateLimitRetryAfterSeconds(headers({ 'retry-after': '30' }), 0)).toBe(30);
    expect(rateLimitRetryAfterSeconds(headers({ 'x-ratelimit-reset': '1000120' }), 1_000_000_000)).toBe(120);
    expect(rateLimitRetryAfterSeconds(headers({ 'x-ratelimit-reset': '900' }), 1_000_000_000)).toBe(1);
    expect(rateLimitRetryAfterSeconds(headers({}), 0)).toBeUndefined();
  });
});
