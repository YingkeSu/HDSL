/**
 * Core-owned lifecycle for the global, read-only `versions.dsh` discovery
 * operation (A1 / #113).
 *
 * It mirrors {@link PluginDiscoveryService}: it owns the operation record in
 * the same durable `OperationStore`, runs the injected
 * {@link DshVersionSourcePort} outside the renderer/main request path with a
 * hard abort seam for cancellation, and writes the terminal
 * `DshVersionListing` to `OperationRecord.output`.
 *
 * It is global (`environmentId = null`), needs no credential, never touches an
 * environment composition and never runs plugin code. It only lists upstream
 * versions; selecting a version is the existing `environments.create` flow.
 */
import {
  contractErrorForCode,
  portFail,
  portOk,
  type ContractError,
  type DshVersionListing,
  type OperationRef,
  type OperationSnapshot,
  type PortOutcome,
} from '@hdsl/contracts';
import { newOperationId } from './ids.js';
import type { AppDataLayout } from './layout.js';
import { isTerminalStatus, OperationStore, toOperationSnapshot } from './operation-store.js';
import type { DshVersionSourcePort } from './version-source.js';

export interface VersionDiscoveryServiceOptions {
  readonly layout: AppDataLayout;
  readonly source: DshVersionSourcePort;
  readonly now?: () => Date;
}

/** Operation kind owned by this service. */
const VERSION_OPERATION_KINDS: ReadonlySet<string> = new Set(['versions']);

export class VersionDiscoveryService {
  readonly #store: OperationStore;
  readonly #source: DshVersionSourcePort;
  readonly #now: () => Date;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: VersionDiscoveryServiceOptions) {
    this.#store = new OperationStore(options.layout);
    this.#source = options.source;
    this.#now = options.now ?? (() => new Date());
  }

  /** True when this service owns the operation id. */
  owns(operationId: string): boolean {
    const record = this.#store.read(operationId);
    return record !== undefined && VERSION_OPERATION_KINDS.has(record.kind);
  }

  findOperation(operationId: string): PortOutcome<OperationSnapshot> | undefined {
    if (!this.owns(operationId)) {
      return undefined;
    }
    const record = this.#store.read(operationId);
    return record === undefined
      ? portFail('NOT_FOUND', 'operation was not found')
      : portOk(toOperationSnapshot(record));
  }

  /** Starts a cancellable upstream version listing; returns immediately. */
  listVersions(): PortOutcome<OperationRef> {
    return this.#start((signal) => this.#source.listVersions(signal));
  }

  cancelOperation(operationId: string): PortOutcome<OperationSnapshot> | undefined {
    if (!this.owns(operationId)) {
      return undefined;
    }
    const record = this.#store.read(operationId);
    if (record === undefined) {
      return portFail('NOT_FOUND', 'operation was not found');
    }
    if (isTerminalStatus(record.status)) {
      return portFail('CANNOT_CANCEL', 'operation already reached a final state');
    }
    this.#controllers.get(operationId)?.abort();
    this.#controllers.delete(operationId);
    const cancelled = this.#store.update(
      record,
      { status: 'cancelled', phase: 'cancelled' },
      this.#now().toISOString(),
    );
    return portOk(toOperationSnapshot(cancelled));
  }

  #start(
    task: (signal: AbortSignal) => Promise<PortOutcome<DshVersionListing>>,
  ): PortOutcome<OperationRef> {
    const operationId = newOperationId();
    const controller = new AbortController();
    this.#store.create({
      id: operationId,
      kind: 'versions',
      environmentId: null,
      phase: 'reading registry',
      status: 'running',
      createdAt: this.#now().toISOString(),
    });
    this.#controllers.set(operationId, controller);
    void this.#run(operationId, task, controller.signal);
    return portOk({ operationId });
  }

  async #run(
    operationId: string,
    task: (signal: AbortSignal) => Promise<PortOutcome<DshVersionListing>>,
    signal: AbortSignal,
  ): Promise<void> {
    let outcome: PortOutcome<DshVersionListing>;
    try {
      outcome = await task(signal);
    } catch {
      outcome = portFail('INTERNAL_ERROR', 'the version source threw');
    }
    this.#controllers.delete(operationId);
    const record = this.#store.read(operationId);
    if (record === undefined || isTerminalStatus(record.status)) {
      return;
    }
    const now = this.#now().toISOString();
    if (outcome.ok) {
      this.#store.update(
        record,
        { status: 'succeeded', phase: 'finished', output: outcome.value },
        now,
      );
      return;
    }
    const error: ContractError = contractErrorForCode(
      outcome.code,
      outcome.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: outcome.retryAfterSeconds },
    );
    this.#store.update(record, { status: 'failed', phase: 'failed', error }, now);
  }
}
