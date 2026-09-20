/**
 * Core lifecycle coordination (issue #43): core owns the operation, the
 * environment state machine, the revision/state guards and the data-root lock,
 * while an injected managed-process port performs the real spawn/stop.
 *
 * The process port here is a fake, but every state transition and operation
 * record is the real durable core implementation over a real data root; the
 * install uses the offline SHA-256-verified synthetic artifacts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_VERSION,
  createContractRuntime,
  portFail,
  portOk,
  type ContractPort,
  type ContractResponse,
  type OperationRef,
  type RuntimeCombination,
} from '@hdsl/contracts';
import {
  createManagedInstall,
  type ManagedInstall,
  type ManagedProcessPort,
  type ProcessLifecycleRequest,
  type ProcessRecoveryEntry,
} from '@hdsl/core';
import { createRuntimePort } from '@hdsl/runtime';
import { sha256, syntheticCombination, syntheticDshTarball, syntheticNodeTarball, writeLocalArtifact } from '../install/synthetic.js';

const nodeTarball = syntheticNodeTarball('22.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});

interface FakeProcessOptions {
  readonly behavior?: 'ok' | 'fail' | 'hang';
  readonly recovery?: readonly ProcessRecoveryEntry[];
  readonly closeOk?: boolean;
}

class FakeProcess implements ManagedProcessPort {
  starts = 0;
  stops = 0;
  closes = 0;
  lastSignal: AbortSignal | undefined;
  readonly #options: FakeProcessOptions;

  constructor(options: FakeProcessOptions = {}) {
    this.#options = options;
  }

  start(request: ProcessLifecycleRequest) {
    this.starts += 1;
    this.lastSignal = request.signal;
    request.onPhase('waiting-ready', 50);
    if (this.#options.behavior === 'fail') {
      return Promise.resolve(portFail('PORT_UNAVAILABLE', 'the port is already in use'));
    }
    if (this.#options.behavior === 'hang') {
      return new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new Error('aborted by cancel'));
        });
      });
    }
    request.onPhase('running', 100);
    return Promise.resolve(portOk({ pid: 1234, loopbackOrigin: 'http://127.0.0.1:53123' }));
  }

  stop(request: ProcessLifecycleRequest) {
    this.stops += 1;
    request.onPhase('stopping', 50);
    return Promise.resolve(portOk({ wasRunning: true, pid: 1234 }));
  }

  openWebUI() {
    return portOk({ loopbackOrigin: 'http://127.0.0.1:53123' });
  }

  async recover() {
    return { entries: this.#options.recovery ?? [] };
  }

  close() {
    this.closes += 1;
    return Promise.resolve(
      this.#options.closeOk === false ? portFail('INTERNAL_ERROR', 'could not stop a process') : portOk(undefined),
    );
  }
}

interface Harness {
  readonly dataRoot: string;
  readonly managed: ManagedInstall;
  readonly process: FakeProcess;
  readonly dispatch: (method: string, input: unknown) => ContractResponse<unknown>;
}

const roots: string[] = [];

const freshRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const buildHarness = async (
  options: {
    readonly dataRoot?: string;
    readonly process?: FakeProcess;
    readonly lockWaitTimeoutMs?: number;
  } = {},
): Promise<Harness> => {
  const dataRoot = options.dataRoot ?? freshRoot('hdsl-lifecycle-');
  const artifacts = freshRoot('hdsl-lifecycle-artifacts-');
  writeLocalArtifact(artifacts, sha256(nodeTarball), nodeTarball);
  writeLocalArtifact(artifacts, sha256(dshTarball), dshTarball);
  const runtime = createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    localArtifactDirectory: artifacts,
  });
  const process = options.process ?? new FakeProcess();
  const managed = await createManagedInstall({
    dataRoot,
    catalog: [combination] as readonly RuntimeCombination[],
    runtime,
    processFactory: () => process,
    fixtures: { allowArtifactsOnly: true },
    lockWaitTimeoutMs: options.lockWaitTimeoutMs ?? 200,
  });
  const contract = createContractRuntime({ port: managed.port as ContractPort });
  return {
    dataRoot,
    managed,
    process,
    dispatch: (method, input) => contract.dispatch({ apiVersion: API_VERSION, method, input }),
  };
};

const refOf = (response: ContractResponse<unknown>): string => {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    throw new Error('expected a successful response');
  }
  return (response.value as OperationRef).operationId;
};

const createEnvironment = async (harness: Harness, requestId: string): Promise<string> => {
  const response = harness.dispatch('environments.create', {
    requestId,
    name: 'lifecycle',
    catalogCombinationId: combination.id,
  });
  const operationId = refOf(response);
  const settled = await harness.managed.waitForOperation(operationId);
  expect(settled.status).toBe('succeeded');
  return operationId;
};

const environmentOf = (harness: Harness): { id: string; revision: number; state: string; activeGenerationId: string | null } => {
  const list = harness.dispatch('environments.list', {});
  expect(list.ok).toBe(true);
  if (!list.ok) {
    throw new Error('expected environments.list to succeed');
  }
  const environments = list.value as Array<{ id: string; revision: number; state: string; activeGenerationId: string | null }>;
  const environment = environments[0];
  if (environment === undefined) {
    throw new Error('expected one environment');
  }
  return environment;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('managed process coordination', () => {
  it('starts an installed environment, moving it to running', async () => {
    const harness = await buildHarness();
    await createEnvironment(harness, 'req-create');
    const environment = environmentOf(harness);

    const started = harness.dispatch('environments.start', {
      requestId: 'req-start',
      environmentId: environment.id,
      expectedRevision: environment.revision,
    });
    const operationId = refOf(started);
    const settled = await harness.managed.waitForOperation(operationId);
    expect(settled.status).toBe('succeeded');
    expect(harness.process.starts).toBe(1);
    expect(environmentOf(harness).state).toBe('running');
    await harness.managed.close();
  });

  it('returns ENVIRONMENT_BUSY when starting an already running environment', async () => {
    const harness = await buildHarness();
    await createEnvironment(harness, 'req-create');
    const environment = environmentOf(harness);
    const started = harness.dispatch('environments.start', {
      requestId: 'req-start',
      environmentId: environment.id,
      expectedRevision: environment.revision,
    });
    await harness.managed.waitForOperation(refOf(started));

    const again = harness.dispatch('environments.start', {
      requestId: 'req-start-again',
      environmentId: environment.id,
      expectedRevision: environment.revision,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe('ENVIRONMENT_BUSY');
    }
    await harness.managed.close();
  });

  it('reverts to stopped with the active generation preserved when start fails', async () => {
    const harness = await buildHarness({ process: new FakeProcess({ behavior: 'fail' }) });
    await createEnvironment(harness, 'req-create');
    const environment = environmentOf(harness);
    const started = harness.dispatch('environments.start', {
      requestId: 'req-start',
      environmentId: environment.id,
      expectedRevision: environment.revision,
    });
    const settled = await harness.managed.waitForOperation(refOf(started));
    expect(settled.status).toBe('failed');
    expect(settled.error?.code).toBe('PORT_UNAVAILABLE');
    const after = environmentOf(harness);
    expect(after.state).toBe('stopped');
    expect(after.activeGenerationId).not.toBeNull();
    await harness.managed.close();
  });

  it('stops a running environment', async () => {
    const harness = await buildHarness();
    await createEnvironment(harness, 'req-create');
    const environment = environmentOf(harness);
    await harness.managed.waitForOperation(
      refOf(
        harness.dispatch('environments.start', {
          requestId: 'req-start',
          environmentId: environment.id,
          expectedRevision: environment.revision,
        }),
      ),
    );
    const stopping = harness.dispatch('environments.stop', {
      requestId: 'req-stop',
      environmentId: environment.id,
      expectedRevision: environment.revision,
    });
    const settled = await harness.managed.waitForOperation(refOf(stopping));
    expect(settled.status).toBe('succeeded');
    expect(harness.process.stops).toBe(1);
    expect(environmentOf(harness).state).toBe('stopped');
    await harness.managed.close();
  });

  it('cancels an in-flight start, aborts the signal and reverts to stopped', async () => {
    const harness = await buildHarness({ process: new FakeProcess({ behavior: 'hang' }) });
    await createEnvironment(harness, 'req-create');
    const environment = environmentOf(harness);
    const started = harness.dispatch('environments.start', {
      requestId: 'req-start',
      environmentId: environment.id,
      expectedRevision: environment.revision,
    });
    const operationId = refOf(started);
    const cancelled = harness.dispatch('operations.cancel', { requestId: 'req-cancel', operationId });
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect((cancelled.value as { status: string }).status).toBe('cancelled');
    }
    const settled = await harness.managed.waitForOperation(operationId);
    expect(settled.status).toBe('cancelled');
    expect(harness.process.lastSignal?.aborted).toBe(true);
    expect(environmentOf(harness).state).toBe('stopped');
    await harness.managed.close();
  });

  it('marks the environment stopped when the managed process exits unexpectedly', async () => {
    const harness = await buildHarness();
    await createEnvironment(harness, 'req-create');
    const environment = environmentOf(harness);
    await harness.managed.waitForOperation(
      refOf(
        harness.dispatch('environments.start', {
          requestId: 'req-start',
          environmentId: environment.id,
          expectedRevision: environment.revision,
        }),
      ),
    );
    harness.managed.handleProcessExit({ environmentId: environment.id, pid: 1234, exitCode: 1 });
    expect(environmentOf(harness).state).toBe('stopped');
    await harness.managed.close();
  });

  it('applies process recovery resolutions to the environment state', async () => {
    const dataRoot = freshRoot('hdsl-lifecycle-recover-');
    const first = await buildHarness({ dataRoot });
    await createEnvironment(first, 'req-create');
    await first.managed.close();

    const adoptedProcess = new FakeProcess({
      recovery: [{ environmentId: environmentOf(first).id, resolution: 'adopted', loopbackOrigin: 'http://127.0.0.1:53123' }],
    });
    const second = await buildHarness({ dataRoot, process: adoptedProcess });
    expect(second.managed.available).toBe(true);
    const report = await second.managed.recover();
    expect(report.refused).not.toBe(true);
    expect(environmentOf(second).state).toBe('running');
    await second.managed.close();
  });

  it('refuses recover and creation on an unavailable second instance', async () => {
    const dataRoot = freshRoot('hdsl-lifecycle-busy-');
    const first = await buildHarness({ dataRoot });
    const second = await buildHarness({ dataRoot });
    expect(first.managed.available).toBe(true);
    expect(second.managed.available).toBe(false);

    const report = await second.managed.recover();
    expect(report.refused).toBe(true);
    expect(report.reconciled).toBe(0);

    const created = second.dispatch('environments.create', {
      requestId: 'req-busy',
      name: 'busy',
      catalogCombinationId: combination.id,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe('ENVIRONMENT_BUSY');
    }
    await second.managed.close();
    await first.managed.close();
  });
});

describe('close ordering', () => {
  it('stops the process module and releases the lease on success', async () => {
    const harness = await buildHarness();
    await createEnvironment(harness, 'req-create');
    const report = await harness.managed.close();
    expect(report.released).toBe(true);
    expect(harness.process.closes).toBe(1);
    expect(harness.managed.lockSnapshot().publishedBy).toBe('none');
  });

  it('keeps the lease when the process module cannot prove a clean shutdown', async () => {
    const harness = await buildHarness({ process: new FakeProcess({ closeOk: false }) });
    await createEnvironment(harness, 'req-create');
    const report = await harness.managed.close();
    expect(report.released).toBe(false);
    expect(report.failure?.code).toBe('INTERNAL_ERROR');
    // The lock is still held; a later instance must not be able to start work.
    expect(harness.managed.service.available).toBe(true);
    expect(harness.managed.lockSnapshot().heldByThisInstance).toBe(true);
  });
});
