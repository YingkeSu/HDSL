/**
 * #78 S4 apply-boundary authorization: two-phase (default-deny materialisation ->
 * read-only closure enumeration -> exact single-install authorization).
 *
 * Fakes only: no script is executed, no real install runs. The external-marker
 * deny/allow proof is the opt-in probe (see docs/tests boundary notes).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildAuthorization, CompositionLock, ExecutorIdentity, PluginSourceSelector } from '@hdsl/contracts';
import {
  buildPreviewResolution,
  createPluginApplyPort,
  type GitProvider,
  type PluginExecutorPort,
} from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const COMMIT = 'e'.repeat(40);
const SOURCE: PluginSourceSelector = { owner: 'octo', name: 'hdsl-plugin-demo', ref: 'main' };
const EXECUTOR: ExecutorIdentity = {
  id: 'pnpm',
  version: '11.7.0',
  sha256: '1'.repeat(64),
  entrySha256: '2'.repeat(64),
  treeSha256: '3'.repeat(64),
};
const PLUGIN_KEY = `hdsl-plugin-demo@https://codeload.github.com/octo/hdsl-plugin-demo/tar.gz/${COMMIT}`;
const LOCK_TEXT = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      hdsl-plugin-demo:',
  '        specifier: github:octo/hdsl-plugin-demo',
  `        version: ${PLUGIN_KEY.slice(PLUGIN_KEY.indexOf('@') + 1)}`,
  'packages:',
  `  ${PLUGIN_KEY}:`,
  '    version: 1.0.0',
  '  shared-dep@1.2.3:',
  '    version: 1.2.3',
  'snapshots:',
  '  shared-dep@1.2.3: {}',
].join('\n');
const LOCK_SHA = createHash('sha256').update(LOCK_TEXT, 'utf8').digest('hex');
const MANIFEST = JSON.stringify({
  name: 'hdsl-plugin-demo',
  version: '1.0.0',
  dependencies: { 'shared-dep': '1.2.3' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  scripts: { preinstall: 'node p.js', install: 'node i.js', postinstall: 'node po.js', prepare: 'node pr.js' },
});
const CURRENT_LOCK: CompositionLock = {
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [],
  sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } },
};
const TARGET_PROFILE = {
  lockText: LOCK_TEXT,
  declarationText: JSON.stringify({
    name: 'hdsl-profile',
    private: true,
    dependencies: { 'hdsl-plugin-demo': `github:octo/hdsl-plugin-demo#${COMMIT}` },
    dsh: { profile: { bundles: ['hdsl-plugin-demo'] } },
  }),
  workspaceText: null,
};

const harness = () => {
  const runCalls: { args: readonly string[]; allowBuilds?: string }[] = [];
  const provider: GitProvider = {
    resolveManifest: async () => ({ ok: true, value: { commitSha: COMMIT, manifestText: MANIFEST, lockText: null } }),
  };
  const executor: PluginExecutorPort = {
    identity: async () => ({ ok: true, value: EXECUTOR }),
    run: async (request) => {
      const authorized = request.args.includes('--ignore-scripts=false');
      if (!authorized) {
        // Default-deny materialisation: create the installed tree read-only so the
        // closure can be enumerated without executing anything.
        mkdirSync(join(request.cwd, 'node_modules', 'shared-dep'), { recursive: true });
        writeFileSync(
          join(request.cwd, 'node_modules', 'shared-dep', 'package.json'),
          JSON.stringify({ name: 'shared-dep', version: '1.2.3', scripts: { postinstall: 'node dep.js' } }),
        );
        mkdirSync(join(request.cwd, 'node_modules', 'hdsl-plugin-demo'), { recursive: true });
        writeFileSync(
          join(request.cwd, 'node_modules', 'hdsl-plugin-demo', 'package.json'),
          JSON.stringify({ name: 'hdsl-plugin-demo', version: '1.0.0', scripts: JSON.parse(MANIFEST).scripts }),
        );
      }
      const workspacePath = join(request.cwd, 'pnpm-workspace.yaml');
      runCalls.push({
        args: request.args,
        ...(existsSync(workspacePath) ? { allowBuilds: readFileSync(workspacePath, 'utf8') } : {}),
      });
      return { ok: true, value: { executor: EXECUTOR, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
    },
  };
  const built = buildPreviewResolution({ source: SOURCE, resolved: { commitSha: COMMIT, manifestText: MANIFEST, lockText: null }, executor: EXECUTOR });
  if (!built.ok) throw new Error('fixture resolution failed');
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-apply-auth-'));
  roots.push(dataRoot);
  const generationDirectory = join(dataRoot, 'gen');
  const port = createPluginApplyPort({ gitProvider: provider, executor });
  const plan = {
    planId: 'plan-0000000000000001',
    environmentId: 'env-0000000000000001',
    baseRevision: 1,
    action: { kind: 'install' as const, source: SOURCE },
    createdAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-22T01:00:00.000Z',
    sourceLock: { ...built.value.sourceLock, closureLockSha256: LOCK_SHA },
    scriptAssessment: built.value.scriptAssessment,
    scripts: [...built.value.scripts],
    requiresBuildAuthorization: built.value.requiresBuildAuthorization,
    riskItems: [...built.value.riskItems],
    removals: [],
    retention: [],
    blockingReferences: [],
    executor: built.value.executor,
    planInputsDigest: built.value.planInputsDigest,
  };
  const stage = (buildAuthorization: BuildAuthorization | null) =>
    port.stage(
      {
        environmentId: 'env-0000000000000001',
        generationId: 'gen-0000000000000001',
        generationDirectory,
        environmentDirectory: join(generationDirectory, 'env'),
        homeDirectory: join(generationDirectory, 'home'),
        nodeExecutable: '/fixture/node',
        currentLock: CURRENT_LOCK,
        plan,
        targetProfile: TARGET_PROFILE,
        buildAuthorization,
      },
      new AbortController().signal,
    );
  return { stage, runCalls, generationDirectory, resolution: built.value };
};

const authorizationFor = (scripts: readonly { packageName: string; packageVersion: string; script: string; source: 'root' | 'dependency' }[]): BuildAuthorization => ({
  commitSha: COMMIT,
  scripts: scripts.map((script) => ({ ...script })),
});

describe('S4 apply-boundary authorization (two-phase)', () => {
  it('defaults to deny for a plugin with scripts when no authorization is supplied', async () => {
    const h = harness();
    const outcome = await h.stage(null);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('BUILD_NOT_AUTHORIZED');
    expect(h.runCalls).toHaveLength(0);
  });

  it('materialises with default deny, enumerates the closure, then allows exactly the authorized set', async () => {
    const h = harness();
    const rootScripts = h.resolution.scripts;
    const authorization = authorizationFor([
      ...rootScripts,
      { packageName: 'shared-dep', packageVersion: '1.2.3', script: 'postinstall', source: 'dependency' },
    ]);
    const outcome = await h.stage(authorization);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Default-deny pre-install, then the single authorized install.
    expect(h.runCalls.map((call) => call.args)).toEqual([
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      ['install', '--frozen-lockfile', '--ignore-scripts=false'],
    ]);
    const allowBuilds = h.runCalls[1]?.allowBuilds ?? '';
    expect(allowBuilds).toContain(`${PLUGIN_KEY}: true`);
    expect(allowBuilds).toContain('shared-dep@1.2.3: true');
    expect(allowBuilds).not.toContain('dangerouslyAllowAllBuilds');
    // The single-install authorization is cleared before publication.
    expect(existsSync(join(h.generationDirectory, 'profile', 'pnpm-workspace.yaml'))).toBe(false);
    // The granted authorization is recorded in the non-digest source provenance.
    expect(outcome.value.sourceLock.buildAuthorization).toEqual(authorization);
  });

  it('refuses a set that omits an enumerated dependency script, with no authorized install', async () => {
    const h = harness();
    const authorization = authorizationFor([...h.resolution.scripts]);
    const outcome = await h.stage(authorization);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('AUTHORIZATION_MISMATCH');
    expect(h.runCalls.map((call) => call.args)).toEqual([['install', '--frozen-lockfile', '--ignore-scripts']]);
  });

  it('refuses a commit drift before any install', async () => {
    const h = harness();
    const outcome = await h.stage({ commitSha: 'f'.repeat(40), scripts: [...h.resolution.scripts] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('AUTHORIZATION_MISMATCH');
    expect(h.runCalls).toHaveLength(0);
  });
});
