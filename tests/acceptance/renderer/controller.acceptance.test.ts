/**
 * Renderer controller acceptance (independent QA, black-box).
 *
 * Target: PR #34 head `44e5b748ebd67e46319580162d3e91563bd22d28` (issue #30).
 * This drives the **public** `RendererController` from
 * `apps/desktop/src/renderer/controller.ts` with a controlled async
 * `RendererContractClient` (deferred responses / failures / malformed
 * envelopes). It does not import or modify the author's `tests/renderer`.
 *
 * Scope: controller/state-machine behavior only. The static `demo/index.html`
 * is a separate vanilla implementation and is NOT evidence for these React
 * components (see README).
 */
import {
  API_VERSION,
  CONTRACT_METHODS,
  type ContractMethod,
  type ContractResponse,
} from '@hdsl/contracts';
import {
  FIXTURE_IDS,
  FIXTURE_SEED,
} from '@hdsl/contracts/testing';
import type { OperationUpdatedEvent } from '@hdsl/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  RendererController,
  type RendererEventSource,
} from '../../../apps/desktop/src/renderer/controller.js';
import type { RendererContractClient } from '../../../apps/desktop/src/renderer/contract.js';

const SHA = '44e5b748ebd67e46319580162d3e91563bd22d28';
const ENV_STOPPED = FIXTURE_IDS.environment.stopped;
const ENV_RUNNING = FIXTURE_IDS.environment.running;

const deferred = <T,>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const ok = <T>(value: T): ContractResponse<T> => ({ ok: true, apiVersion: API_VERSION, value });
const fail = (code: string, message = 'controlled failure'): ContractResponse<never> => ({
  ok: false,
  apiVersion: API_VERSION,
  error: { code: code as never, message, retryable: false },
});

interface CallRecord {
  readonly method: ContractMethod;
  readonly input: unknown;
}
type Handler = (input: unknown, index: number) => unknown | Promise<unknown>;

const controlledClient = (
  handlers: Partial<Record<ContractMethod, Handler>>,
): { client: RendererContractClient; calls: CallRecord[]; count: (m: ContractMethod) => number } => {
  const calls: CallRecord[] = [];
  const client: RendererContractClient = {
    apiVersion: API_VERSION,
    methods: CONTRACT_METHODS,
    call(method, input) {
      calls.push({ method, input });
      const handler = handlers[method];
      if (handler === undefined) {
        return Promise.reject(new Error(`no controlled handler for ${method}`));
      }
      const index = calls.filter((entry) => entry.method === method).length - 1;
      return Promise.resolve(handler(input, index)) as Promise<ContractResponse<unknown>>;
    },
  };
  return {
    client,
    calls,
    count: (method) => calls.filter((entry) => entry.method === method).length,
  };
};

const defaultLoadHandlers = (): Partial<Record<ContractMethod, Handler>> => ({
  'catalog.list': () => ok(FIXTURE_SEED.catalog),
  'environments.list': () => ok(FIXTURE_SEED.environments),
});

const runningSnapshot = (sequence = 2, progress?: number) => ({
  id: 'op-1',
  environmentId: ENV_STOPPED,
  kind: 'start' as const,
  phase: 'running',
  status: 'running' as const,
  sequence,
  ...(progress === undefined ? {} : { progress }),
});

const startHandlers = (
  overrides: Partial<Record<ContractMethod, Handler>> = {},
): Partial<Record<ContractMethod, Handler>> => ({
  ...defaultLoadHandlers(),
  'environments.start': () => ok({ operationId: 'op-1' }),
  'operations.get': () => ok(runningSnapshot(1, 10)),
  'operations.subscribe': () => ok({ subscriptionId: 'sub-1' }),
  'operations.unsubscribe': () => ok(null),
  ...overrides,
});

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe(`renderer controller acceptance (independent QA @ ${SHA})`, () => {
  it('1. delayed load stays loading until both lists resolve', async () => {
    const catalog = deferred<ContractResponse<unknown>>();
    const environments = deferred<ContractResponse<unknown>>();
    const { client } = controlledClient({
      'catalog.list': () => catalog.promise,
      'environments.list': () => environments.promise,
    });
    const controller = new RendererController({ client, pollIntervalMs: 5 });

    const pending = controller.load();
    expect(controller.getState().phase).toBe('loading');
    expect(controller.getState().environments).toEqual([]);

    catalog.resolve(ok(FIXTURE_SEED.catalog));
    await settle();
    expect(controller.getState().phase).toBe('loading');

    environments.resolve(ok(FIXTURE_SEED.environments));
    await pending;
    expect(controller.getState().phase).toBe('ready');
    expect(controller.getState().environments).toHaveLength(2);
    expect(controller.getState().catalog).toHaveLength(3);
  });

  it('2. delayed refresh does not clobber the user selection', async () => {
    let listHandler: () => unknown = () => ok(FIXTURE_SEED.environments);
    const { client } = controlledClient({
      'catalog.list': () => ok(FIXTURE_SEED.catalog),
      'environments.list': () => listHandler(),
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);

    const pendingList = deferred<ContractResponse<unknown>>();
    listHandler = () => pendingList.promise;
    const refresh = controller.refresh();
    controller.selectEnvironment(ENV_STOPPED);
    pendingList.resolve(ok(FIXTURE_SEED.environments));
    await refresh;

    expect(controller.getState().selectedEnvironmentId).toBe(ENV_STOPPED);
  });

  it('3. repeated start clicks issue distinct requestIds without breaking tracking', async () => {
    const { client, calls } = controlledClient(startHandlers());
    const controller = new RendererController({ client, pollIntervalMs: 100 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);

    await Promise.all([controller.startSelected(), controller.startSelected()]);

    const starts = calls.filter((entry) => entry.method === 'environments.start');
    expect(starts).toHaveLength(2);
    const requestIds = starts.map((entry) => (entry.input as { requestId: string }).requestId);
    expect(new Set(requestIds).size).toBe(2);
    expect(controller.getState().trackedOperation?.operationId).toBe('op-1');
    await controller.dispose();
  });

  it('4. create failure surfaces the contract error and keeps the typed name for retry', async () => {
    const { client } = controlledClient({
      ...defaultLoadHandlers(),
      'environments.create': () => fail('UNSUPPORTED_COMBINATION', 'combination not verified'),
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.setCreateName('My env');
    controller.setCreateCombinationId(FIXTURE_IDS.combination.verified);

    await controller.createEnvironment();

    expect(controller.getState().createError?.code).toBe('UNSUPPORTED_COMBINATION');
    // The create failure stays dialog-scoped; no page-level `actionError` is set.
    expect(controller.getState().actionError).toBeNull();
    expect(controller.getState().createName).toBe('My env');
    expect(controller.getState().notice).toBeNull();
  });

  it('5. polling stops at the terminal state, unsubscribes and refreshes the list', async () => {
    let getIndex = 0;
    const listStates: string[] = [];
    const { client, count } = controlledClient(
      startHandlers({
        'operations.get': () => {
          getIndex += 1;
          return getIndex === 1
            ? ok(runningSnapshot(1, 10))
            : ok({
                id: 'op-1',
                environmentId: ENV_STOPPED,
                kind: 'start' as const,
                phase: 'finished',
                status: 'succeeded' as const,
                sequence: 2,
                progress: 100,
              });
        },
        'environments.list': () => {
          listStates.push('list');
          return ok(FIXTURE_SEED.environments);
        },
      }),
    );
    const controller = new RendererController({ client, pollIntervalMs: 1 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);
    await controller.startSelected();

    await vi.waitFor(() => {
      expect(controller.getState().trackedOperation?.status).toBe('succeeded');
    });
    expect(controller.getState().trackedOperation?.progress).toBe(100);
    expect(count('operations.unsubscribe')).toBe(1);
    expect(listStates.length).toBeGreaterThanOrEqual(2);
    const getsAfterTerminal = count('operations.get');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count('operations.get')).toBe(getsAfterTerminal);
    await controller.dispose();
  });

  it('6. dispose releases the subscription, timer and event source', async () => {
    let emit: (event: OperationUpdatedEvent) => void = () => undefined;
    let detached = false;
    const events: RendererEventSource = {
      subscribe(listener) {
        emit = listener;
        return () => {
          detached = true;
        };
      },
    };
    const { client, count } = controlledClient(startHandlers());
    const controller = new RendererController({ client, events, pollIntervalMs: 1 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);
    await controller.startSelected();
    expect(controller.getState().trackedOperation?.status).toBe('running');

    await controller.dispose();

    expect(count('operations.unsubscribe')).toBe(1);
    expect(detached).toBe(true);
    const gets = count('operations.get');
    emit({
      subscriptionId: 'sub-1',
      operationId: 'op-1',
      sequence: 9,
      phase: 'finished',
      status: 'succeeded',
    } as OperationUpdatedEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count('operations.get')).toBe(gets);
    expect(controller.getState().trackedOperation?.sequence).toBe(1);
  });

  it('7. a non-loopback / token-bearing WebUI origin is refused by the renderer', async () => {
    const { client } = controlledClient({
      ...defaultLoadHandlers(),
      'environments.openWebUI': () => ok({ loopbackOrigin: 'http://evil.test:80/?token=canary' }),
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(ENV_RUNNING);

    await controller.openWebUI();

    expect(controller.getState().webUIOrigin).toBeNull();
    expect(controller.getState().actionError?.code).toBe('WEBUI_UNAVAILABLE');
    expect(JSON.stringify(controller.getState())).not.toContain('canary');
  });

  it('8. a loopback WebUI origin is surfaced without any token', async () => {
    const { client } = controlledClient({
      ...defaultLoadHandlers(),
      'environments.openWebUI': () => ok({ loopbackOrigin: 'http://127.0.0.1:53123' }),
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(ENV_RUNNING);

    await controller.openWebUI();

    expect(controller.getState().webUIOrigin).toBe('http://127.0.0.1:53123');
    expect(controller.getState().actionError).toBeNull();
  });

  it('9. a version-mismatched or malformed envelope fails closed without crashing', async () => {
    const { client } = controlledClient({
      'catalog.list': () => ({ ok: true, apiVersion: '2.0', value: [] }),
      'environments.list': () => 'not-an-object',
    });
    const controller = new RendererController({ client });

    await controller.load();

    expect(controller.getState().phase).toBe('failed');
    expect(controller.getState().loadError?.code).toBe('CONTRACT_VERSION_MISMATCH');
  });

  it('10. an invalid outbound DTO value is rejected as INTERNAL_ERROR', async () => {
    const { client } = controlledClient({
      'catalog.list': () => ok([{ id: 'not-a-valid-combination' }]),
      'environments.list': () => ok(FIXTURE_SEED.environments),
    });
    const controller = new RendererController({ client });

    await controller.load();

    expect(controller.getState().phase).toBe('failed');
    expect(controller.getState().loadError?.code).toBe('INTERNAL_ERROR');
    expect(controller.getState().environments).toEqual([]);
  });

  it('11. pushed events advance progress, ignore stale sequences and complete on terminal', async () => {
    let emit: (event: OperationUpdatedEvent) => void = () => undefined;
    const events: RendererEventSource = {
      subscribe(listener) {
        emit = listener;
        return () => undefined;
      },
    };
    const { client, count } = controlledClient(startHandlers());
    const controller = new RendererController({ client, events, pollIntervalMs: 1000 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);
    await controller.startSelected();
    expect(controller.getState().trackedOperation?.progress).toBe(10);

    emit({
      subscriptionId: 'sub-1',
      operationId: 'op-1',
      sequence: 2,
      phase: 'running',
      status: 'running',
      progress: 55,
    } as OperationUpdatedEvent);
    expect(controller.getState().trackedOperation?.progress).toBe(55);

    emit({
      subscriptionId: 'sub-1',
      operationId: 'op-1',
      sequence: 1,
      phase: 'running',
      status: 'running',
      progress: 5,
    } as OperationUpdatedEvent);
    expect(controller.getState().trackedOperation?.progress).toBe(55);

    emit({
      subscriptionId: 'sub-1',
      operationId: 'op-1',
      sequence: 3,
      phase: 'finished',
      status: 'succeeded',
    } as OperationUpdatedEvent);
    await settle();
    expect(controller.getState().trackedOperation?.status).toBe('succeeded');
    expect(count('operations.unsubscribe')).toBe(1);
    await controller.dispose();
  });

  it('12. cancel freezes the reported progress at the cancelled snapshot', async () => {
    const { client } = controlledClient(
      startHandlers({
        'operations.cancel': () =>
          ok({
            id: 'op-1',
            environmentId: ENV_STOPPED,
            kind: 'start' as const,
            phase: 'cancelled',
            status: 'cancelled' as const,
            sequence: 2,
            progress: 40,
          }),
      }),
    );
    const controller = new RendererController({ client, pollIntervalMs: 1000 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);
    await controller.startSelected();

    await controller.cancelTrackedOperation();

    expect(controller.getState().trackedOperation?.status).toBe('cancelled');
    expect(controller.getState().trackedOperation?.progress).toBe(40);
    await controller.dispose();
  });

  it('13. a client that throws is mapped to INTERNAL_ERROR, not an unhandled rejection', async () => {
    const { client } = controlledClient({
      'catalog.list': () => {
        throw new Error('transport exploded');
      },
      'environments.list': () => ok(FIXTURE_SEED.environments),
    });
    const controller = new RendererController({ client });

    await controller.load();

    expect(controller.getState().phase).toBe('failed');
    expect(controller.getState().loadError?.code).toBe('INTERNAL_ERROR');
  });
});

const FIXED_SHA = 'b9d47348251666e9eae1b9f30e888b4634e962ee';

/**
 * Independent race evidence.
 *
 * R1–R4 reproduce reviewer hdsl-8's P2-1/P2-2/P3.1; they were red on the
 * reviewed SHA `44e5b74` and pass on `b9d4734` with the same expectations.
 * R5–R6 cover the fix's bounded-retry recovery and late-subscribe release.
 * See issue #36. Do not weaken.
 */
describe(`renderer controller race evidence @ ${FIXED_SHA} (green; was red on ${SHA})`, () => {
  const raceSnapshot = (
    id: string,
    sequence: number,
    progress?: number,
  ): Record<string, unknown> => ({
    id,
    environmentId: ENV_STOPPED,
    kind: 'start',
    phase: 'running',
    status: 'running',
    sequence,
    ...(progress === undefined ? {} : { progress }),
  });

  const raceClient = (): {
    client: RendererContractClient;
    gates: ReturnType<typeof deferred<ContractResponse<unknown>>>[];
    count: (m: ContractMethod) => number;
  } => {
    const gates: ReturnType<typeof deferred<ContractResponse<unknown>>>[] = [];
    const ops = { value: 0 };
    const controlled = controlledClient({
      ...defaultLoadHandlers(),
      'environments.start': () => ok({ operationId: `op-${(ops.value += 1)}` }),
      'environments.create': () => ok({ operationId: `op-${(ops.value += 1)}` }),
      'operations.get': () => {
        const gate = deferred<ContractResponse<unknown>>();
        gates.push(gate);
        return gate.promise;
      },
      'operations.subscribe': (input) =>
        ok({ subscriptionId: `sub-${(input as { operationId: string }).operationId}` }),
      'operations.unsubscribe': () => ok(null),
    });
    return { client: controlled.client, gates, count: controlled.count };
  };

  it('R1. a late poll for the previous operation must not overwrite the newly tracked operation', async () => {
    const { client, gates } = raceClient();
    const controller = new RendererController({ client, pollIntervalMs: 1 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);

    const start = controller.startSelected();
    await settle();
    gates[0]?.resolve(ok(raceSnapshot('op-1', 1, 10)));
    await start;
    expect(controller.getState().trackedOperation?.operationId).toBe('op-1');

    // Let the op-1 poll go in-flight, then create op-2.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const create = controller.createEnvironment();
    await settle();
    const op2Gate = gates.length - 1;
    gates[op2Gate]?.resolve(ok(raceSnapshot('op-2', 1, 10)));
    await create;
    expect(controller.getState().trackedOperation?.operationId).toBe('op-2');

    // The stale op-1 poll resolves last and must be ignored.
    gates[1]?.resolve(ok(raceSnapshot('op-1', 2, 20)));
    await settle();
    expect(controller.getState().trackedOperation?.operationId).toBe('op-2');
    await controller.dispose();
  });

  it('R2. dispose must prevent a later subscribe and any post-dispose state mutation', async () => {
    const { client, gates, count } = raceClient();
    const controller = new RendererController({ client, pollIntervalMs: 1000 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);

    const start = controller.startSelected();
    await settle();
    await controller.dispose();
    gates[0]?.resolve(ok(raceSnapshot('op-1', 1, 10)));
    await start;
    await settle();

    expect(count('operations.subscribe')).toBe(0);
    expect(controller.getState().trackedOperation).toBeNull();
  });

  it('R3. a transient operations.get failure must not permanently stop polling', async () => {
    let getIndex = 0;
    const { client, count } = controlledClient({
      ...defaultLoadHandlers(),
      'environments.start': () => ok({ operationId: 'op-1' }),
      'operations.get': () => {
        getIndex += 1;
        if (getIndex === 1) {
          return ok(raceSnapshot('op-1', 1, 10));
        }
        if (getIndex === 2) {
          return fail('INTERNAL_ERROR', 'transient');
        }
        return ok({ ...raceSnapshot('op-1', 3, 60), phase: 'finished', status: 'succeeded' });
      },
      'operations.subscribe': () => ok({ subscriptionId: 'sub-1' }),
      'operations.unsubscribe': () => ok(null),
    });
    const controller = new RendererController({ client, pollIntervalMs: 1 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);
    await controller.startSelected();

    await vi.waitFor(() => expect(count('operations.get')).toBeGreaterThanOrEqual(3), {
      timeout: 300,
    });
    await controller.dispose();
  });

  it('R4. interleaved starts must leave at most the current operation subscribed', async () => {
    const { client, gates, count } = raceClient();
    const controller = new RendererController({ client, pollIntervalMs: 1000 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);

    const first = controller.startSelected();
    const second = controller.startSelected();
    await settle();
    for (const [index, gate] of gates.entries()) {
      gate.resolve(ok(raceSnapshot(`op-${index + 1}`, 1, 10)));
    }
    await Promise.all([first, second]);
    await settle();

    const subscribed = count('operations.subscribe');
    expect(subscribed - count('operations.unsubscribe')).toBeLessThanOrEqual(1);
    await controller.dispose();
    expect(count('operations.unsubscribe')).toBe(subscribed);
  });

  it('R5. polling pauses after bounded retries and retryTracking resumes to terminal', async () => {
    let getIndex = 0;
    const { client, count } = controlledClient({
      ...defaultLoadHandlers(),
      'environments.start': () => ok({ operationId: 'op-1' }),
      'operations.get': () => {
        getIndex += 1;
        if (getIndex === 1) {
          return ok(raceSnapshot('op-1', 1, 10));
        }
        if (getIndex <= 4) {
          return fail('INTERNAL_ERROR', 'transient');
        }
        return ok({ ...raceSnapshot('op-1', 5, 100), phase: 'finished', status: 'succeeded' });
      },
      'operations.subscribe': () => ok({ subscriptionId: 'sub-1' }),
      'operations.unsubscribe': () => ok(null),
    });
    const controller = new RendererController({ client, pollIntervalMs: 1, maxPollRetries: 3 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);
    await controller.startSelected();

    await vi.waitFor(() => expect(controller.getState().trackingPaused).toBe(true), {
      timeout: 400,
    });
    expect(controller.getState().trackingError).not.toBeNull();
    const pausedGets = count('operations.get');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count('operations.get')).toBe(pausedGets);

    controller.retryTracking();
    await vi.waitFor(() => expect(controller.getState().trackedOperation?.status).toBe('succeeded'), {
      timeout: 400,
    });
    await controller.dispose();
  });

  it('R6. a subscribe that resolves after dispose is released, not left registered', async () => {
    const subscribeGate = deferred<ContractResponse<unknown>>();
    const { client, count } = controlledClient({
      ...defaultLoadHandlers(),
      'environments.start': () => ok({ operationId: 'op-1' }),
      'operations.get': () => ok(raceSnapshot('op-1', 1, 10)),
      'operations.subscribe': () => subscribeGate.promise,
      'operations.unsubscribe': () => ok(null),
    });
    const controller = new RendererController({ client, pollIntervalMs: 1000 });
    await controller.load();
    controller.selectEnvironment(ENV_STOPPED);
    const start = controller.startSelected();
    await settle();
    expect(count('operations.subscribe')).toBe(1);

    await controller.dispose();
    const afterDispose = controller.getState().trackedOperation;
    subscribeGate.resolve(ok({ subscriptionId: 'sub-late' }));
    await start;
    await settle();

    // The late subscription must be released, and dispose must not mutate more.
    expect(count('operations.unsubscribe')).toBeGreaterThanOrEqual(1);
    expect(controller.getState().trackedOperation).toEqual(afterDispose);
  });
});
