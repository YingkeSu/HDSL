/**
 * Target-profile resolution: the plan's closure digest is the EXPECTED TARGET
 * PROFILE lock, resolved in isolation with the default deny, from the current
 * generation's immutable declaration source.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveTargetProfileLock,
  stagingIsClean,
  type GitProvider,
  type PluginExecutorPort,
} from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const COMMIT = 'a'.repeat(40);
const PLUGIN_MANIFEST = JSON.stringify({ name: 'hdsl-plugin-e2e-fixture', version: '0.0.1', dsh: { bundle: { patch: './cordis.patch.yml' } } });

const gitProvider = (): GitProvider => ({
  resolveManifest: async () => ({ ok: true, value: { commitSha: COMMIT, manifestText: PLUGIN_MANIFEST, lockText: null } }),
});

const executor = (calls: { args: readonly string[]; cwd: string }[], markerDir: string): PluginExecutorPort => ({
  identity: async () => ({ ok: true, value: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) } }),
  run: async (request) => {
    calls.push({ args: request.args, cwd: request.cwd });
    // Simulate resolution writing a target lock; never a lifecycle marker.
    writeFileSync(join(request.cwd, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      hdsl-plugin-e2e-fixture:\n        specifier: github:octo/dsh-plugin-demo#${COMMIT}\n        version: github.com/octo/dsh-plugin-demo/${COMMIT}\n`);
    void markerDir;
    return { ok: true, value: { executor: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) }, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
  },
});

const build = () => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-target-profile-'));
  roots.push(root);
  const declaration = join(root, 'declaration');
  mkdirSync(declaration, { recursive: true });
  writeFileSync(
    join(declaration, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-web', dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
  );
  writeFileSync(join(declaration, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies: []\n');
  const staging = join(root, 'staging');
  return { root, declaration, staging };
};

describe('resolveTargetProfileLock', () => {
  it('resolves the target lock in isolation, preserving declarations and adding only the exact SHA', async () => {
    const { declaration, staging } = build();
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const outcome = await resolveTargetProfileLock(
      gitProvider(),
      executor(calls, join(declaration, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'dsh-plugin-demo' }, commitSha: COMMIT, declarationDirectory: declaration, stagingDirectory: staging },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    // Default deny and resolution-only; no allowBuilds and no host config.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['install', '--lockfile-only', '--ignore-scripts']);
    // The target declaration preserves bundles and adds the exact git SHA.
    const target = JSON.parse(outcome.value.targetDeclarationText) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    expect(target.dependencies['hdsl-plugin-e2e-fixture']).toBe(`github:octo/dsh-plugin-demo#${COMMIT}`);
    expect(target.dsh.profile.bundles).toContain('@deepseek-ai/dsh-base');
    expect(target.dsh.profile.bundles).toContain('hdsl-plugin-e2e-fixture');
    expect(outcome.value.targetLockSha256).toHaveLength(64);
    expect(outcome.value.targetLockText).toContain(COMMIT);
    expect(outcome.value.targetDeclarationSha256).toHaveLength(64);
    // No environment-home writes and the isolated staging is cleaned up.
    expect(existsSync(join(declaration, 'hdsl-e2e-marker'))).toBe(false);
    expect(stagingIsClean(staging)).toBe(true);
  });

  it('fails closed when the source commit changed during resolution', async () => {
    const { declaration, staging } = build();
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const outcome = await resolveTargetProfileLock(
      { resolveManifest: async () => ({ ok: true, value: { commitSha: 'b'.repeat(40), manifestText: PLUGIN_MANIFEST, lockText: null } }) },
      executor(calls, join(declaration, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'dsh-plugin-demo' }, commitSha: COMMIT, declarationDirectory: declaration, stagingDirectory: staging },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('PLAN_STALE');
    }
    expect(calls).toHaveLength(0);
  });

  it('fails closed when the current declaration source is missing', async () => {
    const { root, staging } = build();
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const outcome = await resolveTargetProfileLock(
      gitProvider(),
      executor(calls, join(root, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'dsh-plugin-demo' }, commitSha: COMMIT, declarationDirectory: join(root, 'missing'), stagingDirectory: staging },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
