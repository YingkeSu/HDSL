/**
 * Controlled-deferred timing regressions for the T006a controller.
 *
 * These reproduce the review P2-1/P2-2 interleavings with promises the test
 * settles explicitly: an in-flight `operations.get` resolving after a newer
 * track or after `dispose`, a subscription created after invalidation, poll
 * failures with bounded retries, and the command-pending gate. They are
 * renderer-semantics tests, not DSH/Electron acceptance.
 */
import {
  API_VERSION,
  CONTRACT_METHODS,
  type ContractResponse,
  type EnvironmentSummary,
  type RuntimeCombination,
} from '@hdsl/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import type { RendererContractClient } from '../../apps/desktop/src/renderer/contract.js';
import {
  createDeferred,
  createStubRendererClient,
  stubFail,
  stubOk,
  type Deferred,
  type RecordedCall,
} from './support/contract-client.js';

const environmentSummary = (overrides: Partial<EnvironmentSummary> = {}): EnvironmentSummary => ({
  id: 'env-1',
  name: 'Env 1',
  revision: 1,
  stateVersion: 1,
  state: 'stopped',
  activeGenerationId: 'gen-1',
  compositionDigest: 'a'.repeat(64),
  ...overrides,
});

const COMBINATION: RuntimeCombination = {
  id: 'combo-darwin-arm64',
  platform: 'darwin',
  arch: 'arm64',
  node: { version: '24.21.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  compatibility: { status: 'verified', evidenceRef: 'docs/research/dsh-compatibility.md' },
  artifactLocations: {
    node: {
      version: '24.21.0',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://example.invalid/node.tgz',
      sha256: 'a'.repeat(64),
    },
    dsh: {
      version: '0.1.5-rc.2',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://example.invalid/dsh.tgz',
      sha256: 'b'.repeat(64),
    },
  },
};

const runningSnapshot = (id: string, sequence: number) => ({
  id,
  environmentId: 'env-1',
  kind: 'start' as const,
  phase: 'starting',
  status: 'running' as const,
  sequence,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
};

interface ControlledClient {
  readonly client: RendererContractClient;
  readonly calls: RecordedCall[];
  readonly pendingGets: Array<Deferred<ContractResponse<unknown>>>;
  deferSubscribe(): Deferred<ContractResponse<unknown>>;
}

const createControlledClient = (): ControlledClient => {
  const calls: RecordedCall[] = [];
  const pendingGets: Array<Deferred<ContractResponse<unknown>>> = [];
  let subscribeDeferred: Deferred<ContractResponse<unknown>> | null = null;
  let startCounter = 0;
  let subscribeCounter = 0;
  const client: RendererContractClient = {
    apiVersion: API_VERSION,
    methods: CONTRACT_METHODS,
    call(method, input): Promise<ContractResponse<unknown>> {
      calls.push({ method, input });
      switch (method) {
        case 'catalog.list':
          return Promise.resolve(stubOk([COMBINATION]));
        case 'environments.list':
          return Promise.resolve(stubOk([environmentSummary()]));
        case 'environments.start': {
          startCounter += 1;
          return Promise.resolve(stubOk({ operationId: `op-${startCounter}` }));
        }
        case 'environments.create':
          return Promise.resolve(stubOk({ operationId: 'op-create' }));
        case 'operations.get': {
          const deferred = createDeferred<ContractResponse<unknown>>();
          pendingGets.push(deferred);
          return deferred.promise;
        }
        case 'operations.subscribe': {
          if (subscribeDeferred !== null) {
            const deferred = subscribeDeferred;
            subscribeDeferred = null;
            return deferred.promise;
          }
          subscribeCounter += 1;
          return Promise.resolve(stubOk({ subscriptionId: `sub-${subscribeCounter}` }));
        }
        case 'operations.unsubscribe':
          return Promise.resolve(stubOk(null));
        default:
          return Promise.resolve(stubFail('INTERNAL_ERROR'));
      }
    },
  };
  return {
    client,
    calls,
    pendingGets,
    deferSubscribe: () => {
      const deferred = createDeferred<ContractResponse<unknown>>();
      subscribeDeferred = deferred;
      return deferred;
    },
  };
};

const unsubscribeIds = (calls: readonly RecordedCall[]): string[] =>
  calls
    .filter((call) => call.method === 'operations.unsubscribe')
    .map((call) => (call.input as { subscriptionId?: string }).subscriptionId ?? '');

afterEach(() => {
  vi.useRealTimers();
});

describe('RendererController cross-operation timing (P2-1)', () => {
  it('ignores a poll response for a superseded operation and releases its subscription', async () => {
    vi.useFakeTimers();
    const harness = createControlledClient();
    const controller = new RendererController({ client: harness.client, pollIntervalMs: 100 });
    await controller.load();
    controller.selectEnvironment('env-1');

    const first = controller.startSelected();
    await flush();
    expect(harness.pendingGets).toHaveLength(1);
    harness.pendingGets[0]!.resolve(stubOk(runningSnapshot('op-1', 1)));
    await first;
    expect(controller.getState().trackedOperation?.operationId).toBe('op-1');

    // The op-1 poll is now in flight...
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.pendingGets).toHaveLength(2);

    // ...while a second start supersedes op-1.
    const second = controller.startSelected();
    await flush();
    expect(harness.pendingGets).toHaveLength(3);
    harness.pendingGets[2]!.resolve(stubOk(runningSnapshot('op-2', 1)));
    await second;
    expect(controller.getState().trackedOperation?.operationId).toBe('op-2');

    // The stale op-1 response must not overwrite the newer track.
    harness.pendingGets[1]!.resolve(stubOk(runningSnapshot('op-1', 2)));
    await flush();
    expect(controller.getState().trackedOperation?.operationId).toBe('op-2');
    expect(unsubscribeIds(harness.calls)).toContain('sub-1');

    await controller.dispose();
    vi.useRealTimers();
  });

  it('ignores a stale start poll when a create supersedes tracking', async () => {
    vi.useFakeTimers();
    const harness = createControlledClient();
    const controller = new RendererController({ client: harness.client, pollIntervalMs: 100 });
    await controller.load();
    controller.selectEnvironment('env-1');
    controller.setCreateName('新环境');
    controller.setCreateCombinationId('combo-darwin-arm64');

    const start = controller.startSelected();
    await flush();
    harness.pendingGets[0]!.resolve(stubOk(runningSnapshot('op-1', 1)));
    await start;

    await vi.advanceTimersByTimeAsync(100);
    expect(harness.pendingGets).toHaveLength(2);

    const create = controller.createEnvironment();
    await flush();
    expect(harness.pendingGets).toHaveLength(3);
    harness.pendingGets[2]!.resolve(stubOk(runningSnapshot('op-create', 1)));
    await create;
    expect(controller.getState().trackedOperation?.operationId).toBe('op-create');

    harness.pendingGets[1]!.resolve(stubOk(runningSnapshot('op-1', 2)));
    await flush();
    expect(controller.getState().trackedOperation?.operationId).toBe('op-create');
    expect(unsubscribeIds(harness.calls)).toContain('sub-1');

    await controller.dispose();
    vi.useRealTimers();
  });
});

describe('RendererController disposal timing (P2-2)', () => {
  it('does not subscribe or write state when dispose happens before the snapshot arrives', async () => {
    const harness = createControlledClient();
    const controller = new RendererController({ client: harness.client });
    await controller.load();
    controller.selectEnvironment('env-1');

    const start = controller.startSelected();
    await flush();
    expect(harness.pendingGets).toHaveLength(1);

    await controller.dispose();
    harness.pendingGets[0]!.resolve(stubOk(runningSnapshot('op-1', 1)));
    await start;
    await flush();

    expect(harness.calls.filter((call) => call.method === 'operations.subscribe')).toHaveLength(0);
    expect(controller.getState().trackedOperation).toBeNull();
  });

  it('releases a subscription that resolves after dispose', async () => {
    const harness = createControlledClient();
    const controller = new RendererController({ client: harness.client });
    await controller.load();
    controller.selectEnvironment('env-1');

    const start = controller.startSelected();
    await flush();
    const subscribe = harness.deferSubscribe();
    harness.pendingGets[0]!.resolve(stubOk(runningSnapshot('op-1', 1)));
    await flush();

    await controller.dispose();
    subscribe.resolve(stubOk({ subscriptionId: 'sub-late' }));
    await flush();
    await start;

    expect(unsubscribeIds(harness.calls)).toContain('sub-late');
  });
});

describe('RendererController initial get failure (issue #40)', () => {
  it('keeps the real operationId visible when the first operations.get fails, then recovers on retry', async () => {
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
            return stubFail('INTERNAL_ERROR');
          }
          return stubOk(runningSnapshot('op-1', 1));
        }
        case 'operations.subscribe':
          return stubOk({ subscriptionId: 'sub-1' });
        case 'operations.unsubscribe':
          return stubOk(null);
        default:
          return stubFail('INTERNAL_ERROR');
      }
    });
    const controller = new RendererController({ client, pollIntervalMs: 1_000_000 });
    await controller.load();
    controller.selectEnvironment('env-1');
    await controller.startSelected();

    const failed = controller.getState();
    expect(failed.trackingError?.code).toBe('INTERNAL_ERROR');
    expect(failed.trackedOperation).toBeNull();
    expect(failed.pendingOperationId).toBe('op-1');

    controller.retryTracking();
    await flush();

    const recovered = controller.getState();
    expect(recovered.trackedOperation?.operationId).toBe('op-1');
    expect(recovered.trackingError).toBeNull();
    expect(recovered.pendingOperationId).toBeNull();
    // The retry only re-observed the same operation; the command is not re-sent.
    expect(calls.filter((call) => call.method === 'environments.start')).toHaveLength(1);

    await controller.dispose();
  });

  it('keeps the pending operation across consecutive first-fetch failures before recovering', async () => {
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
          if (getCount <= 2) {
            return stubFail('INTERNAL_ERROR');
          }
          return stubOk(runningSnapshot('op-1', 1));
        }
        case 'operations.subscribe':
          return stubOk({ subscriptionId: 'sub-1' });
        case 'operations.unsubscribe':
          return stubOk(null);
        default:
          return stubFail('INTERNAL_ERROR');
      }
    });
    const controller = new RendererController({ client, pollIntervalMs: 1_000_000 });
    await controller.load();
    controller.selectEnvironment('env-1');
    await controller.startSelected();

    controller.retryTracking();
    await flush();
    expect(controller.getState().trackedOperation).toBeNull();
    expect(controller.getState().trackingError?.code).toBe('INTERNAL_ERROR');
    expect(controller.getState().pendingOperationId).toBe('op-1');

    controller.retryTracking();
    await flush();
    expect(controller.getState().trackedOperation?.operationId).toBe('op-1');
    expect(controller.getState().pendingOperationId).toBeNull();
    expect(calls.filter((call) => call.method === 'environments.start')).toHaveLength(1);

    await controller.dispose();
  });

  it('ignores a stale first-fetch retry that resolves after a newer track', async () => {
    const harness = createControlledClient();
    const controller = new RendererController({
      client: harness.client,
      pollIntervalMs: 1_000_000,
    });
    await controller.load();
    controller.selectEnvironment('env-1');

    const start = controller.startSelected();
    await flush();
    harness.pendingGets[0]!.resolve(stubFail('INTERNAL_ERROR'));
    await start;
    expect(controller.getState().pendingOperationId).toBe('op-1');

    controller.retryTracking();
    await flush();
    expect(harness.pendingGets).toHaveLength(2);

    // A newer start supersedes the retry's operation before it resolves.
    const second = controller.startSelected();
    await flush();
    expect(harness.pendingGets).toHaveLength(3);
    harness.pendingGets[2]!.resolve(stubOk(runningSnapshot('op-2', 1)));
    await second;
    expect(controller.getState().trackedOperation?.operationId).toBe('op-2');

    harness.pendingGets[1]!.resolve(stubOk(runningSnapshot('op-1', 1)));
    await flush();
    expect(controller.getState().trackedOperation?.operationId).toBe('op-2');
    expect(controller.getState().pendingOperationId).toBeNull();

    await controller.dispose();
  });

  it('does not subscribe or write state when a first-fetch retry resolves after dispose', async () => {
    const harness = createControlledClient();
    const controller = new RendererController({
      client: harness.client,
      pollIntervalMs: 1_000_000,
    });
    await controller.load();
    controller.selectEnvironment('env-1');

    const start = controller.startSelected();
    await flush();
    harness.pendingGets[0]!.resolve(stubFail('INTERNAL_ERROR'));
    await start;

    controller.retryTracking();
    await flush();
    expect(harness.pendingGets).toHaveLength(2);

    await controller.dispose();
    harness.pendingGets[1]!.resolve(stubOk(runningSnapshot('op-1', 1)));
    await flush();

    expect(harness.calls.filter((call) => call.method === 'operations.subscribe')).toHaveLength(0);
    expect(controller.getState().trackedOperation).toBeNull();
  });

  it('maps a transport failure on the first get to a controlled error without leaking its message', async () => {
    const { client } = createStubRendererClient((method) => {
      switch (method) {
        case 'catalog.list':
          return stubOk([]);
        case 'environments.list':
          return stubOk([environmentSummary()]);
        case 'environments.start':
          return stubOk({ operationId: 'op-1' });
        case 'operations.get':
          throw new Error('transport down; /Users/secret/path?token=canary-token');
        default:
          return stubFail('INTERNAL_ERROR');
      }
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment('env-1');
    await controller.startSelected();

    expect(controller.getState().trackingError?.code).toBe('INTERNAL_ERROR');
    expect(controller.getState().pendingOperationId).toBe('op-1');
    expect(JSON.stringify(controller.getState())).not.toContain('canary-token');
    expect(JSON.stringify(controller.getState())).not.toContain('/Users/secret/path');

    await controller.dispose();
  });
});

describe('RendererController poll recovery (P3-1)', () => {
  it('retries transient poll failures, then pauses with an explicit retry entry', async () => {
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
            return stubOk(runningSnapshot('op-1', 1));
          }
          if (getCount <= 4) {
            return stubFail('INTERNAL_ERROR');
          }
          return stubOk({ ...runningSnapshot('op-1', 2), phase: 'finished', status: 'succeeded' });
        }
        case 'operations.subscribe':
          return stubOk({ subscriptionId: 'sub-1' });
        case 'operations.unsubscribe':
          return stubOk(null);
        default:
          return stubFail('INTERNAL_ERROR');
      }
    });
    const controller = new RendererController({ client, pollIntervalMs: 100, maxPollRetries: 3 });
    await controller.load();
    controller.selectEnvironment('env-1');
    await controller.startSelected();

    await vi.advanceTimersByTimeAsync(100);
    expect(controller.getState().trackingError?.code).toBe('INTERNAL_ERROR');
    expect(controller.getState().trackingPaused).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.getState().trackingPaused).toBe(true);

    const getsBefore = calls.filter((call) => call.method === 'operations.get').length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.filter((call) => call.method === 'operations.get').length).toBe(getsBefore);

    controller.retryTracking();
    expect(controller.getState().trackingPaused).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.getState().trackedOperation?.status).toBe('succeeded');
    expect(controller.getState().trackingError).toBeNull();

    await controller.dispose();
    vi.useRealTimers();
  });
});

describe('RendererController command pending flag (P3-2)', () => {
  it('exposes commandPending while repeated clicks still issue distinct calls', async () => {
    const harness = createControlledClient();
    const controller = new RendererController({ client: harness.client });
    await controller.load();
    controller.selectEnvironment('env-1');

    const first = controller.startSelected();
    await flush();
    expect(controller.getState().commandPending).toBe(true);

    // A repeated click still dispatches its own call (accepted QA semantics) but
    // with a distinct requestId, and the later track stays authoritative.
    const second = controller.startSelected();
    await flush();
    const starts = harness.calls.filter((call) => call.method === 'environments.start');
    expect(starts).toHaveLength(2);
    const requestIds = starts.map(
      (call) => (call.input as { requestId?: string }).requestId ?? '',
    );
    expect(new Set(requestIds).size).toBe(2);

    harness.pendingGets[1]!.resolve(stubOk(runningSnapshot('op-2', 1)));
    harness.pendingGets[0]!.resolve(stubOk(runningSnapshot('op-1', 1)));
    await Promise.all([first, second]);
    expect(controller.getState().trackedOperation?.operationId).toBe('op-2');
    expect(controller.getState().commandPending).toBe(false);

    await controller.dispose();
  });
});
