/**
 * TEST/FIXTURE ONLY in-memory context port.
 *
 * This is **not** persistence and not launcher behavior. It exists so the
 * contract (T003) can be exercised end to end without inventing the real
 * storage, install, process or credential work owned by T004–T006. The
 * idempotency ledger and operation records here live in memory and evaporate on
 * restart; it therefore proves the contract's *semantics*, never durable
 * idempotency or recovery. Downstream must implement {@link ContractPort}
 * against the real operation journal.
 */
import type {
  ContractPort,
  CreateEnvironmentCommand,
  EnvironmentCommand,
  IdempotencyRecord,
  OperationCommand,
  PluginInspectCommand,
  PreviewChangeCommand,
  PluginSearchCommand,
  PortOutcome,
  RevisionCommand,
} from '../context.js';
import { portFail, portOk } from '../context.js';
import type {
  EnvironmentSummary,
  ExportResult,
  GenerationSummary,
  OpenWebUIResult,
  OperationKind,
  OperationRef,
  OperationSnapshot,
  PluginInspection,
  PluginSearchResult,
  RuntimeCombination,
} from '../dto.js';
import { isRetryable, type ErrorCode } from '../errors.js';
import type { HostPlatform } from '../platform.js';

export interface ReferenceSeed {
  readonly host: HostPlatform;
  readonly catalog: readonly RuntimeCombination[];
  readonly environments: readonly EnvironmentSummary[];
  readonly operations: readonly OperationSnapshot[];
  /** Port-owned loopback origins for environments that can open WebUI. */
  readonly webUIEndpoints?: Readonly<Record<string, string>>;
  /** Forces `diagnostics.export` to fail, for EXPORT_FAILED coverage. */
  readonly failExport?: boolean;
  /** Forces `openWebUI` to return a token-bearing URL, to prove main rejects it. */
  readonly webUIOriginOverride?: string;
  /** Terminal payload (or controlled failure) for `plugins.search`. */
  readonly pluginSearch?: {
    readonly result?: PluginSearchResult;
    readonly failure?: ErrorCode;
    readonly retryAfterSeconds?: number;
  };
  /** Terminal payload (or controlled failure) for `plugins.inspect`. */
  readonly pluginInspection?: {
    readonly result?: PluginInspection;
    readonly failure?: ErrorCode;
  };
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:53123';

/**
 * Mutable in-memory reference port. Every mutating call records an entry in
 * {@link ReferenceContractPort.effects} so tests can assert that a replayed
 * idempotent request did not repeat a side effect.
 */
export class ReferenceContractPort implements ContractPort {
  readonly host: HostPlatform;
  readonly effects: string[] = [];

  readonly #catalog = new Map<string, RuntimeCombination>();
  readonly #environments = new Map<string, EnvironmentSummary>();
  readonly #operations = new Map<string, OperationSnapshot>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #endpoints = new Map<string, string>();
  readonly #failExport: boolean;
  readonly #webUIOriginOverride: string | undefined;
  readonly #pluginSearch: ReferenceSeed['pluginSearch'];
  readonly #pluginInspection: ReferenceSeed['pluginInspection'];
  #environmentCounter = 0;
  #operationCounter = 0;
  #exportCounter = 0;

  constructor(seed: ReferenceSeed) {
    this.host = seed.host;
    for (const combination of seed.catalog) {
      this.#catalog.set(combination.id, combination);
    }
    for (const environment of seed.environments) {
      this.#environments.set(environment.id, environment);
    }
    for (const operation of seed.operations) {
      this.#operations.set(operation.id, operation);
    }
    for (const [environmentId, origin] of Object.entries(seed.webUIEndpoints ?? {})) {
      this.#endpoints.set(environmentId, origin);
    }
    this.#failExport = seed.failExport ?? false;
    this.#webUIOriginOverride = seed.webUIOriginOverride;
    this.#pluginSearch = seed.pluginSearch;
    this.#pluginInspection = seed.pluginInspection;
  }

  listCatalog(): PortOutcome<readonly RuntimeCombination[]> {
    return portOk([...this.#catalog.values()]);
  }

  listEnvironments(): PortOutcome<readonly EnvironmentSummary[]> {
    return portOk([...this.#environments.values()]);
  }

  listGenerations(_environmentId: string): PortOutcome<readonly GenerationSummary[]> {
    return portOk([]);
  }

  findEnvironment(environmentId: string): PortOutcome<EnvironmentSummary> {
    const environment = this.#environments.get(environmentId);
    return environment === undefined
      ? portFail('NOT_FOUND', 'environment was not found')
      : portOk(environment);
  }

  findOperation(operationId: string): PortOutcome<OperationSnapshot> {
    const operation = this.#operations.get(operationId);
    return operation === undefined
      ? portFail('NOT_FOUND', 'operation was not found')
      : portOk(operation);
  }

  findCombination(combinationId: string): PortOutcome<RuntimeCombination> {
    const combination = this.#catalog.get(combinationId);
    return combination === undefined
      ? portFail('NOT_FOUND', 'catalog combination was not found')
      : portOk(combination);
  }

  createEnvironment(command: CreateEnvironmentCommand): PortOutcome<OperationRef> {
    const environmentId = `env-${String((this.#environmentCounter += 1))}`;
    const environment: EnvironmentSummary = {
      id: environmentId,
      name: command.name,
      revision: 0,
      stateVersion: 0,
      state: 'stopped',
      activeGenerationId: null,
      compositionDigest: null,
    };
    this.#environments.set(environmentId, environment);
    const operation = this.#recordOperation('create', environmentId, 'succeeded');
    this.effects.push(`createEnvironment:${environmentId}`);
    return portOk({ operationId: operation.id });
  }

  startEnvironment(command: RevisionCommand): PortOutcome<OperationRef> {
    const environment = this.#environments.get(command.environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    if (environment.state === 'running' || environment.state === 'starting') {
      return portFail('ENVIRONMENT_BUSY', 'environment is already running');
    }
    this.#environments.set(environment.id, {
      ...environment,
      state: 'running',
      stateVersion: environment.stateVersion + 1,
    });
    this.#endpoints.set(environment.id, DEFAULT_ENDPOINT);
    const operation = this.#recordOperation('start', environment.id, 'succeeded');
    this.effects.push(`startEnvironment:${environment.id}`);
    return portOk({ operationId: operation.id });
  }

  stopEnvironment(command: RevisionCommand): PortOutcome<OperationRef> {
    const environment = this.#environments.get(command.environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    if (environment.state !== 'running' && environment.state !== 'starting') {
      return portFail('ENVIRONMENT_BUSY', 'environment is not running');
    }
    this.#environments.set(environment.id, {
      ...environment,
      state: 'stopped',
      stateVersion: environment.stateVersion + 1,
    });
    this.#endpoints.delete(environment.id);
    const operation = this.#recordOperation('stop', environment.id, 'succeeded');
    this.effects.push(`stopEnvironment:${environment.id}`);
    return portOk({ operationId: operation.id });
  }

  openWebUI(command: EnvironmentCommand): PortOutcome<OpenWebUIResult> {
    const environment = this.#environments.get(command.environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    if (environment.state !== 'running') {
      return portFail('WEBUI_UNAVAILABLE', 'environment is not running');
    }
    if (this.#webUIOriginOverride !== undefined) {
      return portOk({ loopbackOrigin: this.#webUIOriginOverride });
    }
    const endpoint = this.#endpoints.get(command.environmentId);
    if (endpoint === undefined) {
      return portFail('WEBUI_UNAVAILABLE', 'no verified loopback endpoint is owned by this environment');
    }
    this.effects.push(`openWebUI:${command.environmentId}`);
    return portOk({ loopbackOrigin: endpoint });
  }

  cancelOperation(command: OperationCommand): PortOutcome<OperationSnapshot> {
    const operation = this.#operations.get(command.operationId);
    if (operation === undefined) {
      return portFail('NOT_FOUND', 'operation was not found');
    }
    if (operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'cancelled') {
      return portFail('CANNOT_CANCEL', 'operation already reached a final state');
    }
    const cancelled: OperationSnapshot = {
      ...operation,
      status: 'cancelled',
      sequence: operation.sequence + 1,
    };
    this.#operations.set(cancelled.id, cancelled);
    this.effects.push(`cancelOperation:${cancelled.id}`);
    return portOk(cancelled);
  }

  exportDiagnostics(command: EnvironmentCommand): PortOutcome<ExportResult> {
    if (this.#failExport) {
      return portFail('EXPORT_FAILED', 'diagnostic export failed before producing a file');
    }
    this.#exportCounter += 1;
    this.effects.push(`exportDiagnostics:${command.environmentId}`);
    return portOk({
      exportId: `export-${String(this.#exportCounter)}`,
      exported: true,
      redacted: true,
    });
  }

  searchPlugins(command: PluginSearchCommand): PortOutcome<OperationRef> {
    const config = this.#pluginSearch;
    if (config?.failure !== undefined) {
      const failed = this.#recordPluginOperation('search', {
        status: 'failed',
        error: config.failure,
        ...(config.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: config.retryAfterSeconds }),
      });
      this.effects.push(`searchPlugins:${failed.id}`);
      return portOk({ operationId: failed.id });
    }
    const result = config?.result ?? defaultPluginSearchResult(command.query);
    const operation = this.#recordPluginOperation('search', { status: 'succeeded', output: result });
    this.effects.push(`searchPlugins:${operation.id}`);
    return portOk({ operationId: operation.id });
  }

  previewChange(command: PreviewChangeCommand): PortOutcome<OperationRef> {
    const environment = this.#environments.get(command.environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    if (environment.revision !== command.expectedRevision) {
      return portFail('REVISION_CONFLICT', 'expectedRevision does not match the current composition revision');
    }
    if (command.action.kind !== 'install') {
      return portFail('INTERNAL_ERROR', 'remove preview is not implemented in this slice');
    }
    const plan = {
      planId: 'plan-0000000000000001',
      environmentId: command.environmentId,
      baseRevision: command.expectedRevision,
      action: command.action,
      createdAt: '2026-09-20T00:00:00.000Z',
      expiresAt: '2026-09-20T00:15:00.000Z',
      sourceLock: {
        sourceKind: 'github' as const,
        repository: { owner: command.action.source.owner, name: command.action.source.name },
        commitSha: 'a'.repeat(40),
        ref: command.action.source.ref ?? null,
        packageName: command.action.source.name,
        packageVersion: '1.0.0',
        manifestSha256: 'b'.repeat(64),
        closureLockSha256: null,
        isBuiltin: false,
        buildAuthorization: null,
        executor: null,
      },
      scriptAssessment: 'none-detected' as const,
      scripts: [],
      requiresBuildAuthorization: false,
      riskItems: ['no install-time scripts detected in the parsed manifest'],
      removals: [],
      retention: [],
      blockingReferences: [],
      executor: null,
      planInputsDigest: 'c'.repeat(64),
    };
    const operation = this.#recordPluginOperation('preview', { status: 'succeeded', output: plan });
    this.effects.push(`previewChange:${operation.id}`);
    return portOk({ operationId: operation.id });
  }

  inspectPluginSource(command: PluginInspectCommand): PortOutcome<OperationRef> {
    const config = this.#pluginInspection;
    if (config?.failure !== undefined) {
      const failed = this.#recordPluginOperation('inspect', {
        status: 'failed',
        error: config.failure,
      });
      this.effects.push(`inspectPluginSource:${failed.id}`);
      return portOk({ operationId: failed.id });
    }
    const result =
      config?.result ??
      defaultPluginInspection(command.source.owner, command.source.name, command.source.ref);
    const operation = this.#recordPluginOperation('inspect', { status: 'succeeded', output: result });
    this.effects.push(`inspectPluginSource:${operation.id}`);
    return portOk({ operationId: operation.id });
  }

  readIdempotency(requestId: string): IdempotencyRecord | undefined {
    return this.#idempotency.get(requestId);
  }

  writeIdempotency(requestId: string, record: IdempotencyRecord): void {
    this.#idempotency.set(requestId, record);
  }

  #recordOperation(
    kind: OperationKind,
    environmentId: string,
    status: OperationSnapshot['status'],
  ): OperationSnapshot {
    const operation: OperationSnapshot = {
      id: `op-${String((this.#operationCounter += 1))}`,
      environmentId,
      kind,
      phase: 'finished',
      status,
      sequence: 1,
    };
    this.#operations.set(operation.id, operation);
    return operation;
  }

  #recordPluginOperation(
    kind: 'search' | 'inspect' | 'preview',
    terminal: {
      readonly status: 'succeeded' | 'failed';
      readonly output?: unknown;
      readonly error?: ErrorCode;
      readonly retryAfterSeconds?: number;
    },
  ): OperationSnapshot {
    const operation: OperationSnapshot = {
      id: `op-${String((this.#operationCounter += 1))}`,
      environmentId: null,
      kind,
      phase: terminal.status === 'succeeded' ? 'finished' : 'failed',
      status: terminal.status,
      sequence: 1,
      ...(terminal.output === undefined ? {} : { output: terminal.output }),
      ...(terminal.error === undefined
        ? {}
        : {
            error: {
              code: terminal.error,
              message: `plugin fixture failure (${terminal.error})`,
              retryable: isRetryable(terminal.error),
              ...(terminal.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: terminal.retryAfterSeconds }),
            },
          }),
    };
    this.#operations.set(operation.id, operation);
    return operation;
  }
}

/** Deterministic fixture payload used when a seed does not supply one. */
export const defaultPluginSearchResult = (query: string): PluginSearchResult => ({
  query,
  hits: [
    {
      fullName: 'octo/dsh-plugin-demo',
      owner: 'octo',
      name: 'dsh-plugin-demo',
      description: 'fixture repository',
      htmlUrl: 'https://github.com/octo/dsh-plugin-demo',
      stars: 12,
      topics: ['dsh-plugin'],
      defaultBranch: 'main',
      updatedAt: '2026-01-02T03:04:05Z',
      archived: false,
      fork: false,
      license: 'MIT',
    },
  ],
  totalCount: 1,
  incompleteResults: false,
  hasMore: false,
  fetchedAt: '2026-01-02T03:04:05Z',
  fromCache: false,
});

export const defaultPluginInspection = (
  owner: string,
  name: string,
  ref?: string,
): PluginInspection => ({
  source: { owner, name, ...(ref === undefined ? {} : { ref }) },
  repository: {
    fullName: `${owner}/${name}`,
    description: 'fixture repository',
    htmlUrl: `https://github.com/${owner}/${name}`,
    stars: 12,
    topics: ['dsh-plugin'],
    defaultBranch: 'main',
    updatedAt: '2026-01-02T03:04:05Z',
    archived: false,
    fork: false,
    license: 'MIT',
    homepage: null,
  },
  fetchedAt: '2026-01-02T03:04:05Z',
  fromCache: false,
});
