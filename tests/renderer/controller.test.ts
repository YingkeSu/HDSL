/**
 * Renderer controller behavior (T006a).
 *
 * The controller is exercised against the frozen contract (via the TEST-ONLY
 * reference runtime) plus targeted stubs for states the reference port cannot
 * produce. These are unit tests for renderer semantics — they are not DSH or
 * Electron acceptance.
 */
import {
  API_VERSION,
  CONTRACT_METHODS,
  REQUEST_ID_PATTERN,
  type EnvironmentSummary,
  type OperationSnapshot,
  type OperationUpdatedEvent,
} from '@hdsl/contracts';
import { FIXTURE_SEED } from '@hdsl/contracts/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RendererController, type RendererEventSource } from '../../apps/desktop/src/renderer/controller.js';
import type { RendererContractClient } from '../../apps/desktop/src/renderer/contract.js';
import {
  createStubRendererClient,
  createTestRendererClient,
  stubFail,
  stubOk,
} from './support/contract-client.js';

const environmentSummary = (
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary => ({
  id: 'env-1',
  name: 'Env 1',
  revision: 1,
  stateVersion: 1,
  state: 'stopped',
  activeGenerationId: 'gen-1',
  compositionDigest: 'a'.repeat(64),
  ...overrides,
});

const RUNNING_SNAPSHOT: OperationSnapshot = {
  id: 'op-1',
  environmentId: 'env-1',
  kind: 'start',
  phase: 'starting',
  status: 'running',
  sequence: 1,
};

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('RendererController load', () => {
  it('loads the verified catalog and environments and selects the first environment', async () => {
    const { client } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    const state = controller.getState();
    expect(state.phase).toBe('ready');
    expect(state.demo).toBe(false);
    expect(state.environments.map((environment) => environment.id)).toEqual([
      'env-running',
      'env-stopped',
    ]);
    // catalog.list already filters unverified combinations in main.
    expect(state.catalog.map((entry) => entry.id)).toEqual([
      'combo-darwin-arm64',
      'combo-win32-x64',
    ]);
    expect(state.selectedEnvironmentId).toBe('env-running');
    expect(state.createCombinationId).toBe('combo-darwin-arm64');
    await controller.dispose();
  });

  it('maps a transport failure to a controlled INTERNAL_ERROR instead of throwing', async () => {
    const client: RendererContractClient = {
      apiVersion: API_VERSION,
      methods: CONTRACT_METHODS,
      call: () => Promise.reject(new Error('transport down; /Users/secret/path')),
    };
    const controller = new RendererController({ client });
    await controller.load();
    const state = controller.getState();
    expect(state.phase).toBe('failed');
    expect(state.loadError?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(state)).not.toContain('/Users/secret/path');
    await controller.dispose();
  });

  it('rejects a contract version mismatch before showing any data', async () => {
    const client: RendererContractClient = {
      apiVersion: API_VERSION,
      methods: CONTRACT_METHODS,
      call: () => Promise.resolve({ ok: true, apiVersion: '9.9', value: [] }),
    };
    const controller = new RendererController({ client });
    await controller.load();
    expect(controller.getState().loadError?.code).toBe('CONTRACT_VERSION_MISMATCH');
    expect(controller.getState().environments).toEqual([]);
    await controller.dispose();
  });
});

describe('RendererController create', () => {
  it('surfaces the contract INVALID_INPUT for an invalid name without a port effect', async () => {
    const { client, port, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    const effectsBefore = port.effects.length;
    controller.setCreateName('../escape');
    await controller.createEnvironment();
    // The frozen `environments.create` schema is the authority; the renderer just
    // shows the sanitized error and must not apply an effect.
    expect(controller.getState().actionError?.code).toBe('INVALID_INPUT');
    expect(port.effects.length).toBe(effectsBefore);
    expect(calls.some((call) => call.method === 'environments.create')).toBe(true);
    await controller.dispose();
  });

  it('creates an environment with a fresh requestId, tracks the operation and refreshes the list', async () => {
    const { client, port, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.setCreateName('研究环境');
    controller.setCreateCombinationId('combo-darwin-arm64');
    await controller.createEnvironment();
    const state = controller.getState();
    expect(port.effects.some((effect) => effect.startsWith('createEnvironment:'))).toBe(true);
    expect(state.environments.some((environment) => environment.name === '研究环境')).toBe(true);
    expect(state.trackedOperation?.status).toBe('succeeded');
    expect(state.createName).toBe('');
    const createCall = calls.find((call) => call.method === 'environments.create');
    const input = createCall?.input as { requestId?: string; name?: string } | undefined;
    expect(input?.name).toBe('研究环境');
    expect(REQUEST_ID_PATTERN.test(input?.requestId ?? '')).toBe(true);
    await controller.dispose();
  });
});

describe('RendererController start/stop', () => {
  it('sends the composition revision (not stateVersion) when starting a stopped environment', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-stopped');
    await controller.startSelected();
    const startCall = calls.find((call) => call.method === 'environments.start');
    expect(startCall?.input).toMatchObject({
      environmentId: 'env-stopped',
      expectedRevision: 1,
    });
    const refreshed = controller
      .getState()
      .environments.find((environment) => environment.id === 'env-stopped');
    expect(refreshed?.state).toBe('running');
    await controller.dispose();
  });

  it('surfaces ENVIRONMENT_BUSY from the contract when starting a running environment', async () => {
    const { client } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-running');
    await controller.startSelected();
    expect(controller.getState().actionError?.code).toBe('ENVIRONMENT_BUSY');
    await controller.dispose();
  });

  it('unsubscribes as soon as a tracked operation reaches a terminal state', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-stopped');
    await controller.startSelected();
    const subscribeCall = calls.find((call) => call.method === 'operations.subscribe');
    expect(subscribeCall).toBeDefined();
    const unsubscribeCalls = calls.filter((call) => call.method === 'operations.unsubscribe');
    expect(unsubscribeCalls.length).toBeGreaterThan(0);
    await controller.dispose();
  });
});

describe('RendererController WebUI', () => {
  it('shows only the verified loopback origin', async () => {
    const { client } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-running');
    await controller.openWebUI();
    expect(controller.getState().webUIOrigin).toBe('http://127.0.0.1:53123');
    await controller.dispose();
  });

  it('never exposes a token-bearing origin returned by a faulty port', async () => {
    const { client } = createTestRendererClient({
      ...FIXTURE_SEED,
      webUIOriginOverride: 'http://127.0.0.1:53123/?token=canary-token',
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-running');
    await controller.openWebUI();
    const state = controller.getState();
    expect(state.webUIOrigin).toBeNull();
    expect(state.actionError?.code).toBe('WEBUI_UNAVAILABLE');
    expect(JSON.stringify(state)).not.toContain('canary-token');
    await controller.dispose();
  });
});

describe('RendererController diagnostics', () => {
  it('shows only the redacted export summary', async () => {
    const { client } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-running');
    await controller.exportDiagnostics();
    const result = controller.getState().exportResult;
    expect(result).toEqual({ exportId: 'export-1', exported: true, redacted: true });
    await controller.dispose();
  });

  it('maps a failed export to EXPORT_FAILED without a path', async () => {
    const { client } = createTestRendererClient({ ...FIXTURE_SEED, failExport: true });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-running');
    await controller.exportDiagnostics();
    expect(controller.getState().exportResult).toBeNull();
    expect(controller.getState().actionError?.code).toBe('EXPORT_FAILED');
    await controller.dispose();
  });
});

const nonTerminalClient = () =>
  createStubRendererClient((method) => {
    switch (method) {
      case 'catalog.list':
        return stubOk([]);
      case 'environments.list':
        return stubOk([environmentSummary()]);
      case 'environments.start':
        return stubOk({ operationId: 'op-1' });
      case 'operations.get':
        return stubOk(RUNNING_SNAPSHOT);
      case 'operations.subscribe':
        return stubOk({ subscriptionId: 'sub-1' });
      case 'operations.unsubscribe':
        return stubOk(null);
      default:
        return stubFail('INTERNAL_ERROR');
    }
  });

describe('RendererController subscription cleanup', () => {
  it('unsubscribes every live subscription on dispose', async () => {
    const { client, calls } = nonTerminalClient();
    const controller = new RendererController({ client, pollIntervalMs: 1_000_000 });
    await controller.load();
    controller.selectEnvironment('env-1');
    await controller.startSelected();
    expect(controller.getState().trackedOperation?.status).toBe('running');
    await controller.dispose();
    const unsubscribeCalls = calls.filter((call) => call.method === 'operations.unsubscribe');
    expect(unsubscribeCalls.length).toBe(1);
    expect(unsubscribeCalls[0]?.input).toMatchObject({ subscriptionId: 'sub-1' });
  });
});

describe('RendererController polling', () => {
  it('polls operations.get until terminal and then stops', async () => {
    vi.useFakeTimers();
    let getCount = 0;
    const { client, calls } = createStubRendererClient((method) => {
      switch (method) {
        case 'catalog.list':
          return stubOk([]);
        case 'environments.list':
          return stubOk([environmentSummary()]);
        case 'environments.start':
          return stubOk({ operationId: 'op-1' });
        case 'operations.get': {
          getCount += 1;
          if (getCount === 1) {
            return stubOk({ ...RUNNING_SNAPSHOT, progress: 10 });
          }
          return stubOk({
            ...RUNNING_SNAPSHOT,
            phase: 'finished',
            status: 'succeeded',
            sequence: 2,
            progress: 100,
          });
        }
        case 'operations.subscribe':
          return stubOk({ subscriptionId: 'sub-1' });
        case 'operations.unsubscribe':
          return stubOk(null);
        default:
          return stubFail('INTERNAL_ERROR');
      }
    });
    const controller = new RendererController({ client, pollIntervalMs: 100 });
    await controller.load();
    controller.selectEnvironment('env-1');
    await controller.startSelected();
    expect(controller.getState().trackedOperation?.progress).toBe(10);
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.getState().trackedOperation?.status).toBe('succeeded');
    expect(controller.getState().trackedOperation?.progress).toBe(100);
    const pollsSoFar = calls.filter((call) => call.method === 'operations.get').length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.filter((call) => call.method === 'operations.get').length).toBe(pollsSoFar);
    await controller.dispose();
    vi.useRealTimers();
  });
});

describe('RendererController pushed events', () => {
  it('applies increasing sequence updates and ignores stale ones', async () => {
    let listener: ((event: OperationUpdatedEvent) => void) | null = null;
    const events: RendererEventSource = {
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    };
    const { client } = nonTerminalClient();
    const controller = new RendererController({ client, events, pollIntervalMs: 1_000_000 });
    await controller.load();
    controller.selectEnvironment('env-1');
    await controller.startSelected();
    expect(listener).not.toBeNull();
    const emit = listener as unknown as (event: OperationUpdatedEvent) => void;
    emit({
      subscriptionId: 'sub-1',
      operationId: 'op-1',
      sequence: 2,
      phase: 'finished',
      status: 'succeeded',
      progress: 100,
    });
    await flush();
    expect(controller.getState().trackedOperation?.status).toBe('succeeded');
    emit({
      subscriptionId: 'sub-1',
      operationId: 'op-1',
      sequence: 1,
      phase: 'starting',
      status: 'running',
    });
    await flush();
    expect(controller.getState().trackedOperation?.status).toBe('succeeded');
    await controller.dispose();
    expect(listener).toBeNull();
  });
});
