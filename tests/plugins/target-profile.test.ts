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
  createResolvingPreviewPort,
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

const executor = (calls: { args: readonly string[]; cwd: string; nodeExecutable: string }[], markerDir: string): PluginExecutorPort => ({
  identity: async () => ({ ok: true, value: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) } }),
  run: async (request) => {
    calls.push({ args: request.args, cwd: request.cwd, nodeExecutable: request.nodeExecutable });
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
  // Stand-in for the managed Node of the current generation; the resolution child
  // must receive THIS path, never `process.execPath`.
  const nodeExecutable = join(root, 'generation', 'node', 'bin', 'node');
  mkdirSync(join(root, 'generation', 'node', 'bin'), { recursive: true });
  writeFileSync(nodeExecutable, '#!/bin/sh\n');
  return { root, declaration, staging, nodeExecutable };
};

describe('resolveTargetProfileLock', () => {
  it('resolves the target lock in isolation, preserving declarations and adding only the exact SHA', async () => {
    const { declaration, staging, nodeExecutable } = build();
    const calls: { args: readonly string[]; cwd: string; nodeExecutable: string }[] = [];
    const outcome = await resolveTargetProfileLock(
      gitProvider(),
      executor(calls, join(declaration, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'dsh-plugin-demo' }, commitSha: COMMIT, declarationDirectory: declaration, stagingDirectory: staging, nodeExecutable },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    // Default deny and resolution-only; no allowBuilds and no host config.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['install', '--lockfile-only', '--ignore-scripts']);
    // Regression (QA33 real desktop hang): the resolution child runs under the
    // managed Node, never `process.execPath` (Electron-as-node never exits).
    expect(calls[0]?.nodeExecutable).toBe(nodeExecutable);
    expect(calls[0]?.nodeExecutable).not.toBe(process.execPath);
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

  it('adds a non-bundle source as a plain dependency and never guesses it into dsh.profile.bundles', async () => {
    const { declaration, staging, nodeExecutable } = build();
    const calls: { args: readonly string[]; cwd: string; nodeExecutable: string }[] = [];
    const plainManifest = JSON.stringify({ name: 'plain-dep', version: '1.0.0', dependencies: {} });
    const outcome = await resolveTargetProfileLock(
      { resolveManifest: async () => ({ ok: true, value: { commitSha: COMMIT, manifestText: plainManifest, lockText: null } }) },
      executor(calls, join(declaration, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'plain-demo' }, commitSha: COMMIT, declarationDirectory: declaration, stagingDirectory: staging, nodeExecutable },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const target = JSON.parse(outcome.value.targetDeclarationText) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    expect(target.dependencies['plain-dep']).toBe(`github:octo/plain-demo#${COMMIT}`);
    expect(target.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base']);
    expect(target.dsh.profile.bundles).not.toContain('plain-dep');
  });

  it('fails closed when the source commit changed during resolution', async () => {
    const { declaration, staging, nodeExecutable } = build();
    const calls: { args: readonly string[]; cwd: string; nodeExecutable: string }[] = [];
    const outcome = await resolveTargetProfileLock(
      { resolveManifest: async () => ({ ok: true, value: { commitSha: 'b'.repeat(40), manifestText: PLUGIN_MANIFEST, lockText: null } }) },
      executor(calls, join(declaration, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'dsh-plugin-demo' }, commitSha: COMMIT, declarationDirectory: declaration, stagingDirectory: staging, nodeExecutable },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('PLAN_STALE');
    }
    expect(calls).toHaveLength(0);
  });

  it('fails closed without spawning when the managed Node executable is missing', async () => {
    const { declaration, staging } = build();
    const calls: { args: readonly string[]; cwd: string; nodeExecutable: string }[] = [];
    const outcome = await resolveTargetProfileLock(
      gitProvider(),
      executor(calls, join(declaration, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'dsh-plugin-demo' }, commitSha: COMMIT, declarationDirectory: declaration, stagingDirectory: staging, nodeExecutable: join(staging, 'absent', 'node') },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
    }
    // Fail closed BEFORE any child process is spawned (no hang, no Electron-as-node).
    expect(calls).toHaveLength(0);
  });

  it('refuses the host process binary as the resolution runtime (Electron-as-node never exits)', async () => {
    const { declaration, staging } = build();
    const calls: { args: readonly string[]; cwd: string; nodeExecutable: string }[] = [];
    const outcome = await resolveTargetProfileLock(
      gitProvider(),
      executor(calls, join(declaration, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'dsh-plugin-demo' }, commitSha: COMMIT, declarationDirectory: declaration, stagingDirectory: staging, nodeExecutable: process.execPath },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
    }
    // Refused BEFORE spawning: no host-binary child, no hang.
    expect(calls).toHaveLength(0);
  });

  it('threads the context managed Node through the resolving preview port (Electron-safe)', async () => {
    const { declaration, staging, nodeExecutable } = build();
    const calls: { args: readonly string[]; cwd: string; nodeExecutable: string }[] = [];
    const port = createResolvingPreviewPort({
      gitProvider: gitProvider(),
      executor: executor(calls, join(declaration, 'hdsl-e2e-marker')),
      executorIdentity: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) },
    });
    const outcome = await port.previewSource(
      { owner: 'octo', name: 'dsh-plugin-demo' },
      new AbortController().signal,
      { declarationDirectory: declaration, stagingDirectory: staging, nodeExecutable },
    );
    expect(outcome.ok).toBe(true);
    // The production preview wiring must hand the managed Node to the executor.
    expect(calls[0]?.nodeExecutable).toBe(nodeExecutable);
    expect(calls[0]?.nodeExecutable).not.toBe(process.execPath);
  });

  it('fails closed when the current declaration source is missing', async () => {
    const { root, staging, nodeExecutable } = build();
    const calls: { args: readonly string[]; cwd: string; nodeExecutable: string }[] = [];
    const outcome = await resolveTargetProfileLock(
      gitProvider(),
      executor(calls, join(root, 'hdsl-e2e-marker')),
      { source: { owner: 'octo', name: 'dsh-plugin-demo' }, commitSha: COMMIT, declarationDirectory: join(root, 'missing'), stagingDirectory: staging, nodeExecutable },
      new AbortController().signal,
    );
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
