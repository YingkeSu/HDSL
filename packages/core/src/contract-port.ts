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
  type EntryPatchCommand,
  type EntryPatchResult,
  type EnvironmentCommand,
  type EnvironmentSummary,
  type GenerationSummary,
  type HostPlatform,
  type OpenWebUIResult,
  type OperationCommand,
  type OperationRef,
  type InstalledPluginsView,
  type OperationSnapshot,
  type PreviewChangeCommand,
  type ApplyChangeCommand,
  type RestoreGenerationCommand,
  type PortOutcome,
  type RevisionCommand,
  type RuntimeCombination,
  type SwitchCombinationCommand,
} from '@hdsl/contracts';
import type {
  PluginInspectCommand,
  PluginSearchCommand,
} from '@hdsl/contracts';
import type { DshVersionCommand } from '@hdsl/contracts';
import type { ExpectedCompositionCommand } from '@hdsl/contracts';
import type { DiagnosticsExporter, InstalledPluginsPort } from './ports.js';
import type { EnvironmentService } from './creation-service.js';
import type { PluginDiscoveryService } from './plugin-discovery-service.js';
import type { VersionDiscoveryService } from './version-discovery-service.js';
import type { ExpectedCompositionService } from './expected-composition-service.js';
import type { EntryPatchService } from './entry-patch-service.js';
import type { ChangePreviewService } from './plugin-preview.js';
import type { ChangeApplyService } from './plugin-apply.js';

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
  /** Global read-only upstream DSH version discovery (`versions.dsh`, A1/#113). */
  readonly versionDiscovery?: VersionDiscoveryService;
  /** Environment-scoped read-only expected composition (`compositions.expected`, #118). */
  readonly expectedComposition?: ExpectedCompositionService;
  /** Environment-scoped desired-config home patch edit (`entries.patch`, #135). */
  readonly entryPatch?: EntryPatchService;
  /** Environment-scoped plugin change preview (ADR 0005 D6). */
  readonly changePreview?: ChangePreviewService;
  /** Environment-scoped plugin change apply (ADR 0005 D8). */
  readonly changeApply?: ChangeApplyService;
  /** Read-only installed-plugin list of the active generation (`plugins.installed`). */
  readonly installedPlugins?: InstalledPluginsPort;
}

const NOT_IMPLEMENTED = 'this capability is owned by the managed-process slice (T005/T006)';

export const createEnvironmentContractPort = (
  options: EnvironmentContractPortOptions,
): ContractPort => {
  const { service } = options;
  const exporter = options.exportDiagnostics;
  const pluginDiscovery = options.pluginDiscovery;
  const versionDiscovery = options.versionDiscovery;
  const expectedComposition = options.expectedComposition;
  const changePreview = options.changePreview;
  const changeApply = options.changeApply;

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

    listInstalledPlugins(environmentId: string): PortOutcome<InstalledPluginsView> {
      return options.installedPlugins === undefined
        ? portFail('INTERNAL_ERROR', NOT_IMPLEMENTED)
        : options.installedPlugins.list(environmentId);
    },

    previewChange(command: PreviewChangeCommand): PortOutcome<OperationRef> {
      return changePreview === undefined
        ? portFail('INTERNAL_ERROR', 'the change preview adapter is not wired')
        : changePreview.previewChange(command);
    },

    applyChange(command: ApplyChangeCommand): PortOutcome<OperationRef> {
      return changeApply === undefined
        ? portFail('INTERNAL_ERROR', 'the change apply transaction is not wired')
        : changeApply.applyChange(command);
    },

    restoreGeneration(command: RestoreGenerationCommand): PortOutcome<OperationRef> {
      return changeApply === undefined
        ? portFail('INTERNAL_ERROR', 'the generation restore transaction is not wired')
        : changeApply.restoreGeneration(command);
    },

    findEnvironment(environmentId: string): PortOutcome<EnvironmentSummary> {
      return service.findEnvironment(environmentId);
    },

    findOperation(operationId: string): PortOutcome<OperationSnapshot> {
      const plugin = pluginDiscovery?.findOperation(operationId);
      return (
        plugin ??
        versionDiscovery?.findOperation(operationId) ??
        expectedComposition?.findOperation(operationId) ??
        changePreview?.findOperation(operationId) ??
        changeApply?.findOperation(operationId) ??
        service.findOperation(operationId)
      );
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

    switchCombination(command: SwitchCombinationCommand): PortOutcome<OperationRef> {
      return service.switchCombination(command);
    },

    openWebUI(command: EnvironmentCommand): PortOutcome<OpenWebUIResult> {
      return service.openWebUI(command.environmentId);
    },

    cancelOperation(command: OperationCommand): PortOutcome<OperationSnapshot> {
      const plugin = pluginDiscovery?.cancelOperation(command.operationId);
      return (
        plugin ??
        versionDiscovery?.cancelOperation(command.operationId) ??
        expectedComposition?.cancelOperation(command.operationId) ??
        changePreview?.cancelOperation(command.operationId) ??
        changeApply?.cancelOperation(command.operationId) ??
        service.cancelOperation(command.operationId)
      );
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

    listDshVersions(_command: DshVersionCommand): PortOutcome<OperationRef> {
      return versionDiscovery === undefined
        ? portFail('INTERNAL_ERROR', NOT_IMPLEMENTED)
        : versionDiscovery.listVersions();
    },

    describeExpectedComposition(command: ExpectedCompositionCommand): PortOutcome<OperationRef> {
      return expectedComposition === undefined
        ? portFail('INTERNAL_ERROR', 'the expected-composition reader is not wired')
        : expectedComposition.describe(command.environmentId);
    },

    patchEntry(command: EntryPatchCommand): PortOutcome<EntryPatchResult> {
      return options.entryPatch === undefined
        ? portFail('INTERNAL_ERROR', 'the desired-config entry patch service is not wired')
        : options.entryPatch.patchEntry(command);
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
