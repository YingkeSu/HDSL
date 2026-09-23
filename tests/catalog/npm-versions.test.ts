/**
 * npm registry version-discovery adapter tests (A1 / #113).
 *
 * Deterministic, offline: a controlled `fetch` response is the only input. These
 * prove the allowlisted host, the audited/unaudited marking, and the D11-style
 * error classification. They never touch the real registry.
 */
import { describe, expect, it } from 'vitest';
import { dshVersionListingSchema, type RuntimeCombination } from '@hdsl/contracts';
import {
  VERIFIED_COMBINATIONS,
  auditedDshVersions,
  createNpmDshVersionSource,
  type VersionFetchLike,
} from '@hdsl/runtime';

const combination = (id: string, version: string, status: 'verified' | 'unverified'): RuntimeCombination => ({
  id,
  platform: 'darwin',
  arch: 'arm64',
  node: { version: '24.21.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version, platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  compatibility: { status, evidenceRef: 'docs/research/dsh-compatibility.md' },
  artifactLocations: {
    node: { version: '24.21.0', platform: 'darwin', arch: 'arm64', url: 'https://example.invalid/node.tar.gz', sha256: 'a'.repeat(64) },
    dsh: { version, platform: 'darwin', arch: 'arm64', url: 'https://example.invalid/dsh.tgz', sha256: 'b'.repeat(64) },
  },
});

const CATALOG: readonly RuntimeCombination[] = [
  combination('combo-a', '0.1.5-rc.2', 'verified'),
  // An unverified combination must NOT mark an upstream version supported.
  combination('combo-b', '0.1.5-rc.4', 'unverified'),
];

const REGISTRY_BODY = {
  'dist-tags': { latest: '0.1.5-rc.2', next: '0.1.5-rc.3', bad: 42 },
  versions: {
    '0.1.5-rc.1': { name: '@deepseek-ai/dsh' },
    '0.1.5-rc.2': { name: '@deepseek-ai/dsh' },
    '0.1.5-rc.3': { name: '@deepseek-ai/dsh' },
    '0.1.5-rc.4': { name: '@deepseek-ai/dsh' },
  },
  time: {
    created: '2025-11-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    '0.1.5-rc.2': '2025-12-01T00:00:00.000Z',
  },
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const CLOCK = (): Date => new Date('2026-09-23T00:00:00.000Z');

describe('createNpmDshVersionSource', () => {
  it('reads dist-tags/versions/time and marks only the audited version supported', async () => {
    const calls: { url: string; headers?: Readonly<Record<string, string>> }[] = [];
    const fetch: VersionFetchLike = (url, init) => {
      calls.push({ url, ...(init?.headers === undefined ? {} : { headers: init.headers }) });
      return Promise.resolve(jsonResponse(REGISTRY_BODY));
    };
    const source = createNpmDshVersionSource({ fetch, catalog: CATALOG, now: CLOCK });
    const outcome = await source.listVersions(new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // One allowlisted, credential-free request.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://registry.npmjs.org/@deepseek-ai%2fdsh');
    expect(calls[0]?.headers?.['accept']).toBe('application/json');
    expect(Object.keys(calls[0]?.headers ?? {}).map((key) => key.toLowerCase())).not.toContain('authorization');

    const listing = outcome.value;
    expect(listing.source).toEqual({ registry: 'https://registry.npmjs.org', packageName: '@deepseek-ai/dsh' });
    expect(listing.fetchedAt).toBe('2026-09-23T00:00:00.000Z');
    expect(listing.distTags).toEqual([
      { tag: 'latest', version: '0.1.5-rc.2' },
      { tag: 'next', version: '0.1.5-rc.3' },
    ]);
    // Newest first; `bad: 42` is dropped.
    expect(listing.versions.map((entry) => entry.version)).toEqual([
      '0.1.5-rc.4',
      '0.1.5-rc.3',
      '0.1.5-rc.2',
      '0.1.5-rc.1',
    ]);
    const rc2 = listing.versions.find((entry) => entry.version === '0.1.5-rc.2');
    expect(rc2).toMatchObject({
      supported: true,
      catalogCombinationIds: ['combo-a'],
      distTags: ['latest'],
      publishedAt: '2025-12-01T00:00:00.000Z',
    });
    const rc3 = listing.versions.find((entry) => entry.version === '0.1.5-rc.3');
    expect(rc3).toMatchObject({ supported: false, catalogCombinationIds: [], distTags: ['next'], publishedAt: null });
    // An unverified combination never upgrades a version to supported.
    expect(listing.versions.find((entry) => entry.version === '0.1.5-rc.4')?.supported).toBe(false);
    expect(() => dshVersionListingSchema(listing, 'value', [])).not.toThrow();
    expect(dshVersionListingSchema(listing, 'value', [])).not.toBeUndefined();
  });

  it('refuses a non-allowlisted registry host before any request', async () => {
    let called = 0;
    const fetch: VersionFetchLike = () => {
      called += 1;
      return Promise.resolve(jsonResponse(REGISTRY_BODY));
    };
    const source = createNpmDshVersionSource({ fetch, catalog: CATALOG, registryBase: 'https://evil.example' });
    const outcome = await source.listVersions(new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('SOURCE_ACCESS_DENIED');
    expect(called).toBe(0);
    expect(source.lastRequestUrl()).toBeNull();
  });

  it('classifies registry failures without fabricating retryability', async () => {
    const cases: { readonly status: number; readonly code: string; readonly retryAfter?: string }[] = [
      { status: 429, code: 'RATE_LIMITED', retryAfter: '60' },
      { status: 403, code: 'SOURCE_ACCESS_DENIED' },
      { status: 404, code: 'SOURCE_NOT_FOUND' },
      { status: 500, code: 'DOWNLOAD_FAILED' },
    ];
    for (const entry of cases) {
      const fetch: VersionFetchLike = () =>
        Promise.resolve(
          new Response('nope', {
            status: entry.status,
            headers: entry.retryAfter === undefined ? {} : { 'retry-after': entry.retryAfter },
          }),
        );
      const source = createNpmDshVersionSource({ fetch, catalog: CATALOG });
      const outcome = await source.listVersions(new AbortController().signal);
      expect(outcome.ok, `status ${String(entry.status)}`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe(entry.code);
      if (entry.retryAfter !== undefined) {
        expect(outcome.retryAfterSeconds).toBe(60);
      } else {
        expect(outcome.retryAfterSeconds).toBeUndefined();
      }
    }
  });

  it('maps connection failure, non-JSON and malformed bodies to controlled codes', async () => {
    const unreachable: VersionFetchLike = () => Promise.reject(new Error('ENOTFOUND registry.npmjs.org'));
    expect((await createNpmDshVersionSource({ fetch: unreachable, catalog: CATALOG }).listVersions(new AbortController().signal))).toMatchObject({ ok: false, code: 'NETWORK_UNAVAILABLE' });

    const nonJson: VersionFetchLike = () => Promise.resolve(new Response('not json', { status: 200 }));
    expect((await createNpmDshVersionSource({ fetch: nonJson, catalog: CATALOG }).listVersions(new AbortController().signal))).toMatchObject({ ok: false, code: 'DOWNLOAD_FAILED' });

    const malformed: VersionFetchLike = () => Promise.resolve(jsonResponse({ 'dist-tags': { latest: '0.1.5-rc.2' } }));
    expect((await createNpmDshVersionSource({ fetch: malformed, catalog: CATALOG }).listVersions(new AbortController().signal))).toMatchObject({ ok: false, code: 'DOWNLOAD_FAILED' });
  });

  it('treats a caller abort and a deadline as NETWORK_UNAVAILABLE', async () => {
    // A signal that is already aborted refuses before any request.
    const preAborted = new AbortController();
    preAborted.abort();
    let called = 0;
    const never: VersionFetchLike = () => {
      called += 1;
      return new Promise(() => undefined);
    };
    const source = createNpmDshVersionSource({ fetch: never, catalog: CATALOG, timeoutMs: 5 });
    expect(await source.listVersions(preAborted.signal)).toMatchObject({
      ok: false,
      code: 'NETWORK_UNAVAILABLE',
    });
    expect(called).toBe(0);

    // A stall is cut off by the deadline (the stub honors the fetch signal).
    const stalled: VersionFetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const deadline = createNpmDshVersionSource({ fetch: stalled, catalog: CATALOG, timeoutMs: 5 });
    expect(await deadline.listVersions(new AbortController().signal)).toMatchObject({
      ok: false,
      code: 'NETWORK_UNAVAILABLE',
    });
  });

  it('exposes the audited versions from the catalog', () => {
    expect(auditedDshVersions(CATALOG)).toEqual(['0.1.5-rc.2']);
  });
});

describe('real audited catalog coverage (A2 Tier 2 / #131)', () => {
  it('marks exactly the two audited DSH releases supported, regardless of dist-tags', async () => {
    // Source facts: `latest` still points at the baseline line while `next`/`alpha`
    // point at unaudited versions. Support must come from the combination table.
    const body = {
      'dist-tags': { latest: '0.1.5-rc.3', next: '0.1.7-rc.1', alpha: '0.1.7-alpha.2' },
      versions: {
        '0.1.5-rc.2': { name: '@deepseek-ai/dsh' },
        '0.1.5-rc.3': { name: '@deepseek-ai/dsh' },
        '0.1.7-alpha.2': { name: '@deepseek-ai/dsh' },
        '0.1.7-rc.1': { name: '@deepseek-ai/dsh' },
      },
      time: {},
    };
    const fetch: VersionFetchLike = () => Promise.resolve(jsonResponse(body));
    const source = createNpmDshVersionSource({ fetch, catalog: VERIFIED_COMBINATIONS, now: CLOCK });
    const outcome = await source.listVersions(new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byVersion = new Map(outcome.value.versions.map((entry) => [entry.version, entry]));

    const baseline = byVersion.get('0.1.5-rc.2');
    expect(baseline?.supported).toBe(true);
    expect(baseline?.catalogCombinationIds).toEqual([
      'darwin-arm64-node22_19_0-dsh0_1_5-rc_2',
      'darwin-arm64-node24_21_0-dsh0_1_5-rc_2',
    ]);

    const tier2 = byVersion.get('0.1.7-rc.1');
    expect(tier2?.supported).toBe(true);
    expect(tier2?.catalogCombinationIds).toEqual([
      'darwin-arm64-node22_19_0-dsh0_1_7-rc_1',
      'darwin-arm64-node24_21_0-dsh0_1_7-rc_1',
    ]);

    // Dist-tags and unaudited versions must not fabricate support.
    expect(byVersion.get('0.1.5-rc.3')?.supported).toBe(false);
    expect(byVersion.get('0.1.7-alpha.2')?.supported).toBe(false);
    expect(auditedDshVersions(VERIFIED_COMBINATIONS)).toEqual(['0.1.5-rc.2', '0.1.7-rc.1']);
  });
});
