/**
 * S3 removal resolution (#77, ADR 0005 D15): remove / retention / blocked.
 * The in-box set is resolved from the managed install tree only (F12a); the
 * negative control uses a REAL rc.2 in-box bundle name, never a same-name
 * profile stand-in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveInBoxBundles, resolvePluginRemoval, type PluginRemovalInput } from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Real rc.2 in-box bundle names, read from a managed install (F12a). */
const REAL_IN_BOX = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const;

const managedInstall = (bundleNames: readonly string[], extra: readonly string[] = []): string => {
  const dsh = mkdtempSync(join(tmpdir(), 'hdsl-inbox-'));
  roots.push(dsh);
  const scope = join(dsh, 'node_modules', '@deepseek-ai');
  for (const name of [...bundleNames, ...extra]) {
    const short = name.replace('@deepseek-ai/', '');
    mkdirSync(join(scope, short), { recursive: true });
    const manifest: Record<string, unknown> = { name, version: '0.1.5-rc.2' };
    if (bundleNames.includes(name)) {
      manifest['dsh'] = { bundle: { patch: './cordis.patch.yml' } };
    } else {
      manifest['dsh'] = { client: { platform: 'web' } };
    }
    writeFileSync(join(scope, short, 'package.json'), JSON.stringify(manifest));
  }
  return dsh;
};

const declaration = (pluginId: string, dependencies: Record<string, string>, bundles: string[]): string =>
  `${JSON.stringify({ name: 'dsh-profile-web', dependencies: { [pluginId]: 'github:octo/demo#abc', ...dependencies }, dsh: { profile: { bundles: [...bundles, pluginId] } } }, null, 2)}\n`;

const input = (overrides: Partial<PluginRemovalInput> = {}): PluginRemovalInput => ({
  pluginId: 'demo-plugin',
  declarationText: declaration('demo-plugin', { 'shared-dep': '1.0.0' }, ['@deepseek-ai/dsh-base']),
  workspaceText: 'onlyBuiltDependencies: []\n',
  installed: [{ id: 'demo-plugin', version: '1.0.0' }, { id: 'shared-dep', version: '1.0.0' }, { id: '@deepseek-ai/dsh-base', version: '0.1.5-rc.2' }],
  inBoxBundles: [{ name: '@deepseek-ai/dsh-base', version: '0.1.5-rc.2' }],
  referenceSources: [],
  ...overrides,
});

describe('resolveInBoxBundles (F12a: current managed install only)', () => {
  it('selects only packages declaring dsh.bundle.patch and fails closed without a scope', () => {
    const dsh = managedInstall(REAL_IN_BOX, ['@deepseek-ai/dsh-atomic-write']);
    const bundles = resolveInBoxBundles(dsh);
    expect(bundles?.map((bundle) => bundle.name).sort()).toEqual([...REAL_IN_BOX].sort());
    expect(bundles?.every((bundle) => bundle.version === '0.1.5-rc.2')).toBe(true);

    const missing = mkdtempSync(join(tmpdir(), 'hdsl-inbox-missing-'));
    roots.push(missing);
    expect(resolveInBoxBundles(missing)).toBeUndefined();
    const empty = mkdtempSync(join(tmpdir(), 'hdsl-inbox-empty-'));
    roots.push(empty);
    mkdirSync(join(empty, 'node_modules', '@deepseek-ai'), { recursive: true });
    expect(resolveInBoxBundles(empty)).toBeUndefined();
  });
});

describe('resolvePluginRemoval', () => {
  it('remove branch: lists removals, prunes the declaration, and lists retention', () => {
    const outcome = resolvePluginRemoval(input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences).toEqual([]);
    expect(outcome.value.removals).toEqual([
      'dependency entry demo-plugin@github:octo/demo#abc',
      'enabled bundle reference demo-plugin',
    ]);
    const pruned = JSON.parse(outcome.value.prunedDeclarationText) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    expect(Object.hasOwn(pruned.dependencies, 'demo-plugin')).toBe(false);
    expect(pruned.dependencies['shared-dep']).toBe('1.0.0');
    expect(pruned.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base']);
    expect(outcome.value.retention).toContain('user patch layer (home cordis.patch.yml)');
    expect(outcome.value.retention).toContain('dependency entry shared-dep');
    expect(outcome.value.retention.some((entry) => entry.includes('shared/transitive'))).toBe(true);
  });

  it('blocks a REAL in-box bundle name resolved from the install tree', () => {
    const outcome = resolvePluginRemoval(input({
      pluginId: '@deepseek-ai/dsh-base',
      declarationText: declaration('@deepseek-ai/dsh-base', {}, []),
      installed: [{ id: '@deepseek-ai/dsh-base', version: '0.1.5-rc.2' }],
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences[0]?.kind).toBe('bundle');
    expect(outcome.value.blockingReferences[0]?.detail).toContain('in-box bundle');
  });

  it('does NOT treat a same-name profile dependency as in-box when the install tree lacks it', () => {
    // Negative control against a "profile stand-in" fake green: the name matches a
    // real in-box bundle, but the CURRENT install resolves no in-box set.
    const outcome = resolvePluginRemoval(input({
      pluginId: '@deepseek-ai/dsh-base',
      declarationText: declaration('@deepseek-ai/dsh-base', {}, []),
      installed: [{ id: '@deepseek-ai/dsh-base', version: '0.1.5-rc.2' }],
      inBoxBundles: [],
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences).toEqual([]);
  });

  it('blocks a user patch / other bundle / config reference with its source', () => {
    const outcome = resolvePluginRemoval(input({
      referenceSources: [
        { kind: 'userPatch', detail: 'home/cordis.patch.yml', references: ['demo-plugin'], unresolved: false },
        { kind: 'bundle', detail: '@deepseek-ai/dsh-web-app', references: ['demo-plugin'], unresolved: false },
        { kind: 'config', detail: 'profile patch', references: ['demo-plugin'], unresolved: false },
      ],
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences.map((reference) => reference.kind).sort()).toEqual(['bundle', 'config', 'userPatch']);
    expect(outcome.value.blockingReferences.every((reference) => reference.pluginId === 'demo-plugin')).toBe(true);
  });

  it('keeps blocking-reference details bounded and path-free', () => {
    const outcome = resolvePluginRemoval(input({
      referenceSources: [
        { kind: 'userPatch', detail: '/Users/operator/env/home/cordis.patch.yml', references: ['demo-plugin'], unresolved: false },
        { kind: 'bundle', detail: '@deepseek-ai/dsh-web-app', references: ['demo-plugin'], unresolved: false },
      ],
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences[0]?.detail).toBe('unresolvable userPatch reference source');
    expect(outcome.value.blockingReferences[1]?.detail).toBe('@deepseek-ai/dsh-web-app');
    for (const reference of outcome.value.blockingReferences) {
      // Safe identifiers may be scoped/relative; LOCAL ABSOLUTE paths may not.
      expect(reference.detail.startsWith('/')).toBe(false);
      expect(reference.detail.length).toBeLessThanOrEqual(256);
    }
  });

  it('blocks conservatively when a reference source could not be resolved', () => {
    const outcome = resolvePluginRemoval(input({
      referenceSources: [{ kind: 'userPatch', detail: 'home/cordis.patch.yml', references: [], unresolved: true }],
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences[0]?.kind).toBe('userPatch');
    expect(outcome.value.blockingReferences[0]?.detail).toContain('cannot be resolved');
  });

  it('blocks another layer that re-inserts the same row id as the removed plugin', () => {
    const outcome = resolvePluginRemoval(input({
      removedRowIds: ['timer', 'web-startup'],
      referenceSources: [
        { kind: 'bundle', detail: 'bundle @deepseek-ai/dsh-web-app', references: [], rowIds: ['web-startup'], rowTargets: [], unresolved: false },
      ],
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences[0]?.detail).toContain('inserts the same row id as this plugin');
    expect(outcome.value.blockingReferences[0]?.detail).not.toContain('/Users');
  });

  it('warns (never blocks) about patch-injected service overlap and never treats services as packages', () => {
    const outcome = resolvePluginRemoval(input({
      removedServiceNames: ['webStartup', 'sharedService'],
      referenceSources: [
        { kind: 'bundle', detail: 'bundle @deepseek-ai/dsh-web-app', references: [], services: ['webStartup'], unresolved: false },
      ],
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences).toEqual([]);
    expect(outcome.value.riskItems.some((item) => item.includes('webStartup'))).toBe(true);
    expect(outcome.value.riskItems.some((item) => item.includes('sharedService'))).toBe(false);
  });

  it('matches the plugin id as a whole token only', () => {
    const outcome = resolvePluginRemoval(input({
      referenceSources: [{ kind: 'bundle', detail: 'other patch', references: ['demo-plugin-extended'], unresolved: false }],
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockingReferences).toEqual([]);
  });

  it('fails closed when the target is not installed or not a direct entry', () => {
    const absent = resolvePluginRemoval(input({ installed: [] }));
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.code).toBe('NOT_FOUND');

    const indirect = resolvePluginRemoval(input({ pluginId: 'transitive-dep' }));
    expect(indirect.ok).toBe(false);
    if (!indirect.ok) expect(indirect.code).toBe('NOT_FOUND');
  });
});
