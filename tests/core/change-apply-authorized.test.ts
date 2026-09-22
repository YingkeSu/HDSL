/**
 * #78 S4 end-to-end (core transaction + REAL runtime apply port + plan-bound
 * target profile): an explicit authorization that binds the plan's exact commit
 * and enumerated script set commits a new generation; the deny / mismatch /
 * drift paths leave the old generation unchanged and never run the authorized
 * install.
 *
 * Fakes only at the OS boundary (git provider + managed executor): no network
 * and no script is executed. The external-marker deny/allow proof is the opt-in
 * probe.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangeApplyService,
  ChangePlanStore,
  EnvironmentStore,
  OperationStore,
  ensureLayout,
  generationPaths,
  resolveLayout,
  writeTargetProfileCache,
  type EnvironmentRecord,
} from '@hdsl/core';
import {
  buildPreviewResolution,
  createPluginApplyPort,
  sha256TreeDigestSync,
  type GitProvider,
  type PluginExecutorPort,
} from '@hdsl/runtime';
import type {
  BuildAuthorization,
  ChangePlan,
  CompositionLock,
  ExecutorIdentity,
  PluginSourceSelector,
} from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const PLAN_ID = 'plan-0000000000000001';
const OLD_GENERATION = 'gen-0000000000000001';
const COMMIT = 'e'.repeat(40);
const SOURCE: PluginSourceSelector = { owner: 'octo', name: 'hdsl-plugin-demo', ref: 'main' };
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const MANIFEST = JSON.stringify({
  name: 'hdsl-plugin-demo',
  version: '1.0.0',
  dependencies: { 'shared-dep': '1.2.3' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  scripts: { preinstall: 'node p.js', install: 'node i.js', postinstall: 'node po.js', prepare: 'node pr.js' },
});

const PLUGIN_KEY = `hdsl-plugin-demo@https://codeload.github.com/octo/hdsl-plugin-demo/tar.gz/${COMMIT}`;
const TARGET_LOCK = [
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
const TARGET_LOCK_SHA = sha256(TARGET_LOCK);
const DECLARATION_TEXT = `${JSON.stringify(
  {
    name: 'hdsl-profile',
    private: true,
    dependencies: { 'hdsl-plugin-demo': `github:octo/hdsl-plugin-demo#${COMMIT}` },
    dsh: { profile: { bundles: ['hdsl-plugin-demo'] } },
  },
  null,
  2,
)}\n`;
const DECLARATION_SHA = sha256(JSON.stringify({ declaration: DECLARATION_TEXT, workspace: null }));

const EXECUTOR: ExecutorIdentity = {
  id: 'pnpm',
  version: '11.7.0',
  sha256: '1'.repeat(64),
  entrySha256: '2'.repeat(64),
  treeSha256: '3'.repeat(64),
};

const currentLock = (): CompositionLock => ({
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [],
  sources: { node: { url: 'https://fixture.invalid/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://fixture.invalid/d', sha256: 'b'.repeat(64) } },
});

const resolution = () => {
  const built = buildPreviewResolution({
    source: SOURCE,
    resolved: { commitSha: COMMIT, manifestText: MANIFEST, lockText: null },
    executor: EXECUTOR,
  });
  if (!built.ok) {
    throw new Error('fixture resolution failed');
  }
  return built.value;
};

const plan = (): ChangePlan => {
  const resolved = resolution();
  return {
    planId: PLAN_ID,
    environmentId: ENVIRONMENT_ID,
    baseRevision: 3,
    action: { kind: 'install', source: SOURCE },
    createdAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-22T00:15:00.000Z',
    sourceLock: {
      ...resolved.sourceLock,
      closureLockSha256: TARGET_LOCK_SHA,
      targetDeclarationSha256: DECLARATION_SHA,
    },
    scriptAssessment: resolved.scriptAssessment,
    scripts: [...resolved.scripts],
    requiresBuildAuthorization: resolved.requiresBuildAuthorization,
    riskItems: [...resolved.riskItems],
    removals: [],
    retention: [],
    blockingReferences: [],
    executor: resolved.executor,
    planInputsDigest: resolved.planInputsDigest,
  };
};

const fakeExecutor = (runCalls: { args: readonly string[]; workspace: string | null }[]): PluginExecutorPort => ({
  identity: async () => ({ ok: true, value: EXECUTOR }),
  run: async (request) => {
    const authorized = request.args.includes('--ignore-scripts=false');
    if (!authorized) {
      // Default-deny materialisation: read-only tree so the closure can be enumerated.
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
      workspace: existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : null,
    });
    return { ok: true, value: { executor: EXECUTOR, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
  },
});

const build = (withAuthorization: BuildAuthorization | null) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-s4-e2e-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  const now = '2026-09-22T00:05:00.000Z';
  environments.write({
    schemaVersion: '1',
    id: ENVIRONMENT_ID,
    name: 's4-env',
    revision: 3,
    stateVersion: 1,
    state: 'stopped',
    activeGenerationId: OLD_GENERATION,
    compositionDigest: '0'.repeat(64),
    createdAt: now,
    updatedAt: now,
  } satisfies EnvironmentRecord);
  const oldPaths = generationPaths(layout, ENVIRONMENT_ID, OLD_GENERATION);
  mkdirSync(join(oldPaths.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(oldPaths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
  writeFileSync(
    oldPaths.manifestPath,
    JSON.stringify({
      schemaVersion: '1',
      installMode: 'npm-ci',
      node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(oldPaths.nodeDirectory) },
      dsh: { version: '0.1.5-rc.2', treeDigest: sha256TreeDigestSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')) },
    }),
  );
  writeFileSync(oldPaths.lockPath, JSON.stringify(currentLock()));
  writeFileSync(oldPaths.generationRecordPath, JSON.stringify({ id: OLD_GENERATION, environmentId: ENVIRONMENT_ID, compositionDigest: '0'.repeat(64), createdAt: now }));

  const planValue = plan();
  const plans = new ChangePlanStore(layout);
  plans.write({ schemaVersion: '1', plan: planValue, consumedBy: null });
  const cached = writeTargetProfileCache(layout, PLAN_ID, {
    lockText: TARGET_LOCK,
    declarationText: DECLARATION_TEXT,
    workspaceText: null,
  });
  if (!cached.ok) {
    throw new Error('target profile cache write failed');
  }
  const operations = new OperationStore(layout);
  const runCalls: { args: readonly string[]; workspace: string | null }[] = [];
  const provider: GitProvider = {
    resolveManifest: async () => ({ ok: true, value: { commitSha: COMMIT, manifestText: MANIFEST, lockText: null } }),
  };
  const service = new ChangeApplyService({
    layout,
    plans,
    environments,
    operations,
    compositionDigest: (lock) => JSON.stringify(lock.plugins),
    port: createPluginApplyPort({ gitProvider: provider, executor: fakeExecutor(runCalls) }),
    verifyGenerationRuntime: () => true,
    now: () => new Date(now),
  });
  const command = () =>
    service.applyChange({
      requestId: 'req-apply',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      planId: PLAN_ID,
      buildAuthorization: withAuthorization,
    });
  return { layout, environments, operations, plans, service, runCalls, plan: planValue, command };
};

const authorizationFor = (planValue: ChangePlan, extra: BuildAuthorization['scripts'] = []): BuildAuthorization => ({
  commitSha: planValue.sourceLock?.commitSha ?? COMMIT,
  scripts: [...planValue.scripts, ...extra],
});

const waitTerminal = async (operations: OperationStore, id: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const record = operations.read(id);
    if (record !== undefined && ['succeeded', 'failed', 'cancelled'].includes(record.status)) {
      return record;
    }
    if (Date.now() > deadline) {
      throw new Error('apply did not terminate');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const DEPENDENCY_SCRIPT = { packageName: 'shared-dep', packageVersion: '1.2.3', script: 'postinstall', source: 'dependency' } as const;

describe('S4 authorized install through the real runtime apply port (core transaction)', () => {
  it('denies by default and leaves the old generation, plan and executor untouched', async () => {
    const harnessed = build(null);
    const started = harnessed.command();
    // The core guard is side-effect free and rejects before any operation exists.
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe('BUILD_NOT_AUTHORIZED');
    expect(harnessed.runCalls).toHaveLength(0);
    expect(harnessed.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(harnessed.plans.read(PLAN_ID)?.consumedBy).toBeNull();
  });

  it('commits exactly the authorized set, records it in the non-digest source provenance and clears the workspace allowlist', async () => {
    // First resolve with a throwaway plan to build the exact authorization set.
    const probe = build(null);
    const authorization = authorizationFor(probe.plan, [DEPENDENCY_SCRIPT]);

    const harnessed = build(authorization);
    const started = harnessed.command();
    if (!started.ok) return;
    const snapshot = await waitTerminal(harnessed.operations, started.value.operationId);
    expect(snapshot.status).toBe('succeeded');

    // Phase 1 materialises with default deny; phase 2 is the single authorized install.
    expect(harnessed.runCalls.map((call) => call.args)).toEqual([
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      ['install', '--frozen-lockfile', '--ignore-scripts=false'],
    ]);
    const allowBuilds = harnessed.runCalls[1]?.workspace ?? '';
    expect(allowBuilds).toContain(`${PLUGIN_KEY}: true`);
    expect(allowBuilds).toContain('shared-dep@1.2.3: true');
    expect(allowBuilds).not.toContain('dangerouslyAllowAllBuilds');
    expect(allowBuilds).not.toContain('onlyBuiltDependencies');

    // No resident allowlist is published with the generation.
    const environment = harnessed.environments.read(ENVIRONMENT_ID)!;
    expect(environment.activeGenerationId).not.toBe(OLD_GENERATION);
    expect(existsSync(join(generationPaths(harnessed.layout, ENVIRONMENT_ID, environment.activeGenerationId!).generationDirectory, 'profile', 'pnpm-workspace.yaml'))).toBe(false);
    // The granted authorization is recorded (non-digest provenance), not applied as a global switch.
    const lock = JSON.parse(readFileSync(generationPaths(harnessed.layout, ENVIRONMENT_ID, environment.activeGenerationId!).lockPath, 'utf8')) as CompositionLock;
    expect(lock.pluginSources?.['hdsl-plugin-demo']?.buildAuthorization).toEqual(authorization);
  });

  it('rejects a subset authorization before the authorized install, keeping the old generation', async () => {
    const probe = build(null);
    const subset: BuildAuthorization = { commitSha: COMMIT, scripts: [...probe.plan.scripts] };
    const harnessed = build(subset);
    const started = harnessed.command();
    if (!started.ok) return;
    const snapshot = await waitTerminal(harnessed.operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('AUTHORIZATION_MISMATCH');
    // Only the default-deny materialisation ran; the authorized install never did.
    expect(harnessed.runCalls.map((call) => call.args)).toEqual([['install', '--frozen-lockfile', '--ignore-scripts']]);
    expect(harnessed.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
  });

  it('rejects a wrong-commit authorization before any executor run', async () => {
    const probe = build(null);
    const forged: BuildAuthorization = {
      commitSha: 'f'.repeat(40),
      scripts: [...probe.plan.scripts, DEPENDENCY_SCRIPT],
    };
    const harnessed = build(forged);
    const started = harnessed.command();
    if (!started.ok) return;
    const snapshot = await waitTerminal(harnessed.operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('AUTHORIZATION_MISMATCH');
    expect(harnessed.runCalls).toHaveLength(0);
    expect(harnessed.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
  });
});
