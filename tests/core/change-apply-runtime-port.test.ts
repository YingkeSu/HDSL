/**
 * Controlled-fixture same-environment apply through the REAL runtime apply port:
 * GitProvider re-resolution -> executor identity + default deny -> composition /
 * manifest / staged profile. A false runtime identity verification must block
 * before the runtime port is invoked (no publish/commit).
 */
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
  type EnvironmentRecord,
} from '@hdsl/core';
import {
  createPluginApplyPort,
  createGenerationRuntimeVerifier,
  sha256TreeDigestSync,
  type GitProvider,
  type PluginExecutorPort,
} from '@hdsl/runtime';
import type { ChangePlan, CompositionLock } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const PLAN_ID = 'plan-0000000000000001';
const OLD_GENERATION = 'gen-0000000000000001';

const currentLock = (): CompositionLock => ({
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [],
  sources: { node: { url: 'https://fixture.invalid/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://fixture.invalid/d', sha256: 'b'.repeat(64) } },
});

const plan = (): ChangePlan => ({
  planId: PLAN_ID,
  environmentId: ENVIRONMENT_ID,
  baseRevision: 3,
  action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo', ref: 'main' } },
  createdAt: '2026-09-22T00:00:00.000Z',
  expiresAt: '2026-09-22T00:15:00.000Z',
  sourceLock: null,
  scriptAssessment: 'none-detected',
  scripts: [],
  requiresBuildAuthorization: false,
  riskItems: [],
  removals: [],
  retention: [],
  blockingReferences: [],
  executor: null,
  planInputsDigest: 'd'.repeat(64),
});

const gitProvider = (calls: { count: number }): GitProvider => ({
  resolveManifest: async () => {
    calls.count += 1;
    return {
      ok: true,
      value: {
        commitSha: 'e'.repeat(40),
        manifestText: JSON.stringify({
          name: 'dsh-plugin-demo',
          version: '1.2.3',
          dsh: { bundle: { patch: 'cordis.patch.yml' } },
        }),
        lockText: 'lockfileVersion: 9.0\n',
      },
    };
  },
});

const fakeExecutor = (calls: { args: readonly string[] }[]): PluginExecutorPort => ({
  identity: async () => ({
    ok: true,
    value: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) },
  }),
  run: async (request) => {
    calls.push({ args: request.args });
    writeFileSync(join(request.cwd, 'node_modules.stamp'), 'installed\n');
    return {
      ok: true,
      value: {
        executor: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) },
        exitCode: 0,
        stdout: '',
        stderr: '',
        executedInstallScripts: [],
      },
    };
  },
});

const build = (options: { verify?: (input: { manifestPath: string; nodeDirectory: string; dshDirectory: string }) => boolean; tamperNode?: boolean } = {}) => {
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
  writeFileSync(
    oldPaths.manifestPath,
    JSON.stringify({
      schemaVersion: '1',
      installMode: 'npm-ci',
      node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(oldPaths.nodeDirectory) },
      dsh: {
        version: '0.1.5-rc.2',
        treeDigest: sha256TreeDigestSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')),
      },
    }),
  );
  if (options.tamperNode === true) {
    writeFileSync(join(oldPaths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\necho tampered\n');
  }
  writeFileSync(oldPaths.lockPath, JSON.stringify(currentLock()));

  const plans = new ChangePlanStore(layout);
  plans.write({ schemaVersion: '1', plan: plan(), consumedBy: null });
  const operations = new OperationStore(layout);
  const gitCalls = { count: 0 };
  const runCalls: { args: readonly string[] }[] = [];
  const port = createPluginApplyPort({ gitProvider: gitProvider(gitCalls), executor: fakeExecutor(runCalls) });
  const service = new ChangeApplyService({
    layout, plans, environments, operations,
    compositionDigest: (lock) => JSON.stringify(lock.plugins),
    port,
    ...(options.verify === undefined ? {} : { verifyGenerationRuntime: options.verify }),
    now: () => new Date(now),
  });
  return { layout, environments, operations, service, gitCalls, runCalls };
};

const command = () => ({ requestId: 'req-apply', environmentId: ENVIRONMENT_ID, expectedRevision: 3, planId: PLAN_ID, buildAuthorization: null });

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
  it('invokes the runtime port, installs with default deny and commits a new generation', async () => {
    const { layout, environments, operations, service, gitCalls, runCalls } = build({ verify: () => true });
    const started = service.applyChange(command());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('succeeded');

    // The runtime port re-resolved the source and ran the managed executor with
    // the default-deny arguments.
    expect(gitCalls.count).toBe(1);
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.args).toEqual(['install', '--ignore-scripts']);

    const environment = environments.read(ENVIRONMENT_ID)!;
    expect(environment.activeGenerationId).not.toBe(OLD_GENERATION);
    expect(environment.revision).toBe(4);
    const paths = generationPaths(layout, ENVIRONMENT_ID, environment.activeGenerationId!);
    const lock = JSON.parse(readFileSync(paths.lockPath, 'utf8')) as CompositionLock;
    expect(lock.plugins).toEqual([{ id: 'dsh-plugin-demo', version: '1.2.3', sha256: expect.any(String) }]);
    // The staged profile was materialised and published.
    expect(existsSync(join(paths.generationDirectory, 'profile', 'package.json'))).toBe(true);
    expect(existsSync(join(layout.environments, ENVIRONMENT_ID, 'home', 'profiles', `hdsl-${environment.activeGenerationId}`))).toBe(true);
  });

  it('blocks a tampered Node binary (DSH tree unchanged) with the real verifier and keeps the old generation', async () => {
    const { environments, operations, service, gitCalls, runCalls } = build({
      verify: createGenerationRuntimeVerifier(),
      tamperNode: true,
    });
    const started = service.applyChange(command());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(gitCalls.count).toBe(0);
    expect(runCalls).toHaveLength(0);
    expect(environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
  });

  it('blocks before the runtime port when the reused runtime identity is not verified', async () => {
    const { environments, operations, service, gitCalls, runCalls } = build({ verify: () => false });
    const started = service.applyChange(command());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    // No publish/commit and the runtime port was never invoked.
    expect(gitCalls.count).toBe(0);
    expect(runCalls).toHaveLength(0);
    expect(environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
  });
});
