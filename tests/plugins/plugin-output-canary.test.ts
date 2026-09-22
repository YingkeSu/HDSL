/**
 * AC11: plugin resolution output, error messages and install arguments must not
 * carry secrets or absolute local paths. Synthetic canaries only; no real
 * credential is used.
 */
import { describe, expect, it } from 'vitest';
import { createGitHubPluginSource, type PluginFetchLike } from '@hdsl/runtime';

const SECRET = 'CANARY-super-secret-token-1234567890';
const ABS_PATH = '/Users/operator/private/workspace';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const contents = (text: string): Response =>
  json({ content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' });

const routed = (manifest: Response): PluginFetchLike => async (input) => {
  if (input.includes('/commits')) {
    return json({ sha: 'a'.repeat(40) });
  }
  if (input.includes('/contents/package.json')) {
    return manifest;
  }
  return json({}, 404);
};

describe('plugin resolution output canaries (AC11)', () => {
  it('never surfaces a canary secret or absolute path from a manifest into the resolution', async () => {
    const adapter = createGitHubPluginSource({
      fetch: routed(
        contents(
          JSON.stringify({
            name: 'dsh-plugin-demo',
            version: '1.0.0',
            description: `token=${SECRET} at ${ABS_PATH}`,
            homepage: `https://example.invalid/${SECRET}`,
            repository: { url: ABS_PATH },
            dsh: { bundle: { patch: 'cordis.patch.yml' } },
          }),
        ),
      ),
    });
    const outcome = await adapter.previewSource(
      { owner: 'octo', name: 'dsh-plugin-demo' },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const serialized = JSON.stringify(outcome.value);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(ABS_PATH);
  });

  it('uses controlled error messages that never echo a canary from the transport', async () => {
    const adapter = createGitHubPluginSource({
      fetch: async () => {
        throw new Error(`connect failed to ${ABS_PATH} token=${SECRET}`);
      },
    });
    const outcome = await adapter.previewSource(
      { owner: 'octo', name: 'dsh-plugin-demo' },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('NETWORK_UNAVAILABLE');
      expect(outcome.message).not.toContain(SECRET);
      expect(outcome.message).not.toContain(ABS_PATH);
    }
  });
});
