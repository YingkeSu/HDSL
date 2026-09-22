/**
 * Renderer plugin install flow (issue #76, S2): direct repo input -> preview ->
 * confirm -> apply, against the TEST-ONLY reference runtime. Not evidence about
 * real GitHub or Electron behavior.
 */
import { describe, expect, it } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import { createStubRendererClient, createTestRendererClient, stubFail, stubOk } from './support/contract-client.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

describe('RendererController plugin install', () => {
  it('previews with the exact source and revision, then applies the returned plan', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    const stopped = controller.getState().environments.find((environment) => environment.state === 'stopped');
    expect(stopped).toBeDefined();
    if (stopped === undefined) {
      return;
    }
    controller.selectEnvironment(stopped.id);
    controller.setInstallSource('owner', 'octo');
    controller.setInstallSource('name', 'dsh-plugin-demo');
    controller.setInstallSource('ref', 'main');

    await controller.previewPluginChange();
    await flush();
    const preview = calls.find((call) => call.method === 'changes.preview');
    expect(preview?.input).toMatchObject({
      environmentId: stopped.id,
      expectedRevision: stopped.revision,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo', ref: 'main' } },
    });
    const plan = controller.getState().changePlan;
    expect(plan).not.toBeNull();
    expect(plan?.sourceLock?.commitSha).toHaveLength(40);

    await controller.applyPluginChange();
    await flush();
    const apply = calls.find((call) => call.method === 'changes.apply');
    expect(apply?.input).toMatchObject({
      environmentId: stopped.id,
      expectedRevision: stopped.revision,
      planId: plan?.planId,
    });
    expect(controller.getState().changeApplication).not.toBeNull();

    await controller.dispose();
  });
});

describe('RendererController generation restore', () => {
  it('loads the generation list and issues a pointer-only restore for a non-active generation', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    const stopped = controller.getState().environments.find((environment) => environment.state === 'stopped');
    if (stopped === undefined) {
      return;
    }
    controller.selectEnvironment(stopped.id);
    await controller.loadGenerations();
    await flush();
    const listCall = calls.find((call) => call.method === 'generations.list');
    expect(listCall?.input).toMatchObject({ environmentId: stopped.id });

    await controller.restoreGeneration('gen-0000000000000002');
    await flush();
    const restoreCall = calls.find((call) => call.method === 'generations.restore');
    expect(restoreCall?.input).toMatchObject({
      environmentId: stopped.id,
      targetGenerationId: 'gen-0000000000000002',
    });
    await controller.dispose();
  });
});

/**
 * QA33 real desktop chain: a terminal `failed`/`cancelled` preview must be
 * surfaced. Previously `#completeTracking` only handled `succeeded`, so the S2
 * panel kept showing "正在解析来源并生成计划…" with no error.
 */
const PREVIEW_ENVIRONMENT = {
  id: 'env-1',
  name: 'S2 环境',
  revision: 3,
  stateVersion: 1,
  state: 'stopped',
  activeGenerationId: 'gen-1',
  compositionDigest: 'a'.repeat(64),
};

const previewClient = (snapshot: unknown) =>
  createStubRendererClient((method) => {
    switch (method) {
      case 'catalog.list':
        return stubOk([]);
      case 'environments.list':
        return stubOk([PREVIEW_ENVIRONMENT]);
      case 'changes.preview':
        return stubOk({ operationId: 'op-preview-1' });
      case 'operations.get':
        return stubOk(snapshot);
      case 'operations.subscribe':
        return stubOk({ subscriptionId: 'sub-1' });
      case 'operations.unsubscribe':
        return stubOk(null);
      default:
        return stubFail('INTERNAL_ERROR');
    }
  });

describe('RendererController plugin operation terminal status (QA33 regression)', () => {
  it('surfaces a failed preview as a controlled error instead of staying in progress', async () => {
    const { client } = previewClient({
      id: 'op-preview-1',
      environmentId: 'env-1',
      kind: 'preview',
      phase: 'failed',
      status: 'failed',
      sequence: 2,
      error: { code: 'EXECUTOR_UNAVAILABLE', message: 'the managed executor is unavailable', retryable: false },
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-1');
    controller.setInstallSource('owner', 'octo');
    controller.setInstallSource('name', 'dsh-plugin-demo');
    await controller.previewPluginChange();
    await flush();
    const state = controller.getState();
    expect(state.trackedOperation?.status).toBe('failed');
    expect(state.actionError?.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(state.changePlan).toBeNull();
    await controller.dispose();
  });

  it('records a cancelled preview as a notice, not an error', async () => {
    const { client } = previewClient({
      id: 'op-preview-1',
      environmentId: 'env-1',
      kind: 'preview',
      phase: 'cancelled',
      status: 'cancelled',
      sequence: 2,
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-1');
    controller.setInstallSource('owner', 'octo');
    controller.setInstallSource('name', 'dsh-plugin-demo');
    await controller.previewPluginChange();
    await flush();
    const state = controller.getState();
    expect(state.trackedOperation?.status).toBe('cancelled');
    expect(state.notice).not.toBeNull();
    expect(state.actionError).toBeNull();
    await controller.dispose();
  });
});

/**
 * S4 (issue #78): the renderer must never send a build authorization that the
 * user did not explicitly confirm, and when it does send one it is derived from
 * the confirmed plan's exact commit and enumerated script set only.
 */
const BUILD_COMMIT = 'e'.repeat(40);
const BUILD_SCRIPTS = [
  { packageName: 's4-fixture-root', packageVersion: '0.0.1', script: 'preinstall', source: 'root' },
  { packageName: 's4-fixture-gitdep', packageVersion: '0.0.1', script: 'prepare', source: 'dependency' },
] as const;

const detectedPlan = {
  planId: 'plan-0000000000000002',
  environmentId: 'env-1',
  baseRevision: 3,
  action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
  createdAt: '2026-09-22T00:00:00.000Z',
  expiresAt: '2026-09-22T00:15:00.000Z',
  sourceLock: {
    sourceKind: 'github',
    repository: { owner: 'octo', name: 'dsh-plugin-demo' },
    commitSha: BUILD_COMMIT,
    ref: null,
    packageName: 'dsh-plugin-demo',
    packageVersion: '1.0.0',
    manifestSha256: 'a'.repeat(64),
    closureLockSha256: 'b'.repeat(64),
    isBuiltin: false,
    buildAuthorization: null,
    executor: null,
  },
  scriptAssessment: 'detected',
  scripts: [...BUILD_SCRIPTS],
  requiresBuildAuthorization: true,
  riskItems: [],
  removals: [],
  retention: [],
  blockingReferences: [],
  executor: null,
  planInputsDigest: 'c'.repeat(64),
};

const detectedPlanClient = () =>
  createStubRendererClient((method, input) => {
    switch (method) {
      case 'catalog.list':
        return stubOk([]);
      case 'environments.list':
        return stubOk([PREVIEW_ENVIRONMENT]);
      case 'changes.preview':
        return stubOk({ operationId: 'op-preview-auth' });
      case 'changes.apply':
        return stubOk({ operationId: 'op-apply-auth' });
      case 'operations.get': {
        const id = (input as { operationId?: string }).operationId;
        return stubOk({
          id: id ?? 'op-preview-auth',
          environmentId: 'env-1',
          kind: 'preview',
          phase: 'finished',
          status: 'succeeded',
          sequence: 2,
          output: detectedPlan,
        });
      }
      case 'operations.subscribe':
        return stubOk({ subscriptionId: 'sub-auth' });
      case 'operations.unsubscribe':
        return stubOk(null);
      default:
        return stubFail('INTERNAL_ERROR');
    }
  });

describe('RendererController S4 build authorization', () => {
  const previewDetected = async (controller: RendererController): Promise<void> => {
    controller.selectEnvironment('env-1');
    controller.setInstallSource('owner', 'octo');
    controller.setInstallSource('name', 'dsh-plugin-demo');
    await controller.previewPluginChange();
    await flush();
  };

  it('sends NO authorization unless the user explicitly confirmed, then sends the exact plan binding', async () => {
    const { client, calls } = detectedPlanClient();
    const controller = new RendererController({ client });
    await controller.load();
    await previewDetected(controller);
    expect(controller.getState().changePlan?.requiresBuildAuthorization).toBe(true);
    expect(controller.getState().buildAuthorizationConfirmed).toBe(false);

    await controller.applyPluginChange();
    await flush();
    const unconfirmed = calls.filter((call) => call.method === 'changes.apply');
    expect(unconfirmed).toHaveLength(1);
    expect((unconfirmed[0]?.input as { buildAuthorization?: unknown }).buildAuthorization).toBeUndefined();

    controller.setBuildAuthorizationConfirmed(true);
    await controller.applyPluginChange();
    await flush();
    const confirmed = calls.filter((call) => call.method === 'changes.apply');
    expect(confirmed).toHaveLength(2);
    expect((confirmed[1]?.input as { buildAuthorization?: unknown }).buildAuthorization).toEqual({
      commitSha: BUILD_COMMIT,
      scripts: [...BUILD_SCRIPTS],
    });
    await controller.dispose();
  });

  it('resets the acknowledgement whenever the preview input changes', async () => {
    const { client } = detectedPlanClient();
    const controller = new RendererController({ client });
    await controller.load();
    await previewDetected(controller);
    controller.setBuildAuthorizationConfirmed(true);
    expect(controller.getState().buildAuthorizationConfirmed).toBe(true);
    controller.setInstallSource('ref', 'v2');
    expect(controller.getState().changePlan).toBeNull();
    expect(controller.getState().buildAuthorizationConfirmed).toBe(false);
    await controller.dispose();
  });
});
