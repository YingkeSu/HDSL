/**
 * Controlled-fixture same-environment apply through the REAL runtime apply port.
 * Verifies exact previewed-commit binding, closure/executor identity binding,
 * S4 lock-down and lock-rewrite detection, plus the runtime reuse identity gate.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  type ChangeFaults,
  type EnvironmentRecord,
} from '@hdsl/core';
import {
  buildPreviewResolution,
  createGenerationRuntimeVerifier,
  createPluginApplyPort,
  sha256TreeDigestSync,
  type GitProvider,
  type PluginExecutorPort,
} from '@hdsl/runtime';
import type { BuildAuthorization, ChangePlan, CompositionLock, ExecutorIdentity } from '@hdsl/contracts';

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
const MANIFEST = JSON.stringify({ name: 'dsh-plugin-demo', version: '1.2.3', dsh: { bundle: { patch: 'cordis.patch.yml' } } });
const LOCK = 'lockfileVersion: 9.0\nimporters:\n  .: {}\n';
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
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

const SOURCE = { owner: 'octo', name: 'dsh-plugin-demo', ref: 'main' } as const;
const planInputsDigest = (): string => {
  const built = buildPreviewResolution({
    source: SOURCE,
    resolved: { commitSha: COMMIT, manifestText: MANIFEST, lockText: LOCK },
    executor: EXECUTOR,
  });
  if (!built.ok) {
    throw new Error('fixture resolution failed');
  }
  return built.value.planInputsDigest;
};

const plan = (overrides: Partial<ChangePlan> = {}): ChangePlan => ({
  planId: PLAN_ID,
  environmentId: ENVIRONMENT_ID,
  baseRevision: 3,
  action: { kind: 'install', source: SOURCE },
  createdAt: '2026-09-22T00:00:00.000Z',
  expiresAt: '2026-09-22T00:15:00.000Z',
  sourceLock: {
    sourceKind: 'github',
    repository: { owner: 'octo', name: 'dsh-plugin-demo' },
    commitSha: COMMIT,
    ref: 'main',
    packageName: 'dsh-plugin-demo',
    packageVersion: '1.2.3',
    manifestSha256: sha256(MANIFEST),
    closureLockSha256: sha256(LOCK),
    isBuiltin: false,
    buildAuthorization: null,
    executor: EXECUTOR,
  },
  scriptAssessment: 'none-detected',
  scripts: [],
  requiresBuildAuthorization: false,
  riskItems: [],
  removals: [],
  retention: [],
  blockingReferences: [],
  executor: EXECUTOR,
  planInputsDigest: planInputsDigest(),
  ...overrides,
});

const gitProvider = (
  calls: { count: number },
  overrides: { commitSha?: string; lockText?: string | null } = {},
): GitProvider => ({
  resolveManifest: async () => {
    calls.count += 1;
    return {
      ok: true,
      value: {
        commitSha: overrides.commitSha ?? COMMIT,
        manifestText: MANIFEST,
        lockText: overrides.lockText === undefined ? LOCK : overrides.lockText,
      },
    };
  },
});

const fakeExecutor = (
  calls: { args: readonly string[] }[],
  options: { rewriteLock?: boolean } = {},
): PluginExecutorPort => ({
  identity: async () => ({ ok: true, value: EXECUTOR }),
  run: async (request) => {
    calls.push({ args: request.args });
    if (options.rewriteLock === true) {
      writeFileSync(join(request.cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# rewritten\n');
    } else {
      writeFileSync(join(request.cwd, 'node_modules.stamp'), 'installed\n');
    }
    return { ok: true, value: { executor: EXECUTOR, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
  },
});

interface BuildOptions {
  verify?: (input: { manifestPath: string; nodeDirectory: string; dshDirectory: string }) => boolean;
  tamperNode?: boolean;
  plan?: ChangePlan;
  provider?: { commitSha?: string; lockText?: string | null };
  executor?: { rewriteLock?: boolean };
  faults?: ChangeFaults;
}

const build = (options: BuildOptions = {}) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-apply-port-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  const now = '2026-09-22T00:05:00.000Z';
  environments.write({
    schemaVersion: '1', id: ENVIRONMENT_ID, name: 'apply-env', revision: 3, stateVersion: 1,
    state: 'stopped', activeGenerationId: OLD_GENERATION, compositionDigest: '0'.repeat(64), createdAt: now, updatedAt: now,
  } satisfies EnvironmentRecord);
  const oldPaths = generationPaths(layout, ENVIRONMENT_ID, OLD_GENERATION);
  mkdirSync(join(oldPaths.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(oldPaths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
  writeFileSync(oldPaths.manifestPath, JSON.stringify({
    schemaVersion: '1', installMode: 'npm-ci',
    node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(oldPaths.nodeDirectory) },
    dsh: { version: '0.1.5-rc.2', treeDigest: sha256TreeDigestSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')) },
  }));
  writeFileSync(oldPaths.lockPath, JSON.stringify(currentLock()));
  if (options.tamperNode === true) {
    writeFileSync(join(oldPaths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\necho tampered\n');
  }

  const plans = new ChangePlanStore(layout);
  plans.write({ schemaVersion: '1', plan: options.plan ?? plan(), consumedBy: null });
  const operations = new OperationStore(layout);
  const gitCalls = { count: 0 };
  const runCalls: { args: readonly string[] }[] = [];
  const port = createPluginApplyPort({
    gitProvider: gitProvider(gitCalls, options.provider ?? {}),
    executor: fakeExecutor(runCalls, options.executor ?? {}),
  });
  const service = new ChangeApplyService({
    layout, plans, environments, operations,
    compositionDigest: (lock) => JSON.stringify(lock.plugins),
    port,
    ...(options.verify === undefined ? {} : { verifyGenerationRuntime: options.verify }),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    now: () => new Date(now),
  });
  return { layout, environments, operations, service, gitCalls, runCalls };
};

const command = (overrides: Partial<{ buildAuthorization: BuildAuthorization | null }> = {}) => ({
  requestId: 'req-apply',
  environmentId: ENVIRONMENT_ID,
  expectedRevision: 3,
  planId: PLAN_ID,
  buildAuthorization: overrides.buildAuthorization ?? null,
});

const waitTerminal = async (operations: OperationStore, id: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const record = operations.read(id);
    if (record !== undefined && ['succeeded', 'failed', 'cancelled'].includes(record.status)) return record;
    if (Date.now() > deadline) throw new Error('apply did not terminate');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('changes.apply through the runtime apply port', () => {
  it('commits a new generation when the source, closure and executor all match the plan', async () => {
    const { layout, environments, operations, service, gitCalls, runCalls } = build({ verify: () => true });
    const started = service.applyChange(command());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('succeeded');
    expect(gitCalls.count).toBe(1);
    expect(runCalls[0]?.args).toEqual(['install', '--ignore-scripts']);
    const environment = environments.read(ENVIRONMENT_ID)!;
    expect(environment.activeGenerationId).not.toBe(OLD_GENERATION);
    const paths = generationPaths(layout, ENVIRONMENT_ID, environment.activeGenerationId!);
    const lock = JSON.parse(readFileSync(paths.lockPath, 'utf8')) as CompositionLock;
    // Composition identity binds commit + manifest + closure, so it is NOT a
    // bare closure digest and NOT a bare manifest digest.
    const expectedPluginDigest = createHash('sha256')
      .update(JSON.stringify({ commitSha: COMMIT, manifestSha256: sha256(MANIFEST), closureLockSha256: sha256(LOCK) }), 'utf8')
      .digest('hex');
    expect(lock.plugins).toEqual([{ id: 'dsh-plugin-demo', version: '1.2.3', sha256: expectedPluginDigest }]);
    expect(expectedPluginDigest).not.toBe(sha256(LOCK));
  });

  it('rejects a moved branch instead of silently installing the new SHA', async () => {
    const { environments, operations, service, gitCalls, runCalls } = build({
      verify: () => true,
      provider: { commitSha: 'f'.repeat(40) },
    });
    const started = service.applyChange(command());
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('PLAN_STALE');
    expect(gitCalls.count).toBe(1); // re-resolved to detect drift
    expect(runCalls).toHaveLength(0); // never executed
    expect(environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
  });

  it('rejects a different closure lock even at the same commit and manifest', async () => {
    const { operations, service, runCalls } = build({
      verify: () => true,
      provider: { lockText: 'lockfileVersion: 9.0\nimporters:\n  .: {}\n# changed\n' },
    });
    const started = service.applyChange(command());
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(['PLAN_STALE', 'PLUGIN_INTEGRITY_MISMATCH']).toContain(snapshot.error?.code);
    expect(runCalls).toHaveLength(0);
  });

  it('rejects an unpinned (null) closure rather than accepting a non-deterministic composition', async () => {
    const { operations, service, runCalls } = build({ verify: () => true, provider: { lockText: null } });
    const started = service.applyChange(command());
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('PLAN_STALE');
    expect(runCalls).toHaveLength(0);
  });

  it('rejects a mismatching executor identity (executor drift)', async () => {
    const drifted = plan();
    const { operations, service, runCalls } = build({
      verify: () => true,
      plan: { ...drifted, executor: { ...EXECUTOR, sha256: '9'.repeat(64) } },
    });
    const started = service.applyChange(command());
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(runCalls).toHaveLength(0);
  });

  it('never treats a supplied build authorization as an unlock (S4 closed)', async () => {
    const forged: BuildAuthorization = { commitSha: COMMIT, scripts: [] };
    const { operations, service, runCalls } = build({ verify: () => true });
    const started = service.applyChange(command({ buildAuthorization: forged }));
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('BUILD_NOT_AUTHORIZED');
    expect(runCalls).toHaveLength(0);
  });

  it('detects a managed install that silently rewrites the pinned lockfile', async () => {
    const { operations, service } = build({ verify: () => true, executor: { rewriteLock: true } });
    const started = service.applyChange(command());
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('PLUGIN_INTEGRITY_MISMATCH');
  });

  it('gives two sources with identical lockfiles but different plugin code different composition identities', () => {
    const composite = (commitSha: string): string =>
      createHash('sha256')
        .update(JSON.stringify({ commitSha, manifestSha256: sha256(MANIFEST), closureLockSha256: sha256(LOCK) }), 'utf8')
        .digest('hex');
    // Same manifest and same lock, different commit -> different identity.
    expect(composite('e'.repeat(40))).not.toBe(composite('f'.repeat(40)));
    expect(composite('e'.repeat(40))).not.toBe(sha256(LOCK));
    expect(composite('e'.repeat(40))).not.toBe(sha256(MANIFEST));
  });

  it('blocks a tampered runtime identity and an unverified runtime before the port runs', async () => {
    const tampered = build({ verify: createGenerationRuntimeVerifier(), tamperNode: true });
    const tamperedStarted = tampered.service.applyChange(command());
    if (!tamperedStarted.ok) return;
    const tamperedSnapshot = await waitTerminal(tampered.operations, tamperedStarted.value.operationId);
    expect(tamperedSnapshot.status).toBe('failed');
    expect(tampered.gitCalls.count).toBe(0);
    expect(tampered.runCalls).toHaveLength(0);

    const unverified = build({ verify: () => false });
    const unverifiedStarted = unverified.service.applyChange(command());
    if (!unverifiedStarted.ok) return;
    await waitTerminal(unverified.operations, unverifiedStarted.value.operationId);
    expect(unverified.gitCalls.count).toBe(0);
    expect(unverified.runCalls).toHaveLength(0);
  });
});
