/**
 * Adapter from the frozen `ContractPort` to a real {@link EnvironmentService}.
 *
 * Creation, listing and operation lookup are fully implemented here. Process
 * start/stop, WebUI opening and diagnostics export belong to T005/T006; they are
 * delegated to an optionally injected port and otherwise fail with a controlled
 * `INTERNAL_ERROR` instead of pretending to have started a process.
 */
import {
  portFail,
  portOk,
  type ContractPort,
  type CreateEnvironmentCommand,
  type EnvironmentCommand,
  type EnvironmentSummary,
  type HostPlatform,
  type OpenWebUIResult,
  type OperationCommand,
  type OperationRef,
  type OperationSnapshot,
  type PortOutcome,
  type RevisionCommand,
  type RuntimeCombination,
} from '@hdsl/contracts';
import type { DiagnosticsExporter, ProcessLifecyclePort } from './ports.js';
import type { EnvironmentService } from './creation-service.js';

export interface EnvironmentContractPortOptions {
  readonly service: EnvironmentService;
  readonly host?: HostPlatform;
  readonly catalog: readonly RuntimeCombination[];
  readonly process?: ProcessLifecyclePort;
  readonly exportDiagnostics?: DiagnosticsExporter;
}

const NOT_IMPLEMENTED = 'this capability is owned by the managed-process slice (T005/T006)';

export const createEnvironmentContractPort = (
  options: EnvironmentContractPortOptions,
): ContractPort => {
  const { service } = options;
  const processPort = options.process;
  const exporter = options.exportDiagnostics;

  return {
    host: options.host ?? service.host,

    listCatalog(): PortOutcome<readonly RuntimeCombination[]> {
      return portOk(options.catalog);
    },

    listEnvironments(): PortOutcome<readonly EnvironmentSummary[]> {
      return service.listEnvironments();
    },

    findEnvironment(environmentId: string): PortOutcome<EnvironmentSummary> {
      return service.findEnvironment(environmentId);
    },

    findOperation(operationId: string): PortOutcome<OperationSnapshot> {
      return service.findOperation(operationId);
    },

    findCombination(combinationId: string): PortOutcome<RuntimeCombination> {
      return service.findCombination(combinationId);
    },

    createEnvironment(command: CreateEnvironmentCommand): PortOutcome<OperationRef> {
      return service.createEnvironment(command);
    },

    startEnvironment(command: RevisionCommand): PortOutcome<OperationRef> {
      return processPort === undefined
        ? portFail('INTERNAL_ERROR', NOT_IMPLEMENTED)
        : processPort.start(command.environmentId, command.expectedRevision);
    },

    stopEnvironment(command: RevisionCommand): PortOutcome<OperationRef> {
      return processPort === undefined
        ? portFail('INTERNAL_ERROR', NOT_IMPLEMENTED)
        : processPort.stop(command.environmentId, command.expectedRevision);
    },

    openWebUI(command: EnvironmentCommand): PortOutcome<OpenWebUIResult> {
      return processPort === undefined
        ? portFail('INTERNAL_ERROR', NOT_IMPLEMENTED)
        : processPort.openWebUI(command.environmentId);
    },

    cancelOperation(command: OperationCommand): PortOutcome<OperationSnapshot> {
      return service.cancelOperation(command.operationId);
    },

    exportDiagnostics(command: EnvironmentCommand) {
      return exporter === undefined
        ? portFail('INTERNAL_ERROR', NOT_IMPLEMENTED)
        : exporter(command.environmentId);
    },

    readIdempotency: (requestId) => service.readIdempotency(requestId),
    writeIdempotency: (requestId, record) => {
      service.writeIdempotency(requestId, record);
    },
  };
};
