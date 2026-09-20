/**
 * QA-owned harness for service-level dataRoot lock scenarios (issue #45).
 *
 * Drives the public `createManagedInstall` entry from `@hdsl/core` (frozen by
 * session hdsl-21, PR #49 @ 5bf70910) over a real data root. The synthetic
 * catalog artifacts come from the shared `tests/install/synthetic.ts` test
 * fixture; the runtime port is either the real T004 runtime or a QA-owned
 * gated wrapper that holds an install in flight so close/abort ordering can be
 * observed deterministically. The process port is a QA-owned fake with
 * controllable start/close outcomes; it is never presented as a real DSH.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  canonicalizeDataRoot,
  createManagedInstall,
  type ManagedInstall,
  type ManagedRuntimePort,
  type ManagedProcessPort,
  type ProcessLifecycleRequest,
  type ProcessRecoveryEntry,
} from '@hdsl/core';
import { createRuntimePort } from '@hdsl/runtime';

import {
  sha256,
  syntheticCombination,
  syntheticDshTarball,
  syntheticNodeTarball,
  writeLocalArtifact,
} from '../../../install/synthetic.js';

const nodeTarball = syntheticNodeTarball('22.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});

export interface QaProcessOptions {
  readonly closeOk?: boolean;
  readonly startOk?: boolean;
}

/** QA-owned managed-process port; records calls, never a real DSH. */
export class QaProcess implements ManagedProcessPort {
  public starts = 0;
  public stops = 0;
  public closes = 0;
  private readonly options: QaProcessOptions;

  public constructor(options: QaProcessOptions = {}) {
    this.options = options;
  }

  public start(request: ProcessLifecycleRequest) {
    this.starts += 1;
    request.onPhase('running', 100);
    if (this.options.startOk === false) {
      return Promise.resolve(portFail('INTERNAL_ERROR', 'the start failed'));
    }
    return Promise.resolve(portOk({ pid: 4242, loopbackOrigin: 'http://127.0.0.1:53210' }));
  }

  public stop(request: ProcessLifecycleRequest) {
    this.stops += 1;
    request.onPhase('stopping', 50);
    return Promise.resolve(portOk({ wasRunning: true, pid: 4242 }));
  }

  public openWebUI() {
    return portOk({ loopbackOrigin: 'http://127.0.0.1:53210' });
  }

  public async recover() {
    const entries: readonly ProcessRecoveryEntry[] = [];
    return { entries };
  }

  public close() {
    this.closes += 1;
    return Promise.resolve(
      this.options.closeOk === false
        ? portFail('INTERNAL_ERROR', 'could not stop a process')
        : portOk(undefined),
    );
  }
}

export interface InstallGate {
  /** Resolves once the gated install actually started (in-flight). */
  readonly started: Promise<void>;
  release(): void;
  readonly aborted: () => boolean;
}

/** Wraps the real runtime but holds `install` until the test releases it. */
export const createGatedRuntime = (
  artifacts: string,
  onSettle?: () => void,
): { runtime: ManagedRuntimePort; gate: InstallGate } => {
  const real = createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    localArtifactDirectory: artifacts,
  });
  let resolveStarted: (() => void) | undefined;
  let resolveGate: (() => void) | undefined;
  let aborted = false;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const runtime: ManagedRuntimePort = {
    resolveComposition: (input) => real.resolveComposition(input),
    compositionDigest: (lock) => real.compositionDigest(lock),
    install: async (lock, destination, context) => {
      resolveStarted?.();
      const onAbort = (): void => {
        // Observe the cancel without finishing: the test decides when the
        // in-flight install actually ends, so the close-ordering window is
        // deterministic instead of racing the event loop.
        aborted = true;
      };
      context.signal.addEventListener('abort', onAbort, { once: true });
      await gate;
      context.signal.removeEventListener('abort', onAbort);
      // The writer has settled now, before close can proceed to release the lock.
      onSettle?.();
      if (aborted) {
        return portFail('INTERNAL_ERROR', 'the install was cancelled');
      }
      return real.install(lock, destination, context);
    },
  };
  return { runtime, gate: { started, release: () => resolveGate?.(), aborted: () => aborted } };
};

export interface LockHarness {
  readonly dataRoot: string;
  readonly managed: ManagedInstall;
  readonly process: QaProcess;
  readonly gate?: InstallGate;
  readonly dispatch: (method: string, input: unknown) => ContractResponse<unknown>;
}

const roots: string[] = [];

export const freshQaRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

export const cleanupQaRoots = (): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
};

export const buildLockHarness = async (
  options: {
    readonly dataRoot?: string;
    readonly process?: QaProcess;
    readonly gated?: boolean;
    readonly lockHeartbeatIntervalMs?: number;
    readonly lockStaleAfterMs?: number;
    /** Called when a gated install actually settles (for ordering evidence). */
    readonly onWriterSettle?: () => void;
  } = {},
): Promise<LockHarness> => {
  const dataRoot = options.dataRoot ?? freshQaRoot('hdsl-proc-lifecycle-');
  const artifacts = freshQaRoot('hdsl-proc-artifacts-');
  writeLocalArtifact(artifacts, sha256(nodeTarball), nodeTarball);
  writeLocalArtifact(artifacts, sha256(dshTarball), dshTarball);

  let runtime: ManagedRuntimePort;
  let gate: InstallGate | undefined;
  if (options.gated === true) {
    const gated = createGatedRuntime(artifacts, options.onWriterSettle);
    runtime = gated.runtime;
    gate = gated.gate;
  } else {
    runtime = createRuntimePort({
      closureInstall: false,
      precheck: 'none',
      localArtifactDirectory: artifacts,
    });
  }

  const process = options.process ?? new QaProcess();
  const managed = await createManagedInstall({
    dataRoot,
    catalog: [combination] as readonly RuntimeCombination[],
    runtime,
    processFactory: () => process,
    fixtures: { allowArtifactsOnly: true },
    lockWaitTimeoutMs: 200,
    ...(options.lockHeartbeatIntervalMs === undefined
      ? {}
      : { lockHeartbeatIntervalMs: options.lockHeartbeatIntervalMs }),
    ...(options.lockStaleAfterMs === undefined ? {} : { lockStaleAfterMs: options.lockStaleAfterMs }),
  });
  const contract = createContractRuntime({ port: managed.port as ContractPort });
  return {
    dataRoot,
    managed,
    process,
    ...(gate === undefined ? {} : { gate }),
    dispatch: (method, input) => contract.dispatch({ apiVersion: API_VERSION, method, input }),
  };
};

export const operationRef = (response: ContractResponse<unknown>): string => {
  if (!response.ok) {
    throw new Error(`expected ok, received ${response.error.code}`);
  }
  return (response.value as OperationRef).operationId;
};

export const createEnvironment = async (
  harness: LockHarness,
  requestId: string,
): Promise<string> => {
  const response = harness.dispatch('environments.create', {
    requestId,
    name: 'lock-qa',
    catalogCombinationId: combination.id,
  });
  const operationId = operationRef(response);
  const settled = await harness.managed.waitForOperation(operationId);
  if (settled.status !== 'succeeded') {
    throw new Error(`create did not succeed: ${settled.status}`);
  }
  return operationId;
};

export const canonical = canonicalizeDataRoot;

/** The synthetic catalog combination selected by this QA harness. */
export const qaCombinationId = combination.id;

export const createEnvironmentInput = (requestId: string) => ({
  requestId,
  name: 'lock-qa',
  catalogCombinationId: combination.id,
});
