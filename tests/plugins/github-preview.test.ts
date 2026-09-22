/**
 * GitHub preview adapter: exact commit SHA, manifest, optional pinned lockfile,
 * install-time script assessment. Offline (fake fetch); no plugin code is
 * downloaded or executed.
 */
import { describe, expect, it } from 'vitest';
import { createGitHubPluginSource, type PluginFetchLike } from '@hdsl/runtime';

const SHA = 'a'.repeat(40);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const contents = (text: string): Response =>
  jsonResponse({ content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' });

interface Route {
  readonly commits?: Response;
  readonly manifest?: Response;
  readonly lock?: Response | 'missing';
}

const routedFetch = (route: Route): PluginFetchLike => async (input) => {
  if (input.includes('/commits')) {
    return route.commits ?? jsonResponse({ sha: SHA });
  }
  if (input.includes('/contents/package.json')) {
    return route.manifest ?? jsonResponse({}, 404);
  }
  if (input.includes('/contents/pnpm-lock.yaml')) {
    return route.lock === 'missing' || route.lock === undefined ? jsonResponse({}, 404) : route.lock;
  }
  return jsonResponse({}, 404);
};

const source = { owner: 'octo', name: 'dsh-plugin-demo' } as const;

describe('GitHub preview adapter', () => {
  it('resolves a 40-hex commit and reports none-detected for a plugin with no dependencies', async () => {
    const adapter = createGitHubPluginSource({
      fetch: routedFetch({
        manifest: contents(JSON.stringify({ name: 'dsh-plugin-demo', version: '1.2.3', dsh: { bundle: { patch: 'cordis.patch.yml' } } })),
      }),
    });
    const outcome = await adapter.previewSource(source, new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.sourceLock.commitSha).toBe(SHA);
    expect(outcome.value.sourceLock.commitSha).toHaveLength(40);
    expect(outcome.value.sourceLock.closureLockSha256).toBeNull();
    expect(outcome.value.scriptAssessment).toBe('none-detected');
    expect(outcome.value.requiresBuildAuthorization).toBe(false);
    expect(outcome.value.scripts).toHaveLength(0);
    expect(outcome.value.planInputsDigest).toHaveLength(64);
  });

  it('reports detected with the exact install-time scripts', async () => {
    const adapter = createGitHubPluginSource({
      fetch: routedFetch({
        manifest: contents(
          JSON.stringify({
            name: 'dsh-plugin-demo',
            version: '1.2.3',
            dsh: { bundle: { patch: 'cordis.patch.yml' } },
            scripts: { prepare: 'tsc', postinstall: 'node setup.js', test: 'vitest' },
          }),
        ),
      }),
    });
    const outcome = await adapter.previewSource(source, new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.scriptAssessment).toBe('detected');
    expect(outcome.value.requiresBuildAuthorization).toBe(true);
    expect(outcome.value.scripts.map((entry) => entry.script).sort()).toEqual(['postinstall', 'prepare']);
    expect(outcome.value.scripts.every((entry) => entry.source === 'root')).toBe(true);
  });

  it('reports unknown for a dependency closure that was not enumerated', async () => {
    const adapter = createGitHubPluginSource({
      fetch: routedFetch({
        manifest: contents(
          JSON.stringify({
            name: 'dsh-plugin-demo',
            version: '1.2.3',
            dsh: { bundle: { patch: 'cordis.patch.yml' } },
            dependencies: { leftpad: '1.0.0' },
          }),
        ),
        lock: contents('lockfileVersion: 9.0\n'),
      }),
    });
    const outcome = await adapter.previewSource(source, new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.scriptAssessment).toBe('unknown');
    expect(outcome.value.requiresBuildAuthorization).toBe(true);
    expect(outcome.value.sourceLock.closureLockSha256).toHaveLength(64);
  });

  it('fails closed for a non-plugin, a missing manifest and a non-40 sha', async () => {
    const notAPlugin = createGitHubPluginSource({
      fetch: routedFetch({ manifest: contents(JSON.stringify({ name: 'lib', version: '1.0.0' })) }),
    });
    const nonPlugin = await notAPlugin.previewSource(source, new AbortController().signal);
    expect(nonPlugin.ok).toBe(false);
    if (!nonPlugin.ok) {
      expect(nonPlugin.code).toBe('NOT_A_PLUGIN');
    }

    const missing = createGitHubPluginSource({ fetch: routedFetch({}) });
    const noManifest = await missing.previewSource(source, new AbortController().signal);
    expect(noManifest.ok).toBe(false);
    if (!noManifest.ok) {
      expect(noManifest.code).toBe('SOURCE_MANIFEST_INVALID');
    }

    const badSha = createGitHubPluginSource({ fetch: routedFetch({ commits: jsonResponse({ sha: 'abc' }) }) });
    const sha = await badSha.previewSource(source, new AbortController().signal);
    expect(sha.ok).toBe(false);
    if (!sha.ok) {
      expect(sha.code).toBe('SOURCE_NOT_FOUND');
    }
  });

  it('maps rate limiting and an abort to controlled outcomes', async () => {
    const rateLimited = createGitHubPluginSource({
      fetch: async () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '30' } }),
    });
    const limited = await rateLimited.previewSource(source, new AbortController().signal);
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.code).toBe('RATE_LIMITED');
      expect(limited.retryAfterSeconds).toBe(30);
    }

    const controller = new AbortController();
    const aborted = createGitHubPluginSource({
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    setTimeout(() => {
      controller.abort();
    }, 5);
    const outcome = await aborted.previewSource(source, controller.signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('NETWORK_UNAVAILABLE');
    }
  });
});
