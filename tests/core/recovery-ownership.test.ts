/**
 * P1 (QA33): service-ownership dispatch in restart recovery.
 *
 * A crashed, READ-ONLY `preview` operation must never invalidate an already
 * committed environment. Kinds are dispatched by ownership:
 *   - `create`/`start`/`stop` -> EnvironmentService
 *   - `preview`               -> ChangePreviewService (read-only: never touches the env)
 *   - `apply`/`restore`       -> ChangeApplyService (journal + idempotency ledger)
 * No recovery branch infers damage from a transient `state` guess.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangeApplyService,
  ChangePlanStore,
  ChangePreviewService,
  EnvironmentService,
  EnvironmentStore,
  IdempotencyStore,
  OperationStore,
  ensureLayout,
  generationPaths,
  resolveLayout,
  type PluginPreviewPort,
  type PluginPreviewResolution,
  type EnvironmentRecord,
} from '@hdsl/core';
import { computeCompositionDigest } from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const GEN1 = 'gen-0000000000000001';
const GEN2 = 'gen-0000000000000002';

const writeGeneration = (layout: ReturnType<typeof resolveLayout>, generationId: string, digest: string): void => {
  const paths = generationPaths(layout, ENVIRONMENT_ID, generationId);
  mkdirSync(join(paths.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(paths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), `// ${generationId}\n`);
  writeFileSync(paths.manifestPath, JSON.stringify({
    schemaVersion: '1', installMode: 'artifacts-only',
    node: { version: '22.19.0', treeDigest: '1'.repeat(64) },
    dsh: { version: '0.1.5-rc.2', treeDigest: '2'.repeat(64) },
  }));
  writeFileSync(paths.lockPath, JSON.stringify({
    schemaVersion: '1',
    node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: '1'.repeat(64) },
    dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: '2'.repeat(64) },
    plugins: [], sources: { node: { url: 'https://x/n', sha256: '1'.repeat(64) }, dsh: { url: 'https://x/d', sha256: '2'.repeat(64) } },
  }));
  writeFileSync(paths.generationRecordPath, JSON.stringify({
    id: generationId, environmentId: ENVIRONMENT_ID, compositionDigest: digest,
    createdAt: '2026-09-22T00:00:00.000Z', profileName: `hdsl-${generationId}`,
  }));
};

const build = (state: EnvironmentRecord['state'] = 'stopped') => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-recovery-ownership-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  const now = '2026-09-22T00:05:00.000Z';
  environments.write({
    schemaVersion: '1', id: ENVIRONMENT_ID, name: 'committed-env', revision: 1, stateVersion: 1,
    state, activeGenerationId: GEN1, compositionDigest: 'a'.repeat(64), createdAt: now, updatedAt: now,
  });
  writeGeneration(layout, GEN1, 'a'.repeat(64));
  const operations = new OperationStore(layout);
  const plans = new ChangePlanStore(layout);
  const preview = new ChangePreviewService({
    layout,
    port: { previewSource: async () => ({ ok: true, value: {} as PluginPreviewResolution }) } as PluginPreviewPort,
    findEnvironment: () => undefined,
    now: () => new Date(now),
  });
  const apply = new ChangeApplyService({
    layout, plans, environments, operations,
    compositionDigest: computeCompositionDigest,
    verifyGenerationRuntime: () => true,
    now: () => new Date(now),
  });
  const service = new EnvironmentService({ dataRoot, catalog: [], runtime: {} as never, lockWaitTimeoutMs: 0, lockPollIntervalMs: 0 });
  return { dataRoot, layout, environments, operations, plans, preview, apply, service };
};

type Harness = ReturnType<typeof build>;

/** Full production recovery order: owning services first, environment last. */
const recoverAll = async (harness: Harness) => {
  const applyRecovery = harness.apply.recover();
  const previewRecovery = harness.preview.recover();
  const serviceRecovery = await harness.service.recover();
  return { applyRecovery, previewRecovery, serviceRecovery };
};

const writeJournal = (harness: Harness, record: Record<string, unknown>): void => {
  writeFileSync(
    join(harness.layout.applyJournals, `${String(record['transactionId'])}.json`),
    JSON.stringify(record),
  );
};

const applyJournal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: '1', kind: 'apply', transactionId: 'txn-0000000000000001', requestId: 'req-apply',
  operationId: 'op-0000000000000001', environmentId: ENVIRONMENT_ID, generationId: GEN2,
  planId: 'plan-0000000000000001', sourceLock: null, phase: 'verified',
  createdAt: '2026-09-22T00:05:00.000Z', updatedAt: '2026-09-22T00:05:00.000Z', ...overrides,
});

describe('recovery ownership dispatch (P1)', () => {
  it('keeps every committed environment field when a preview operation was orphaned', async () => {
    const harness = build();
    const before = harness.environments.read(ENVIRONMENT_ID)!;
    harness.operations.create({ id: 'op-00000000000000aa', kind: 'preview', environmentId: ENVIRONMENT_ID, phase: 'planning', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });

    // Worst-case order: the environment service recovers FIRST, while the preview
    // operation is still non-terminal. Even here it must not touch the environment
    // (this asserted `state:'error'`/`activeGenerationId:null` before the fix).
    await harness.service.recover();
    expect(harness.environments.read(ENVIRONMENT_ID)).toEqual(before);

    const { applyRecovery, previewRecovery } = await recoverAll(harness);

    expect(harness.environments.read(ENVIRONMENT_ID)).toEqual(before);
    expect(harness.operations.read('op-00000000000000aa')?.status).toBe('failed');
    expect(harness.operations.read('op-00000000000000aa')?.error?.code).toBe('INTERNAL_ERROR');
    expect(previewRecovery.terminated).toBeGreaterThanOrEqual(1);
    expect(applyRecovery).toEqual({ finalized: 0, rolledBack: 0 });
  });

  it('preserves a running environment when a preview operation was orphaned', async () => {
    const harness = build('running');
    const before = harness.environments.read(ENVIRONMENT_ID)!;
    harness.operations.create({ id: 'op-00000000000000ab', kind: 'preview', environmentId: ENVIRONMENT_ID, phase: 'planning', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    await harness.service.recover();
    expect(harness.environments.read(ENVIRONMENT_ID)).toEqual(before);
    await recoverAll(harness);
    expect(harness.environments.read(ENVIRONMENT_ID)).toEqual(before);
  });

  it('leaves preview operations to their owner: the environment service alone never terminates them', async () => {
    const harness = build();
    harness.operations.create({ id: 'op-00000000000000ac', kind: 'preview', environmentId: ENVIRONMENT_ID, phase: 'planning', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    await harness.service.recover();
    // Ownership: the environment recovery does not own `preview`.
    expect(harness.operations.read('op-00000000000000ac')?.status).toBe('running');
    expect(harness.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(GEN1);
  });

  it('keeps the environment when an apply operation was orphaned before any journal existed', async () => {
    const harness = build();
    const before = harness.environments.read(ENVIRONMENT_ID)!;
    harness.operations.create({ id: 'op-00000000000000ad', kind: 'apply', environmentId: ENVIRONMENT_ID, phase: 'planned', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    new IdempotencyStore(harness.layout).write('req-orphan-apply', { state: 'in-progress', method: 'changes.apply', fingerprint: '{"x":1}' });

    const { applyRecovery } = await recoverAll(harness);

    expect(harness.environments.read(ENVIRONMENT_ID)).toEqual(before);
    expect(harness.operations.read('op-00000000000000ad')?.status).toBe('failed');
    expect(applyRecovery.rolledBack).toBeGreaterThanOrEqual(1);
    const ledger = new IdempotencyStore(harness.layout).read('req-orphan-apply');
    expect(ledger?.state).toBe('completed');
    if (ledger?.state === 'completed') expect(ledger.outcome.ok).toBe(false);
  });

  it('converges a pre-commit apply journal without losing the active generation', async () => {
    const harness = build();
    const before = harness.environments.read(ENVIRONMENT_ID)!;
    writeGeneration(harness.layout, GEN2, 'b'.repeat(64));
    harness.operations.create({ id: 'op-0000000000000001', kind: 'apply', environmentId: ENVIRONMENT_ID, phase: 'verified', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    writeJournal(harness, applyJournal());

    const { applyRecovery } = await recoverAll(harness);

    expect(harness.environments.read(ENVIRONMENT_ID)).toEqual(before);
    expect(harness.operations.read('op-0000000000000001')?.status).toBe('failed');
    expect(applyRecovery.rolledBack).toBeGreaterThanOrEqual(1);
  });

  it('rolls forward a committed apply journal and keeps the new generation active', async () => {
    const harness = build();
    writeGeneration(harness.layout, GEN2, 'b'.repeat(64));
    harness.operations.create({ id: 'op-0000000000000002', kind: 'apply', environmentId: ENVIRONMENT_ID, phase: 'committed', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    writeJournal(harness, applyJournal({ transactionId: 'txn-0000000000000002', operationId: 'op-0000000000000002', phase: 'committed' }));
    harness.environments.write({ ...harness.environments.read(ENVIRONMENT_ID)!, activeGenerationId: GEN2, revision: 2, compositionDigest: 'b'.repeat(64) });

    const { applyRecovery } = await recoverAll(harness);

    expect(harness.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(GEN2);
    expect(harness.operations.read('op-0000000000000002')?.status).toBe('succeeded');
    expect(applyRecovery.finalized).toBeGreaterThanOrEqual(1);
  });

  it('discards an unswitched restore journal and keeps the active generation (pointer authoritative)', async () => {
    const harness = build();
    writeGeneration(harness.layout, GEN2, 'b'.repeat(64));
    const before = harness.environments.read(ENVIRONMENT_ID)!;
    harness.operations.create({ id: 'op-0000000000000003', kind: 'restore', environmentId: ENVIRONMENT_ID, phase: 'switching', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    writeJournal(harness, applyJournal({ kind: 'restore', transactionId: 'txn-0000000000000003', operationId: 'op-0000000000000003', generationId: GEN2, planId: '', phase: 'committed' }));

    const { applyRecovery } = await recoverAll(harness);

    // The pointer never moved, so the interrupted restore is discarded and the
    // committed generation stays active.
    expect(harness.environments.read(ENVIRONMENT_ID)).toEqual(before);
    expect(harness.operations.read('op-0000000000000003')?.status).toBe('failed');
    expect(applyRecovery.rolledBack).toBeGreaterThanOrEqual(1);
  });

  it('finalizes a restore journal whose pointer already switched and keeps that generation', async () => {
    const harness = build();
    writeGeneration(harness.layout, GEN2, 'b'.repeat(64));
    harness.operations.create({ id: 'op-0000000000000004', kind: 'restore', environmentId: ENVIRONMENT_ID, phase: 'switching', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    writeJournal(harness, applyJournal({ kind: 'restore', transactionId: 'txn-0000000000000004', operationId: 'op-0000000000000004', generationId: GEN1, planId: '', phase: 'committed' }));

    const { applyRecovery } = await recoverAll(harness);

    expect(harness.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(GEN1);
    expect(harness.operations.read('op-0000000000000004')?.status).toBe('succeeded');
    expect(applyRecovery.finalized).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent on a second recovery pass (failed re-entry)', async () => {
    const harness = build();
    harness.operations.create({ id: 'op-00000000000000ae', kind: 'preview', environmentId: ENVIRONMENT_ID, phase: 'planning', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    await recoverAll(harness);
    const snapshot = harness.environments.read(ENVIRONMENT_ID)!;

    const second = await recoverAll(harness);
    expect(second.applyRecovery).toEqual({ finalized: 0, rolledBack: 0 });
    expect(second.previewRecovery).toEqual({ terminated: 0 });
    expect(harness.environments.read(ENVIRONMENT_ID)).toEqual(snapshot);
  });

  it('keeps the original interrupted-create semantics (environment is failed)', async () => {
    const harness = build('creating');
    harness.environments.write({ ...harness.environments.read(ENVIRONMENT_ID)!, activeGenerationId: null, compositionDigest: null });
    harness.operations.create({ id: 'op-00000000000000af', kind: 'create', environmentId: ENVIRONMENT_ID, phase: 'installing', status: 'running', createdAt: '2026-09-22T00:05:00.000Z' });
    await recoverAll(harness);
    const after = harness.environments.read(ENVIRONMENT_ID)!;
    expect(after.state).toBe('error');
    expect(after.activeGenerationId).toBeNull();
    expect(harness.operations.read('op-00000000000000af')?.status).toBe('failed');
  });
});
