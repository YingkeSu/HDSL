/**
 * #77 S3: production removal port — in-box identity, published-profile identity
 * check, user-patch read-only scanning, and the isolated pruned-lock recompute
 * under the managed executor.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginRemovalPort, type PluginExecutorPort } from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const RUNTIME = {
  dshVersion: '0.1.5-rc.2',
  dshSha256: 'f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480',
  loaderVersion: '1.0.3',
  cordisVersion: '4.0.2',
};

const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value));

const executor = (calls: { nodeExecutable: string; args: readonly string[] }[]): PluginExecutorPort => ({
  identity: async () => ({ ok: true, value: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) } }),
  run: async (request) => {
    calls.push({ nodeExecutable: request.nodeExecutable, args: request.args });
    writeFileSync(join(request.cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');
    return { ok: true, value: { executor: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) }, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
  },
});

const build = (options: { publishedDrift?: boolean; userPatch?: string | null; pluginId?: string } = {}) => {
  const pluginId = options.pluginId ?? 'demo-plugin';
  const root = mkdtempSync(join(tmpdir(), 'hdsl-removal-port-'));
  roots.push(root);
  const declaration = join(root, 'profile');
  const published = join(root, 'home', 'profiles', 'hdsl-gen-1');
  const home = join(root, 'home');
  const dsh = join(root, 'dsh');
  const staging = join(root, 'staging');
  for (const dir of [declaration, join(published, 'node_modules', '@deepseek-ai/dsh-web-app'), join(published, 'node_modules', pluginId), join(dsh, 'node_modules', '@deepseek-ai'), home]) {
    mkdirSync(dir, { recursive: true });
  }
  const declarationText = JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { [pluginId]: 'github:octo/demo#abc' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pluginId] } },
  });
  writeFileSync(join(declaration, 'package.json'), declarationText);
  writeFileSync(join(declaration, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(published, 'package.json'), options.publishedDrift === true ? `${declarationText} ` : declarationText);
  // In-box bundle patch: inserts an unrelated plugin (must not block demo-plugin) and injects a service.
  writeFileSync(join(published, 'node_modules', '@deepseek-ai/dsh-web-app', 'cordis.patch.yml'), '- insert:\n    - id: other\n      name: other-plugin\n- id: system-prompt\n  config:\n    inject: [webStartup]\n');
  // The removed plugin's own patch row ids.
  writeFileSync(join(published, 'node_modules', pluginId, 'cordis.patch.yml'), `- insert:\n    - id: demo-row\n      name: ${pluginId}\n`);
  if (options.userPatch !== null) {
    writeFileSync(join(home, 'cordis.patch.yml'), options.userPatch ?? '- id: untouched\n  config:\n    note: demo-plugin\n');
  }
  // Managed install: real in-box bundle + cordis/loader identities.
  for (const name of ['dsh-base', 'dsh-web-app']) {
    mkdirSync(join(dsh, 'node_modules', '@deepseek-ai', name), { recursive: true });
    writeJson(join(dsh, 'node_modules', '@deepseek-ai', name, 'package.json'), { name: `@deepseek-ai/${name}`, version: '0.1.5-rc.2', dsh: { bundle: { patch: './cordis.patch.yml' } } });
  }
  mkdirSync(join(dsh, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true });
  mkdirSync(join(dsh, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'), { recursive: true });
  writeJson(join(dsh, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'), { name: '@deepseek-ai/cordis', version: '4.0.2' });
  writeJson(join(dsh, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader', 'package.json'), { name: '@deepseek-ai/cordis-plugin-loader', version: '1.0.3' });
  return { root, declaration, published, home, dsh, staging };
};

describe('createPluginRemovalPort', () => {
  it('lists installed plugins with in-box/enabled flags and fails closed without an install scope', async () => {
    const fixture = build();
    const port = createPluginRemovalPort({ executor: executor([]) });
    const outcome = await port.listInstalled(
      {
        installed: [{ id: 'demo-plugin', version: '1.0.0', sha256: 'a'.repeat(64) }, { id: '@deepseek-ai/dsh-base', version: '0.1.5-rc.2', sha256: 'b'.repeat(64) }],
        enabledBundles: ['@deepseek-ai/dsh-base', 'demo-plugin'],
        dshDirectory: fixture.dsh,
        sources: { 'demo-plugin': { owner: 'octo', name: 'demo', commitSha: 'abc' } },
      },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]).toMatchObject({ id: 'demo-plugin', isBuiltin: false, enabledBundle: true, source: { owner: 'octo', name: 'demo' } });
    expect(outcome.value[1]).toMatchObject({ id: '@deepseek-ai/dsh-base', isBuiltin: true, enabledBundle: true });

    const missing = await port.listInstalled(
      { installed: [], enabledBundles: [], dshDirectory: join(fixture.root, 'nope') },
      new AbortController().signal,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('INTERNAL_ERROR');
  });

  it('recomputes the pruned lock under the managed Node and keeps the user patch untouched', async () => {
    const fixture = build({ pluginId: 'hdsl-plugin-e2e-fixture' });
    const calls: { nodeExecutable: string; args: readonly string[] }[] = [];
    const port = createPluginRemovalPort({ executor: executor(calls) });
    const userPatchBefore = readFileSync(join(fixture.home, 'cordis.patch.yml'), 'utf8');
    const outcome = await port.resolveRemoval(
      {
        pluginId: 'hdsl-plugin-e2e-fixture',
        expectedCommitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838',
        expectedManifestSha256: 'ee613a2eb425a24bc44e946d84e36b7ceb2f594f1214913ff34dd0d0e450ba5c',
        declarationDirectory: fixture.declaration,
        publishedProfileDirectory: fixture.published,
        homeDirectory: fixture.home,
        dshDirectory: fixture.dsh,
        nodeExecutable: join(fixture.root, 'generation', 'node', 'bin', 'node'),
        stagingDirectory: fixture.staging,
        installed: [{ id: 'hdsl-plugin-e2e-fixture', version: '1.0.0', sha256: 'a'.repeat(64) }, { id: 'other-plugin', version: '1.0.0', sha256: 'c'.repeat(64) }],
        enabledBundles: ['@deepseek-ai/dsh-base', 'hdsl-plugin-e2e-fixture'],
        runtime: RUNTIME,
      },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // User patch is read-only.
    expect(readFileSync(join(fixture.home, 'cordis.patch.yml'), 'utf8')).toBe(userPatchBefore);
    // Resolution-only recompute with the managed Node and the default deny.
    expect(calls[0]?.nodeExecutable).toBe(join(fixture.root, 'generation', 'node', 'bin', 'node'));
    expect(calls[0]?.args).toEqual(['install', '--lockfile-only', '--ignore-scripts']);
    expect(outcome.value.targetLockText).toContain('lockfileVersion');
    // The unrelated bundle does not block; the fixture record is known-empty so
    // the service axis passes (no provided-service intersection).
    expect(outcome.value.blockingReferences).toEqual([]);
    expect(outcome.value.serviceVerification.status).toBe('known');
    expect(JSON.parse(outcome.value.targetDeclarationText).dependencies['hdsl-plugin-e2e-fixture']).toBeUndefined();
  });

  it('fails closed when the published profile drifted from the immutable declaration', async () => {
    const fixture = build({ publishedDrift: true });
    const port = createPluginRemovalPort({ executor: executor([]) });
    const outcome = await port.resolveRemoval(
      {
        pluginId: 'demo-plugin',
        expectedCommitSha: null,
        expectedManifestSha256: null,
        declarationDirectory: fixture.declaration,
        publishedProfileDirectory: fixture.published,
        homeDirectory: fixture.home,
        dshDirectory: fixture.dsh,
        nodeExecutable: join(fixture.root, 'node'),
        stagingDirectory: fixture.staging,
        installed: [{ id: 'demo-plugin', version: '1.0.0', sha256: 'a'.repeat(64) }],
        enabledBundles: ['demo-plugin'],
        runtime: RUNTIME,
      },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Drifted live profile => the reference scan is incomplete => unknown block.
    expect(outcome.value.blockingReferences.length).toBeGreaterThanOrEqual(1);
  });
});
