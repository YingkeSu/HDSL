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
  PortOutcome,
  RevisionCommand,
} from '../context.js';
import { portFail, portOk } from '../context.js';
import type {
  EnvironmentSummary,
  ExportResult,
  OpenWebUIResult,
  OperationKind,
  OperationRef,
  OperationSnapshot,
  RuntimeCombination,
} from '../dto.js';
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
  }

  listCatalog(): PortOutcome<readonly RuntimeCombination[]> {
    return portOk([...this.#catalog.values()]);
  }

  listEnvironments(): PortOutcome<readonly EnvironmentSummary[]> {
    return portOk([...this.#environments.values()]);
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
}
