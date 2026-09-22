/**
 * Crash-recovery reconciliation of the dispatcher idempotency ledger for
 * `changes.apply` / `generations.restore` (review 5777001241).
 *
 * A crash between the dispatcher's `in-progress` write and the outcome write
 * must not leave the same `requestId` replaying as `ENVIRONMENT_BUSY` forever.
 * These tests drive the REAL dispatcher, crash it, rebuild the service, run
 * `recover()` and replay the same `requestId`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_VERSION,
  canonicalizeJson,
  createContractRuntime,
  portFail,
  portOk,
  type ContractPort,
  type ContractResponse,
} from '@hdsl/contracts';
import {
  ChangeApplyService,
  ChangePlanStore,
  EnvironmentStore,
  IdempotencyStore,
  OperationStore,
  ensureLayout,
  generationPaths,
  resolveLayout,
  type PluginApplyPort,
  type ChangeFaults,
  type EnvironmentRecord,
} from '@hdsl/core';
import { computeCompositionDigest, sha256TreeDigestSync } from '@hdsl/runtime';
import type { ApplyChangeCommand, CompositionLock, IdempotencyRecord, RestoreGenerationCommand } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const PLAN_ID = 'plan-0000000000000001';
const OLD_GENERATION = 'gen-0000000000000001';
const REQUEST_ID = 'req-idem-apply';
const RESTORE_REQUEST_ID = 'req-idem-restore';

const lock = (): CompositionLock => ({
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [{ id: 'dsh-plugin-demo', version: '1.0.0', sha256: 'c'.repeat(64) }],
  sources: { node: { url: 'https://fixture.invalid/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://fixture.invalid/d', sha256: 'b'.repeat(64) } },
});

const stagedPort = (): PluginApplyPort => ({
  stage: async (command) => {
    const profile = join(command.generationDirectory, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['b'] } } }));
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
    return {
      ok: true,
      value: {
        compositionLock: lock(),
        sourceLock: {
          sourceKind: 'github',
          repository: { owner: 'octo', name: 'dsh-plugin-demo' },
          commitSha: 'e'.repeat(40),
          ref: null,
          packageName: 'dsh-plugin-demo',
          packageVersion: '1.0.0',
          manifestSha256: 'f'.repeat(64),
          closureLockSha256: '1'.repeat(64),
          isBuiltin: false,
          buildAuthorization: null,
          executor: null,
        },
        stagedProfileDirectory: profile,
      },
    };
  },
});

const build = (faults?: ChangeFaults) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-idem-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  const now = '2026-09-22T00:05:00.000Z';
  environments.write({
    schemaVersion: '1', id: ENVIRONMENT_ID, name: 'idem-env', revision: 3, stateVersion: 1,
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
  writeFileSync(oldPaths.lockPath, JSON.stringify({ schemaVersion: '1', node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) }, dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) }, plugins: [], sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } } }));
  writeFileSync(oldPaths.generationRecordPath, JSON.stringify({ id: OLD_GENERATION, environmentId: ENVIRONMENT_ID, compositionDigest: '0'.repeat(64), createdAt: now }));
  const plans = new ChangePlanStore(layout);
  plans.write({ schemaVersion: '1', plan: {
    planId: PLAN_ID, environmentId: ENVIRONMENT_ID, baseRevision: 3,
    action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    createdAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-22T00:15:00.000Z', sourceLock: null,
    scriptAssessment: 'none-detected', scripts: [], requiresBuildAuthorization: false,
    riskItems: [], removals: [], retention: [], blockingReferences: [], executor: null, planInputsDigest: 'd'.repeat(64),
  }, consumedBy: null });
  const operations = new OperationStore(layout);
  const idempotency = new IdempotencyStore(layout);
  const service = new ChangeApplyService({
    layout, plans, environments, operations, idempotency,
    compositionDigest: computeCompositionDigest,
    port: stagedPort(),
    verifyGenerationRuntime: () => true,
    now: () => new Date(now),
    ...(faults === undefined ? {} : { faults }),
  });
  // A ContractPort whose apply/restore can be crashed AFTER the effect started.
  const port = {
    findEnvironment: (environmentId: string) => {
      const record = new EnvironmentStore(layout).read(environmentId);
      return record === undefined
        ? portFail('NOT_FOUND', 'environment was not found')
        : portOk({
            id: record.id, name: record.name, revision: record.revision, stateVersion: record.stateVersion,
            state: record.state, activeGenerationId: record.activeGenerationId, compositionDigest: record.compositionDigest,
          });
    },
    readIdempotency: (requestId: string) => idempotency.read(requestId),
    writeIdempotency: (requestId: string, record: IdempotencyRecord) => { idempotency.write(requestId, record); },
    applyChange: (command: ApplyChangeCommand) => service.applyChange(command),
    restoreGeneration: (command: RestoreGenerationCommand) => service.restoreGeneration(command),
  } as unknown as ContractPort;
  const contract = createContractRuntime({ port });
  const dispatch = (method: string, input: unknown): ContractResponse<unknown> =>
    contract.dispatch({ apiVersion: API_VERSION, method, input });
  return { dataRoot, layout, environments, operations, idempotency, plans, service, dispatch, port };
};

type Harness = ReturnType<typeof build>;

const applyInput = (requestId = REQUEST_ID, planId = PLAN_ID) => ({
  requestId, environmentId: ENVIRONMENT_ID, expectedRevision: 3, planId,
});
const restoreInput = (requestId = RESTORE_REQUEST_ID, expectedRevision = 3) => ({
  requestId, environmentId: ENVIRONMENT_ID, expectedRevision, targetGenerationId: OLD_GENERATION,
});

/** Crash the dispatch after the effect started: the ledger stays in-progress. */
const crashAfterStart = (harness: Harness, method: 'apply' | 'restore', input: unknown): void => {
  const crashed: ContractPort = {
    ...harness.port,
    applyChange: method === 'apply'
      ? (command: ApplyChangeCommand) => { harness.service.applyChange(command); throw new Error('simulated crash'); }
      : harness.port.applyChange,
    restoreGeneration: method === 'restore'
      ? (command: RestoreGenerationCommand) => { harness.service.restoreGeneration(command); throw new Error('simulated crash'); }
      : harness.port.restoreGeneration,
  } as unknown as ContractPort;
  const contract = createContractRuntime({ port: crashed });
  contract.dispatch({ apiVersion: API_VERSION, method: method === 'apply' ? 'changes.apply' : 'generations.restore', input });
};

describe('idempotency ledger reconciliation for apply/restore (review 5777001241)', () => {
  it('apply crash BEFORE the commit point: replay returns the bound operation, never ENVIRONMENT_BUSY', async () => {
    const first = build({ pauseAt: 'verified' });
    crashAfterStart(first, 'apply', applyInput());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.idempotency.read(REQUEST_ID)?.state).toBe('in-progress');

    // Rebuild a fresh service (as after a process restart) and reconcile.
    const recovered = new ChangeApplyService({
      layout: first.layout, plans: new ChangePlanStore(first.layout), environments: new EnvironmentStore(first.layout),
      operations: new OperationStore(first.layout), idempotency: new IdempotencyStore(first.layout),
      compositionDigest: computeCompositionDigest, port: stagedPort(), verifyGenerationRuntime: () => true, now: () => new Date('2026-09-22T00:05:00.000Z'),
    });
    recovered.recover();
    const ledger = new IdempotencyStore(first.layout).read(REQUEST_ID);
    expect(ledger?.state).toBe('completed');

    const replay = first.dispatch('changes.apply', applyInput());
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    const replayRef = replay.value as { operationId: string };
    expect(first.operations.read(replayRef.operationId)?.status).toBe('failed');
    // A different payload under the same requestId is still rejected.
    const conflict = first.dispatch('changes.apply', applyInput(REQUEST_ID, 'plan-0000000000000009'));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('apply crash AFTER the pointer switch: replay returns the committed operation', async () => {
    const first = build({ pauseAt: 'committed' });
    crashAfterStart(first, 'apply', applyInput());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.idempotency.read(REQUEST_ID)?.state).toBe('in-progress');

    const recovered = new ChangeApplyService({
      layout: first.layout, plans: new ChangePlanStore(first.layout), environments: new EnvironmentStore(first.layout),
      operations: new OperationStore(first.layout), idempotency: new IdempotencyStore(first.layout),
      compositionDigest: computeCompositionDigest, port: stagedPort(), verifyGenerationRuntime: () => true, now: () => new Date('2026-09-22T00:05:00.000Z'),
    });
    expect(recovered.recover().finalized).toBeGreaterThanOrEqual(1);
    const replay = first.dispatch('changes.apply', applyInput());
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    const replayRef = replay.value as { operationId: string };
    expect(first.operations.read(replayRef.operationId)?.status).toBe('succeeded');
    expect(new EnvironmentStore(first.layout).read(ENVIRONMENT_ID)?.activeGenerationId).not.toBe(OLD_GENERATION);
  });

  it('restore crash before any effect evidence: replay returns a controlled failure, never ENVIRONMENT_BUSY', () => {
    const harness = build();
    // The crash happens in the window between the dispatcher's in-progress write
    // and any durable effect, so no operation/journal exists at all.
    const crashed = {
      ...harness.port,
      restoreGeneration: () => { throw new Error('simulated crash before the effect'); },
    } as unknown as ContractPort;
    createContractRuntime({ port: crashed }).dispatch({ apiVersion: API_VERSION, method: 'generations.restore', input: restoreInput() });
    expect(harness.idempotency.read(RESTORE_REQUEST_ID)?.state).toBe('in-progress');

    const recovered = new ChangeApplyService({
      layout: harness.layout, plans: new ChangePlanStore(harness.layout), environments: new EnvironmentStore(harness.layout),
      operations: new OperationStore(harness.layout), idempotency: new IdempotencyStore(harness.layout),
      compositionDigest: computeCompositionDigest, port: stagedPort(), verifyGenerationRuntime: () => true, now: () => new Date('2026-09-22T00:05:00.000Z'),
    });
    recovered.recover();
    const ledger = new IdempotencyStore(harness.layout).read(RESTORE_REQUEST_ID);
    expect(ledger?.state).toBe('completed');
    if (ledger?.state === 'completed') {
      expect(ledger.outcome.ok).toBe(false);
      if (!ledger.outcome.ok) expect(ledger.outcome.error.code).toBe('INTERNAL_ERROR');
    }
    const replay = harness.dispatch('generations.restore', restoreInput());
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('INTERNAL_ERROR');
  });

  it('restore crash after the pointer switch: replay returns the bound operation', () => {
    const harness = build();
    // Simulate the crash window exactly: the ledger is in-progress, and the
    // journal + running operation exist with the pointer already switched.
    const input = restoreInput();
    harness.idempotency.write(RESTORE_REQUEST_ID, {
      state: 'in-progress',
      method: 'generations.restore',
      fingerprint: canonicalizeJson(input),
    });
    const transactionId = 'txn-00000000000000ab';
    const operationId = 'op-00000000000000ab';
    const timestamp = '2026-09-22T00:05:00.000Z';
    harness.operations.create({ id: operationId, kind: 'restore', environmentId: ENVIRONMENT_ID, phase: 'switching', status: 'running', createdAt: timestamp });
    writeFileSync(join(harness.layout.applyJournals, `${transactionId}.json`), JSON.stringify({
      schemaVersion: '1', kind: 'restore', transactionId, requestId: RESTORE_REQUEST_ID, operationId,
      environmentId: ENVIRONMENT_ID, generationId: OLD_GENERATION, planId: '', sourceLock: null, phase: 'committed',
      createdAt: timestamp, updatedAt: timestamp,
    }));
    const environments = new EnvironmentStore(harness.layout);
    environments.write({ ...environments.read(ENVIRONMENT_ID)!, activeGenerationId: OLD_GENERATION, revision: 4, compositionDigest: '1'.repeat(64) });

    const recovered = new ChangeApplyService({
      layout: harness.layout, plans: new ChangePlanStore(harness.layout), environments: new EnvironmentStore(harness.layout),
      operations: new OperationStore(harness.layout), idempotency: new IdempotencyStore(harness.layout),
      compositionDigest: computeCompositionDigest, port: stagedPort(), verifyGenerationRuntime: () => true, now: () => new Date('2026-09-22T00:05:00.000Z'),
    });
    expect(recovered.recover().finalized).toBeGreaterThanOrEqual(1);
    const replay = harness.dispatch('generations.restore', input);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect((replay.value as { operationId: string }).operationId).toBe(operationId);
    expect(new OperationStore(harness.layout).read(operationId)?.status).toBe('succeeded');
  });
});
