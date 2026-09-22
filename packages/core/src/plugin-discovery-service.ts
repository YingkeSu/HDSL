/**
 * Core-owned lifecycle for the global, read-only plugin discovery operations
 * (`plugins.search` / `plugins.inspect`).
 *
 * Responsibilities (ADR 0005 D5/D10/D17):
 * - own the operation record in the same durable `OperationStore` as every
 *   other operation, so `operations.get`/`subscribe`/`cancel` work unchanged;
 * - run the injected {@link PluginSourcePort} outside the renderer/main
 *   request path, with a hard abort seam for cancellation;
 * - write the terminal payload to `OperationRecord.output` on success and a
 *   controlled error code on failure;
 * - report cancellation as a final state with **no** environment side effect;
 * - never touch an environment, never change a composition, and never receive a
 *   GitHub credential.
 *
 * It is global: `environmentId` is always `null`, so an environment
 * `ENVIRONMENT_BUSY` can never block it (D5).
 */
import {
  contractErrorForCode,
  portFail,
  portOk,
  type ContractError,
  type OperationRef,
  type OperationSnapshot,
  type PluginInspectCommand,
  type PluginSearchCommand,
  type PortOutcome,
} from '@hdsl/contracts';
import { newOperationId } from './ids.js';
import type { AppDataLayout } from './layout.js';
import { isTerminalStatus, OperationStore, toOperationSnapshot } from './operation-store.js';
import type { PluginSourcePort } from './plugin-source.js';

export interface PluginDiscoveryServiceOptions {
  readonly layout: AppDataLayout;
  readonly source: PluginSourcePort;
  readonly now?: () => Date;
}

const PLUGIN_OPERATION_KINDS: ReadonlySet<string> = new Set(['search', 'inspect']);

export class PluginDiscoveryService {
  readonly #store: OperationStore;
  readonly #source: PluginSourcePort;
  readonly #now: () => Date;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: PluginDiscoveryServiceOptions) {
    this.#store = new OperationStore(options.layout);
    this.#source = options.source;
    this.#now = options.now ?? (() => new Date());
  }

  /** True when this service owns the operation id (it is a plugin operation). */
  owns(operationId: string): boolean {
    const record = this.#store.read(operationId);
    return record !== undefined && PLUGIN_OPERATION_KINDS.has(record.kind);
  }

  /**
   * Returns the plugin operation snapshot, or `undefined` when the id is not a
   * plugin operation (the composite port then falls through to the environment
   * service, so an unknown id still resolves to `NOT_FOUND` there).
   */
  findOperation(operationId: string): PortOutcome<OperationSnapshot> | undefined {
    if (!this.owns(operationId)) {
      return undefined;
    }
    const record = this.#store.read(operationId);
    return record === undefined
      ? portFail('NOT_FOUND', 'operation was not found')
      : portOk(toOperationSnapshot(record));
  }

  search(command: PluginSearchCommand): PortOutcome<OperationRef> {
    return this.#start('search', 'searching', (signal) =>
      this.#source.search(command.query, signal),
    );
  }

  inspect(command: PluginInspectCommand): PortOutcome<OperationRef> {
    return this.#start('inspect', 'inspecting', (signal) =>
      this.#source.inspect(command.source, signal),
    );
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
    kind: 'search' | 'inspect',
    phase: string,
    task: (signal: AbortSignal) => Promise<PortOutcome<unknown>>,
  ): PortOutcome<OperationRef> {
    const operationId = newOperationId();
    const controller = new AbortController();
    this.#store.create({
      id: operationId,
      kind,
      environmentId: null,
      phase,
      status: 'running',
      createdAt: this.#now().toISOString(),
    });
    this.#controllers.set(operationId, controller);
    void this.#run(operationId, task, controller.signal);
    return portOk({ operationId });
  }

  async #run(
    operationId: string,
    task: (signal: AbortSignal) => Promise<PortOutcome<unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    let outcome: PortOutcome<unknown>;
    try {
      outcome = await task(signal);
    } catch {
      outcome = portFail('INTERNAL_ERROR', 'the plugin source threw');
    }
    this.#controllers.delete(operationId);
    const record = this.#store.read(operationId);
    // Cancelled (or otherwise already terminal): a late result must never
    // revive a final operation.
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
