/**
 * Public entry point for the T004/T005 slices: a real, durable managed-install
 * port wired to a core environment/lifecycle service.
 *
 * ```ts
 * import { createManagedInstall } from '@hdsl/core';
 * import { createRuntimePort } from '@hdsl/runtime';
 *
 * const runtime = createRuntimePort();
 * const { port, service, available, recover, close } = await createManagedInstall({
 *   dataRoot,
 *   catalog: VERIFIED_COMBINATIONS,
 *   runtime,
 *   processFactory: (service) =>
 *     createManagedProcess({ onProcessExit: (info) => service.handleProcessExit(info) }),
 * });
 * ```
 *
 * `@hdsl/core` and `@hdsl/runtime` are siblings (no dependency edge), so the
 * caller wires both ports in. When the exclusive data-root lease cannot be
 * acquired, the returned install is explicitly `available: false`: reads work,
 * every mutating call fails with `ENVIRONMENT_BUSY`, `recover()` is refused and
 * `close()` does not pretend the root was released.
 */
import type {
  ContractPort,
  HostPlatform,
  OperationSnapshot,
  RuntimeCombination,
} from '@hdsl/contracts';
import {
  EnvironmentService,
  type CloseReport,
  type CreationFaults,
  type EnvironmentServiceOptions,
  type RecoveryReport,
} from './creation-service.js';
import { createEnvironmentContractPort } from './contract-port.js';
import type { DataRootLockSnapshot } from './data-root-lock.js';
import type {
  DiagnosticsExporter,
  ManagedProcessExit,
  ManagedProcessPort,
  ManagedRuntimePort,
} from './ports.js';

export interface ManagedInstallOptions {
  /** Root for every durable record, artifact, journal and managed generation. */
  readonly dataRoot: string;
  readonly catalog: readonly RuntimeCombination[];
  readonly runtime: ManagedRuntimePort;
  readonly host?: HostPlatform;
  readonly clock?: () => Date;
  readonly faults?: CreationFaults;
  readonly process?: ManagedProcessPort;
  /**
   * Builds the managed-process module once the service exists, so the module
   * can receive `service.handleProcessExit` as its exit callback.
   */
  readonly processFactory?: (service: EnvironmentService) => ManagedProcessPort;
  readonly exportDiagnostics?: DiagnosticsExporter;
  readonly operationTimeoutMs?: number;
  readonly lockWaitTimeoutMs?: number;
  readonly lockPollIntervalMs?: number;
  readonly lockHeartbeatIntervalMs?: number;
  readonly lockStaleAfterMs?: number;
  /** Alias for {@link ManagedInstallOptions.operationTimeoutMs}. */
  readonly limits?: { readonly operationTimeoutMs?: number };
  /**
   * Test-only. The production creation path refuses to commit an
   * `artifacts-only` generation; a fixture harness may opt in explicitly, and
   * the generation still records `installMode: 'artifacts-only'`.
   */
  readonly allowArtifactsOnly?: boolean;
  /** Alias for {@link ManagedInstallOptions.allowArtifactsOnly}. */
  readonly fixtures?: { readonly allowArtifactsOnly?: boolean };
}

export interface ManagedInstall {
  readonly port: ContractPort;
  readonly service: EnvironmentService;
  /** False when another instance holds the exclusive data-root lease. */
  readonly available: boolean;
  recover(): Promise<RecoveryReport>;
  waitForOperation(
    operationId: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<OperationSnapshot>;
  /** Wires a process module built after the service (see processFactory). */
  attachProcess(port: ManagedProcessPort): void;
  /** Runtime exit callback; marks the environment stopped / operation failed. */
  handleProcessExit(info: ManagedProcessExit): void;
  /** Queryable lock owner identity / ABA credential / refusal reasons. */
  lockSnapshot(): DataRootLockSnapshot;
  close(): Promise<CloseReport>;
}

export const createManagedInstall = async (
  options: ManagedInstallOptions,
): Promise<ManagedInstall> => {
  const serviceOptions: EnvironmentServiceOptions = {
    dataRoot: options.dataRoot,
    catalog: options.catalog,
    runtime: options.runtime,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(options.exportDiagnostics === undefined
      ? {}
      : { exportDiagnostics: options.exportDiagnostics }),
    ...(options.lockWaitTimeoutMs === undefined
      ? {}
      : { lockWaitTimeoutMs: options.lockWaitTimeoutMs }),
    ...(options.lockPollIntervalMs === undefined
      ? {}
      : { lockPollIntervalMs: options.lockPollIntervalMs }),
    ...(options.lockHeartbeatIntervalMs === undefined
      ? {}
      : { lockHeartbeatIntervalMs: options.lockHeartbeatIntervalMs }),
    ...(options.lockStaleAfterMs === undefined ? {} : { lockStaleAfterMs: options.lockStaleAfterMs }),
    ...(options.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(options.limits?.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: options.limits.operationTimeoutMs }),
    ...(options.allowArtifactsOnly === undefined
      ? {}
      : { allowArtifactsOnly: options.allowArtifactsOnly }),
    ...(options.fixtures?.allowArtifactsOnly === undefined
      ? {}
      : { allowArtifactsOnly: options.fixtures.allowArtifactsOnly }),
  };
  const service = new EnvironmentService(serviceOptions);
  await service.open();
  if (options.processFactory !== undefined) {
    service.attachProcess(options.processFactory(service));
  }
  const port = createEnvironmentContractPort({
    service,
    catalog: options.catalog,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.exportDiagnostics === undefined
      ? {}
      : { exportDiagnostics: options.exportDiagnostics }),
  });

  return {
    port,
    service,
    available: service.available,
    recover: () => service.recover(),
    waitForOperation: (operationId, waitOptions) =>
      waitOptions === undefined
        ? service.waitForOperation(operationId)
        : service.waitForOperation(operationId, waitOptions),
    attachProcess: (process) => {
      service.attachProcess(process);
    },
    handleProcessExit: (info) => {
      service.handleProcessExit(info);
    },
    lockSnapshot: () => service.lockSnapshot(),
    close: () => service.close(),
  };
};
