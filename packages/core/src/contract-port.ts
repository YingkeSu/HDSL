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
  type GenerationSummary,
  type HostPlatform,
  type OpenWebUIResult,
  type OperationCommand,
  type OperationRef,
  type OperationSnapshot,
  type PreviewChangeCommand,
  type PortOutcome,
  type RevisionCommand,
  type RuntimeCombination,
} from '@hdsl/contracts';
import type {
  PluginInspectCommand,
  PluginSearchCommand,
} from '@hdsl/contracts';
import type { DiagnosticsExporter } from './ports.js';
import type { EnvironmentService } from './creation-service.js';
import type { PluginDiscoveryService } from './plugin-discovery-service.js';
import type { ChangePreviewService } from './plugin-preview.js';

export interface EnvironmentContractPortOptions {
  readonly service: EnvironmentService;
  readonly host?: HostPlatform;
  readonly catalog: readonly RuntimeCombination[];
  readonly exportDiagnostics?: DiagnosticsExporter;
  /**
   * Global read-only plugin discovery. Optional so the environment-only unit
   * tests keep a narrow surface; `main` always wires it.
   */
  readonly pluginDiscovery?: PluginDiscoveryService;
  /** Environment-scoped plugin change preview (ADR 0005 D6). */
  readonly changePreview?: ChangePreviewService;
}

const NOT_IMPLEMENTED = 'this capability is owned by the managed-process slice (T005/T006)';

export const createEnvironmentContractPort = (
  options: EnvironmentContractPortOptions,
): ContractPort => {
  const { service } = options;
  const exporter = options.exportDiagnostics;
  const pluginDiscovery = options.pluginDiscovery;
  const changePreview = options.changePreview;

  return {
    host: options.host ?? service.host,

    listCatalog(): PortOutcome<readonly RuntimeCombination[]> {
      return portOk(options.catalog);
    },

    listEnvironments(): PortOutcome<readonly EnvironmentSummary[]> {
      return service.listEnvironments();
    },

    listGenerations(environmentId: string): PortOutcome<readonly GenerationSummary[]> {
      return service.listGenerations(environmentId);
    },

    previewChange(command: PreviewChangeCommand): PortOutcome<OperationRef> {
      return changePreview === undefined
        ? portFail('INTERNAL_ERROR', 'the change preview adapter is not wired')
        : changePreview.previewChange(command);
    },

    findEnvironment(environmentId: string): PortOutcome<EnvironmentSummary> {
      return service.findEnvironment(environmentId);
    },

    findOperation(operationId: string): PortOutcome<OperationSnapshot> {
      const plugin = pluginDiscovery?.findOperation(operationId);
      return plugin ?? changePreview?.findOperation(operationId) ?? service.findOperation(operationId);
    },

    findCombination(combinationId: string): PortOutcome<RuntimeCombination> {
      return service.findCombination(combinationId);
    },

    createEnvironment(command: CreateEnvironmentCommand): PortOutcome<OperationRef> {
      return service.createEnvironment(command);
    },

    startEnvironment(command: RevisionCommand): PortOutcome<OperationRef> {
      return service.startEnvironment(command);
    },

    stopEnvironment(command: RevisionCommand): PortOutcome<OperationRef> {
      return service.stopEnvironment(command);
    },

    openWebUI(command: EnvironmentCommand): PortOutcome<OpenWebUIResult> {
      return service.openWebUI(command.environmentId);
    },

    cancelOperation(command: OperationCommand): PortOutcome<OperationSnapshot> {
      const plugin = pluginDiscovery?.cancelOperation(command.operationId);
      return plugin ?? changePreview?.cancelOperation(command.operationId) ?? service.cancelOperation(command.operationId);
    },

    searchPlugins(command: PluginSearchCommand): PortOutcome<OperationRef> {
      return pluginDiscovery === undefined
        ? portFail('INTERNAL_ERROR', NOT_IMPLEMENTED)
        : pluginDiscovery.search(command);
    },

    inspectPluginSource(command: PluginInspectCommand): PortOutcome<OperationRef> {
      return pluginDiscovery === undefined
        ? portFail('INTERNAL_ERROR', NOT_IMPLEMENTED)
        : pluginDiscovery.inspect(command);
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
