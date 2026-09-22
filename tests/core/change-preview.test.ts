/**
 * Core `changes.preview` lifecycle + ChangePlan store guards (ADR 0005 D5/D6/D8).
 *
 * The injected preview port is a fixture; core owns the operation lifecycle, the
 * plan TTL, the durable plan store and the consumption marker.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangePlanStore,
  ChangePreviewService,
  generationPaths,
  resolveLayout,
  type PluginPreviewPort,
  type PluginPreviewResolution,
} from '@hdsl/core';
import type { ChangePlan, EnvironmentSummary, PortOutcome } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';

const environment = (revision: number): EnvironmentSummary => ({
  id: ENVIRONMENT_ID,
  name: 'preview-env',
  revision,
  stateVersion: 1,
  state: 'stopped',
  activeGenerationId: 'gen-0000000000000001',
  compositionDigest: 'a'.repeat(64),
});

const resolution = (): PluginPreviewResolution => ({
  sourceLock: {
    sourceKind: 'github',
    repository: { owner: 'octo', name: 'dsh-plugin-demo' },
    commitSha: 'b'.repeat(40),
    ref: 'main',
    packageName: 'dsh-plugin-demo',
    packageVersion: '1.0.0',
    manifestSha256: 'c'.repeat(64),
    closureLockSha256: 'd'.repeat(64),
    isBuiltin: false,
    buildAuthorization: null,
    executor: null,
  },
  scripts: [],
  scriptAssessment: 'none-detected',
  requiresBuildAuthorization: false,
  riskItems: ['no install-time scripts detected in the parsed closure'],
  executor: { id: 'pnpm', version: '11.7.0', sha256: 'e'.repeat(64), entrySha256: '1'.repeat(64), treeSha256: '2'.repeat(64) },
  planInputsDigest: 'f'.repeat(64),
  targetLockText: null,
  targetDeclarationText: null,
  targetWorkspaceText: null,
  targetDeclarationSha256: null,
});

const port = (overrides: Partial<PluginPreviewPort> = {}): PluginPreviewPort => ({
  previewSource: async (): Promise<PortOutcome<PluginPreviewResolution>> => ({
    ok: true,
    value: resolution(),
  }),
  ...overrides,
});

const build = (portImpl: PluginPreviewPort = port(), revision = 3, ttlMs = 60_000) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-preview-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  const service = new ChangePreviewService({
    layout,
    port: portImpl,
    findEnvironment: (id) => (id === ENVIRONMENT_ID ? environment(revision) : undefined),
    now: () => new Date('2026-09-22T00:00:00.000Z'),
    ttlMs,
  });
  return { layout, service };
};

const waitTerminal = async (service: ChangePreviewService, operationId: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const record = service.findOperation(operationId);
    if (record?.ok && ['succeeded', 'failed', 'cancelled'].includes(record.value.status)) {
      return record.value;
    }
    if (Date.now() > deadline) {
      throw new Error('preview did not reach a terminal state');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('changes.preview (core)', () => {
  it('produces a durable ChangePlan on the operation output with a TTL', async () => {
    const { layout, service } = build();
    const started = service.previewChange({
      requestId: 'req-preview',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo', ref: 'main' } },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const snapshot = await waitTerminal(service, started.value.operationId);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    expect(plan.baseRevision).toBe(3);
    expect(plan.createdAt).toBe('2026-09-22T00:00:00.000Z');
    expect(plan.expiresAt).toBe('2026-09-22T00:01:00.000Z');
    expect(plan.scriptAssessment).toBe('none-detected');
    expect(plan.requiresBuildAuthorization).toBe(false);
    expect(plan.sourceLock?.commitSha).toBe('b'.repeat(40));
    expect(plan.planInputsDigest).toBe('f'.repeat(64));

    const stored = new ChangePlanStore(layout).read(plan.planId);
    expect(stored?.consumedBy).toBeNull();
    expect(stored?.plan.planId).toBe(plan.planId);
  });

  it('rejects a revision conflict without starting an operation', () => {
    const { service } = build();
    const started = service.previewChange({
      requestId: 'req-conflict',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 999,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    });
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.code).toBe('REVISION_CONFLICT');
    }
  });

  it('rejects an unknown environment and the unimplemented remove action', () => {
    const { service } = build();
    const unknown = service.previewChange({
      requestId: 'req-unknown',
      environmentId: 'env-ffffffffffffffff',
      expectedRevision: 3,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe('NOT_FOUND');
    }
    const remove = service.previewChange({
      requestId: 'req-remove',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      action: { kind: 'remove', pluginId: 'dsh-plugin-demo' },
    });
    expect(remove.ok).toBe(false);
    if (!remove.ok) {
      // Remove belongs to S3: a controlled rejection, not an internal-error fake.
      expect(remove.code).toBe('UNSUPPORTED_COMBINATION');
    }
  });

  it('cancels an in-flight preview as a terminal cancelled operation with no plan', async () => {
    let release: (() => void) | undefined;
    const blocked = port({
      previewSource: async (_source, signal) =>
        new Promise((resolve) => {
          release = () =>
            resolve(signal.aborted ? { ok: false, code: 'INTERNAL_ERROR', message: 'aborted' } : { ok: true, value: resolution() });
        }),
    });
    const { layout, service } = build(blocked);
    const started = service.previewChange({
      requestId: 'req-cancel',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    const cancelled = service.cancelOperation(started.value.operationId);
    expect(cancelled?.ok).toBe(true);
    if (cancelled?.ok) {
      expect(cancelled.value.status).toBe('cancelled');
    }
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = await waitTerminal(service, started.value.operationId);
    expect(after.status).toBe('cancelled');
    expect(new ChangePlanStore(layout).list()).toHaveLength(0);
  });

  it('records and replays a consumption marker through the durable plan store', async () => {
    const { layout, service } = build();
    const started = service.previewChange({
      requestId: 'req-consume',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    });
    if (!started.ok) {
      return;
    }
    const snapshot = await waitTerminal(service, started.value.operationId);
    const plan = snapshot.output as ChangePlan;
    const store = new ChangePlanStore(layout);
    expect(store.consume(plan.planId, 'req-apply-1')?.consumedBy).toBe('req-apply-1');
    // Replaying the same request is idempotent; a different one is observable.
    expect(store.consume(plan.planId, 'req-apply-1')?.consumedBy).toBe('req-apply-1');
    expect(store.consume(plan.planId, 'req-apply-2')?.consumedBy).toBe('req-apply-2');
    expect(store.read('plan-unknown')?.plan).toBeUndefined();
  });
});

describe('target-profile preview context (QA33 real desktop hang regression)', () => {
  it('passes the current generation managed Node to the port, never process.execPath', async () => {
    const contexts: Array<{ declarationDirectory: string; stagingDirectory: string; nodeExecutable: string } | undefined> = [];
    const capturing: PluginPreviewPort = {
      previewSource: async (_source, _signal, context) => {
        contexts.push(context);
        return { ok: true, value: resolution() };
      },
    };
    const { layout, service } = build(capturing);
    const started = service.previewChange({
      requestId: 'req-preview-context',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    });
    if (!started.ok) throw new Error('preview was not started');
    await waitTerminal(service, started.value.operationId);
    expect(contexts).toHaveLength(1);
    const context = contexts[0];
    expect(context).toBeDefined();
    if (context === undefined) return;
    const generationDirectory = generationPaths(layout, ENVIRONMENT_ID, 'gen-0000000000000001').generationDirectory;
    expect(context.nodeExecutable).toBe(join(generationDirectory, 'node', 'bin', 'node'));
    expect(context.declarationDirectory).toBe(join(generationDirectory, 'profile'));
    // The host process binary is never the preview resolution runtime.
    expect(context.nodeExecutable).not.toBe(process.execPath);
  });

  it('terminates as a controlled failed operation when the resolution runtime is unavailable (no permanent running)', async () => {
    const failing: PluginPreviewPort = {
      previewSource: async () => ({ ok: false, code: 'INTERNAL_ERROR', message: 'the managed Node executable for target-profile resolution does not exist' }),
    };
    const { service } = build(failing);
    const started = service.previewChange({
      requestId: 'req-preview-fail',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    });
    if (!started.ok) throw new Error('preview was not started');
    const snapshot = await waitTerminal(service, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('INTERNAL_ERROR');
  });
});
