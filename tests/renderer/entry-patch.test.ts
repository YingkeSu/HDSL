/**
 * #135 E1-T1: renderer desired-config entry patch panel and controller.
 *
 * Controller semantics run against the TEST-ONLY reference runtime; the markup
 * test renders the real component with `react-dom/server`. Neither is evidence
 * about a real managed DSH process or Electron. The copy assertions enforce the
 * hard rule: a saved desired config is shown as "已保存 / 等待 DSH 应用（未确认
 * ACTIVE）" and never as a runtime effect.
 */
import { entryPatchResultSchema, type ContractResponse, type EntryPatchResult } from '@hdsl/contracts';
import { FIXTURE_IDS, FIXTURE_SEED } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import { renderEntryPatch } from '../../apps/desktop/src/renderer/testing/render-markup.js';
import { INITIAL_STATE, type RendererActions } from '../../apps/desktop/src/renderer/view-model.js';
import {
  createDeferred,
  createStubRendererClient,
  createTestRendererClient,
  stubOk,
} from './support/contract-client.js';

const noopActions: RendererActions = {
  load: () => undefined,
  refresh: () => undefined,
  setCreateName: () => undefined,
  setCreateCombinationId: () => undefined,
  createEnvironment: () => undefined,
  clearCreateError: () => undefined,
  selectEnvironment: () => undefined,
  startSelected: () => undefined,
  stopSelected: () => undefined,
  openWebUI: () => undefined,
  exportDiagnostics: () => undefined,
  cancelTrackedOperation: () => undefined,
  retryTracking: () => undefined,
  setPluginQuery: () => undefined,
  resetPluginQuery: () => undefined,
  runPluginSearch: () => undefined,
  inspectSelectedPlugin: () => undefined,
  selectPlugin: () => undefined,
  cancelPluginSearch: () => undefined,
  setInstallSource: () => undefined,
  previewPluginChange: () => undefined,
  setBuildAuthorizationConfirmed: () => undefined,
  applyPluginChange: () => undefined,
  cancelInstallOperation: () => undefined,
  loadGenerations: () => undefined,
  restoreGeneration: () => undefined,
  loadInstalledPlugins: () => undefined,
  selectInstalledPlugin: () => undefined,
  previewPluginRemoval: () => undefined,
  loadDshVersions: () => undefined,
  switchVersion: () => undefined,
  loadExpectedComposition: () => undefined,
  setEntryPatchRowId: () => undefined,
  setEntryPatchConfigText: () => undefined,
  patchEntry: () => undefined,
  restartSelected: () => undefined,
};

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const RESULT: EntryPatchResult = {
  environmentId: FIXTURE_IDS.environment.running,
  operation: 'disable',
  saved: true,
  runtime: 'pending',
  runtimeVerification: 'unavailable',
  activation: 'live-reload-unverified',
  restartRequired: false,
  reloadMode: 'live',
  rows: [
    {
      id: 'timer',
      kind: 'insert',
      name: '@deepseek-ai/cordis-plugin-timer',
      nameKnown: true,
      disabled: true,
      hasConfig: false,
    },
  ],
  diagnostics: [],
};

describe('RendererController entries.patch', () => {
  it('dispatches entries.patch for the selected environment and stores the saved result', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.setEntryPatchRowId('timer');
    await controller.patchEntry('disable');
    await flush();

    const sent = calls.find((call) => call.method === 'entries.patch');
    expect(sent).toBeDefined();
    const input = sent?.input as {
      requestId?: unknown;
      environmentId?: unknown;
      operation?: unknown;
    };
    expect(typeof input.requestId).toBe('string');
    expect(input.environmentId).toBe(FIXTURE_IDS.environment.running);
    expect(input.operation).toEqual({ kind: 'disable', rowId: 'timer' });

    const result = controller.getState().entryPatchResult;
    expect(result).not.toBeNull();
    expect(result?.saved).toBe(true);
    expect(result?.runtime).toBe('pending');
    expect(result?.runtimeVerification).toBe('unavailable');
    expect(result?.environmentId).toBe(FIXTURE_IDS.environment.running);
    await controller.dispose();
  });

  it('fails loud on invalid config JSON without dispatching or touching the patch file', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.setEntryPatchRowId('timer');
    controller.setEntryPatchConfigText('{ not json');
    await controller.patchEntry('config');
    await flush();

    expect(calls.filter((call) => call.method === 'entries.patch')).toHaveLength(0);
    expect(controller.getState().actionError?.code).toBe('INVALID_INPUT');
    expect(controller.getState().entryPatchResult).toBeNull();
    await controller.dispose();
  });

  it('requires a row id and carries a config value only for the config operation', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.setEntryPatchRowId('timer');
    controller.setEntryPatchConfigText('{"interval":500}');
    await controller.patchEntry('config');
    await flush();
    const sent = calls.find((call) => call.method === 'entries.patch');
    const operation = (sent?.input as { operation?: unknown }).operation;
    expect(operation).toEqual({ kind: 'config', rowId: 'timer', config: { interval: 500 } });

    controller.setEntryPatchRowId('   ');
    const before = calls.filter((call) => call.method === 'entries.patch').length;
    await controller.patchEntry('disable');
    await flush();
    expect(calls.filter((call) => call.method === 'entries.patch')).toHaveLength(before);
    expect(controller.getState().actionError?.code).toBe('INVALID_INPUT');
    await controller.dispose();
  });

  it('discards an in-flight result after the user switches environments', async () => {
    const envA = FIXTURE_SEED.environments[0];
    const envB = FIXTURE_SEED.environments[1];
    if (envA === undefined || envB === undefined) throw new Error('fixtures required');
    const deferred = createDeferred<ContractResponse<unknown>>();
    const { client } = createStubRendererClient((method) => {
      if (method === 'environments.list') return stubOk([envA, envB]);
      if (method === 'catalog.list') return stubOk([]);
      if (method === 'entries.patch') return deferred.promise;
      return stubOk(null);
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(envA.id);
    controller.setEntryPatchRowId('timer');
    const pending = controller.patchEntry('disable');
    await flush();
    controller.selectEnvironment(envB.id);
    deferred.resolve(stubOk({ ...RESULT, environmentId: envA.id }));
    await pending;
    expect(controller.getState().selectedEnvironmentId).toBe(envB.id);
    expect(controller.getState().entryPatchResult).toBeNull();
    await controller.dispose();
  });

  it('clears the entry patch state when the selected environment changes', async () => {
    const { client } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.setEntryPatchRowId('timer');
    await controller.patchEntry('disable');
    await flush();
    expect(controller.getState().entryPatchResult).not.toBeNull();
    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);
    expect(controller.getState().entryPatchResult).toBeNull();
    expect(controller.getState().entryPatchRowId).toBe('');
    await controller.dispose();
  });
});

describe('RendererController restart fallback', () => {
  it('starts a stopped environment directly', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);
    await controller.restartSelected();
    await flush();
    expect(calls.some((call) => call.method === 'environments.start')).toBe(true);
    expect(calls.some((call) => call.method === 'environments.stop')).toBe(false);
    await controller.dispose();
  });

  it('stops a running environment and starts it again once THAT stop succeeds, with a visible notice', async () => {
    const { client, calls } = createStubRendererClient((method, input) => {
      if (method === 'environments.list') return stubOk(FIXTURE_SEED.environments);
      if (method === 'catalog.list') return stubOk([]);
      if (method === 'environments.stop') return stubOk({ operationId: 'op-stop-1' });
      if (method === 'environments.start') return stubOk({ operationId: 'op-start' });
      if (method === 'operations.get') {
        const operationId = (input as { operationId?: string }).operationId;
        return stubOk({
          id: operationId,
          environmentId: FIXTURE_IDS.environment.running,
          kind: operationId === 'op-stop-1' ? 'stop' : 'start',
          phase: 'finished',
          status: 'succeeded',
          sequence: 1,
        });
      }
      if (method === 'operations.subscribe') return stubOk({ subscriptionId: 'sub-1' });
      if (method === 'operations.unsubscribe') return stubOk(null);
      return stubOk(null);
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(FIXTURE_IDS.environment.running);
    await controller.restartSelected();
    await flush();
    await flush();
    expect(calls.some((call) => call.method === 'environments.stop')).toBe(true);
    expect(calls.some((call) => call.method === 'environments.start')).toBe(true);
    expect(controller.getState().restartAfterStopOperationId).toBeNull();
    // The restart notice is actually visible after the fallback starts.
    expect(controller.getState().notice).toContain('正在启动环境以应用已保存的期望配置');
    await controller.dispose();
  });

  it('does not start after the bound stop fails, and a later plain successful stop still does not start', async () => {
    let stopCount = 0;
    const { client, calls } = createStubRendererClient((method, input) => {
      if (method === 'environments.list') return stubOk(FIXTURE_SEED.environments);
      if (method === 'catalog.list') return stubOk([]);
      if (method === 'environments.stop') {
        stopCount += 1;
        return stubOk({ operationId: `op-stop-${String(stopCount)}` });
      }
      if (method === 'environments.start') return stubOk({ operationId: 'op-start' });
      if (method === 'operations.get') {
        const operationId = (input as { operationId?: string }).operationId;
        if (operationId === 'op-stop-1') {
          return stubOk({
            id: operationId,
            environmentId: FIXTURE_IDS.environment.running,
            kind: 'stop',
            phase: 'failed',
            status: 'failed',
            sequence: 1,
            error: { code: 'PROCESS_EXITED', message: 'stop failed', retryable: true },
          });
        }
        return stubOk({
          id: operationId,
          environmentId: FIXTURE_IDS.environment.running,
          kind: 'stop',
          phase: 'finished',
          status: 'succeeded',
          sequence: 1,
        });
      }
      if (method === 'operations.subscribe') return stubOk({ subscriptionId: 'sub-1' });
      if (method === 'operations.unsubscribe') return stubOk(null);
      return stubOk(null);
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(FIXTURE_IDS.environment.running);
    await controller.restartSelected();
    await flush();
    await flush();
    // The bound stop failed: the intent is consumed, not kept for a later stop.
    expect(controller.getState().restartAfterStopOperationId).toBeNull();
    expect(calls.filter((call) => call.method === 'environments.start')).toHaveLength(0);

    // A plain stop that later succeeds must NOT auto-start the environment.
    await controller.stopSelected();
    await flush();
    await flush();
    expect(calls.filter((call) => call.method === 'environments.stop')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'environments.start')).toHaveLength(0);
    await controller.dispose();
  });

  it('does not start when the bound stop is cancelled', async () => {
    const { client, calls } = createStubRendererClient((method, input) => {
      if (method === 'environments.list') return stubOk(FIXTURE_SEED.environments);
      if (method === 'catalog.list') return stubOk([]);
      if (method === 'environments.stop') return stubOk({ operationId: 'op-stop-1' });
      if (method === 'environments.start') return stubOk({ operationId: 'op-start' });
      if (method === 'operations.get') {
        return stubOk({
          id: (input as { operationId?: string }).operationId,
          environmentId: FIXTURE_IDS.environment.running,
          kind: 'stop',
          phase: 'stopping',
          status: 'running',
          sequence: 1,
        });
      }
      if (method === 'operations.cancel') {
        return stubOk({
          id: (input as { operationId?: string }).operationId,
          environmentId: FIXTURE_IDS.environment.running,
          kind: 'stop',
          phase: 'cancelled',
          status: 'cancelled',
          sequence: 2,
        });
      }
      if (method === 'operations.subscribe') return stubOk({ subscriptionId: 'sub-1' });
      if (method === 'operations.unsubscribe') return stubOk(null);
      return stubOk(null);
    });
    const controller = new RendererController({ client, pollIntervalMs: 100_000 });
    await controller.load();
    controller.selectEnvironment(FIXTURE_IDS.environment.running);
    await controller.restartSelected();
    await flush();
    expect(controller.getState().restartAfterStopOperationId).toBe('op-stop-1');
    await controller.cancelTrackedOperation();
    await flush();
    expect(controller.getState().restartAfterStopOperationId).toBeNull();
    expect(calls.filter((call) => call.method === 'environments.start')).toHaveLength(0);
    await controller.dispose();
  });

  it('does not restart when the pending bound stop completes after an environment switch', async () => {
    const envA = FIXTURE_SEED.environments[0];
    const envB = FIXTURE_SEED.environments[1];
    if (envA === undefined || envB === undefined) throw new Error('fixtures required');
    const deferred = createDeferred<ContractResponse<unknown>>();
    const { client, calls } = createStubRendererClient((method) => {
      if (method === 'environments.list') return stubOk([envA, envB]);
      if (method === 'catalog.list') return stubOk([]);
      if (method === 'environments.stop') return stubOk({ operationId: 'op-stop-1' });
      if (method === 'environments.start') return stubOk({ operationId: 'op-start' });
      if (method === 'operations.get') return deferred.promise;
      if (method === 'operations.subscribe') return stubOk({ subscriptionId: 'sub-1' });
      if (method === 'operations.unsubscribe') return stubOk(null);
      return stubOk(null);
    });
    const controller = new RendererController({ client, pollIntervalMs: 100_000 });
    await controller.load();
    controller.selectEnvironment(envA.id);
    const pending = controller.restartSelected();
    await flush();
    expect(controller.getState().restartAfterStopOperationId).toBe('op-stop-1');
    controller.selectEnvironment(envB.id);
    deferred.resolve(
      stubOk({
        id: 'op-stop-1',
        environmentId: envA.id,
        kind: 'stop',
        phase: 'finished',
        status: 'succeeded',
        sequence: 1,
      }),
    );
    await pending;
    await flush();
    expect(controller.getState().selectedEnvironmentId).toBe(envB.id);
    expect(calls.filter((call) => call.method === 'environments.start')).toHaveLength(0);
    await controller.dispose();
  });
});

describe('EntryPatch markup', () => {
  it('renders the saved/awaiting copy and never an ACTIVE claim', () => {
    const html = renderEntryPatch({
      state: {
        ...INITIAL_STATE,
        environments: FIXTURE_SEED.environments,
        selectedEnvironmentId: FIXTURE_IDS.environment.running,
        entryPatchResult: RESULT,
      },
      actions: noopActions,
    });
    expect(html).toContain('已保存');
    expect(html).toContain('等待 DSH 应用');
    expect(html).toContain('未确认 ACTIVE');
    expect(html).toContain('live-reload-unverified');
    expect(html).toContain('显式重启环境');
    expect(html).not.toContain('已生效');
    expect(html).not.toContain('已加载');
    // The DTO validator round-trips, so the shape the panel renders is the
    // frozen terminal payload.
    expect(entryPatchResultSchema(RESULT, 'value', [])).toBeDefined();
  });

  it('renders an explainable error and no result when nothing has been saved yet', () => {
    const html = renderEntryPatch({
      state: {
        ...INITIAL_STATE,
        environments: FIXTURE_SEED.environments,
        selectedEnvironmentId: FIXTURE_IDS.environment.stopped,
        actionError: { code: 'INVALID_INPUT', message: 'the patch file must be a top-level YAML array', retryable: false },
      },
      actions: noopActions,
    });
    expect(html).toContain('INVALID_INPUT');
    expect(html).toContain('top-level YAML array');
    expect(html).toContain('已保存');
  });

  it('renders nothing when no environment is selected', () => {
    const html = renderEntryPatch({
      state: { ...INITIAL_STATE, selectedEnvironmentId: null },
      actions: noopActions,
    });
    expect(html).toBe('');
  });
});
