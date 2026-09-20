/**
 * Public entry point for the T004 slice: a real, durable managed-install port.
 *
 * ```ts
 * import { createManagedInstall } from '@hdsl/core';
 * import { createRuntimePort, VERIFIED_COMBINATIONS } from '@hdsl/runtime';
 *
 * const runtime = createRuntimePort();
 * const { port, service, recover, waitForOperation, close } = await createManagedInstall({
 *   dataRoot,
 *   catalog: VERIFIED_COMBINATIONS,
 *   runtime,
 * });
 * ```
 *
 * `@hdsl/core` and `@hdsl/runtime` are siblings (no dependency edge), so the
 * caller wires the runtime port in. `createContractRuntime({ port })` then
 * exposes the frozen `dispatch` surface.
 */
import type { ContractPort, HostPlatform, OperationSnapshot, RuntimeCombination } from '@hdsl/contracts';
import {
  EnvironmentService,
  type CreationFaults,
  type EnvironmentServiceOptions,
  type RecoveryReport,
} from './creation-service.js';
import { createEnvironmentContractPort } from './contract-port.js';
import type { DiagnosticsExporter, ManagedRuntimePort, ProcessLifecyclePort } from './ports.js';

export interface ManagedInstallOptions {
  /** Root for every durable record, artifact, journal and managed generation. */
  readonly dataRoot: string;
  readonly catalog: readonly RuntimeCombination[];
  readonly runtime: ManagedRuntimePort;
  readonly host?: HostPlatform;
  readonly clock?: () => Date;
  readonly faults?: CreationFaults;
  readonly process?: ProcessLifecyclePort;
  readonly exportDiagnostics?: DiagnosticsExporter;
  readonly operationTimeoutMs?: number;
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
  recover(): RecoveryReport;
  waitForOperation(
    operationId: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<OperationSnapshot>;
  close(): Promise<void>;
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
  const port = createEnvironmentContractPort({
    service,
    catalog: options.catalog,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.process === undefined ? {} : { process: options.process }),
    ...(options.exportDiagnostics === undefined
      ? {}
      : { exportDiagnostics: options.exportDiagnostics }),
  });

  return {
    port,
    service,
    recover: () => service.recover(),
    waitForOperation: (operationId, waitOptions) =>
      waitOptions === undefined
        ? service.waitForOperation(operationId)
        : service.waitForOperation(operationId, waitOptions),
    close: () => service.close(),
  };
};
