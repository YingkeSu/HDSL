/**
 * Durable operation records.
 *
 * `sequence` is the operation's own monotonic counter (0 at creation, +1 on
 * every persisted transition) and is shared with `OperationSnapshot.sequence`
 * and `operation.updated`, so a reconnecting client can detect gaps. Terminal
 * states are final and never move backwards.
 */
import type {
  ContractError,
  OperationKind,
  OperationSnapshot,
  OperationStatus,
} from '@hdsl/contracts';
import { OPAQUE_ID_PATTERN } from '@hdsl/contracts';
import { tryReadJsonFile, readDirectoryNames, writeJsonAtomic } from './fsx.js';
import { operationRecordPath, type AppDataLayout } from './layout.js';

export interface OperationRecord {
  readonly schemaVersion: '1';
  readonly id: string;
  readonly environmentId: string | null;
  readonly kind: OperationKind;
  readonly phase: string;
  readonly status: OperationStatus;
  readonly sequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progress?: number;
  readonly error?: ContractError;
  /**
   * Terminal result payload (ADR 0005 D5). It is only ever set on a
   * `succeeded` plugin `search`/`inspect` operation; the contract dispatcher
   * enforces the per-kind presence rule on the way out.
   */
  readonly output?: unknown;
}

const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set<OperationStatus>([
  'succeeded',
  'failed',
  'cancelled',
]);

export const isTerminalStatus = (status: OperationStatus): boolean =>
  TERMINAL_STATUSES.has(status);

export const toOperationSnapshot = (record: OperationRecord): OperationSnapshot => ({
  id: record.id,
  environmentId: record.environmentId,
  kind: record.kind,
  phase: record.phase,
  status: record.status,
  sequence: record.sequence,
  ...(record.progress === undefined ? {} : { progress: record.progress }),
  ...(record.error === undefined ? {} : { error: record.error }),
  ...(record.output === undefined ? {} : { output: record.output }),
});

export interface OperationUpdate {
  readonly phase?: string;
  readonly status?: OperationStatus;
  readonly progress?: number;
  readonly error?: ContractError;
  readonly output?: unknown;
}

export interface OperationCreate {
  readonly id: string;
  readonly kind: OperationKind;
  readonly environmentId: string | null;
  readonly phase: string;
  readonly status?: OperationStatus;
  readonly createdAt: string;
  readonly progress?: number;
}

export class OperationStore {
  readonly #layout: AppDataLayout;

  constructor(layout: AppDataLayout) {
    this.#layout = layout;
  }

  read(operationId: string): OperationRecord | undefined {
    if (!OPAQUE_ID_PATTERN.test(operationId)) {
      return undefined;
    }
    return tryReadJsonFile<OperationRecord>(operationRecordPath(this.#layout, operationId));
  }

  list(): OperationRecord[] {
    const records: OperationRecord[] = [];
    for (const name of readDirectoryNames(this.#layout.operations)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const record = this.read(name.slice(0, -'.json'.length));
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  write(record: OperationRecord): void {
    writeJsonAtomic(operationRecordPath(this.#layout, record.id), record);
  }

  create(input: OperationCreate): OperationRecord {
    const record: OperationRecord = {
      schemaVersion: '1',
      id: input.id,
      environmentId: input.environmentId,
      kind: input.kind,
      phase: input.phase,
      status: input.status ?? 'queued',
      sequence: 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      ...(input.progress === undefined ? {} : { progress: input.progress }),
    };
    this.write(record);
    return record;
  }

  /**
   * Persists a transition, incrementing `sequence` by exactly one. Updating a
   * terminal operation is refused so a late callback cannot revive it.
   */
  update(record: OperationRecord, update: OperationUpdate, now: string): OperationRecord {
    if (isTerminalStatus(record.status)) {
      throw new Error(`operation ${record.id} already reached a terminal state`);
    }
    return this.#writeTransition(record, update, now);
  }

  /**
   * Authoritative reconciliation override for an operation whose recorded
   * terminal status is contradicted by durable commit evidence (for example a
   * `cancelled` operation whose generation pointer is already committed, left on
   * disk by an older build). It replaces the terminal record with the committed
   * fact and increments `sequence`.
   *
   * This is deliberately separate from {@link update}: normal callers can never
   * revive a terminal operation, and only recovery code that holds commit
   * evidence (journal phase / active-generation pointer) may call it. It never
   * moves a `succeeded` or `failed` record backwards; the caller only ever
   * resolves `cancelled` -> `succeeded`.
   */
  overrideTerminal(record: OperationRecord, update: OperationUpdate, now: string): OperationRecord {
    return this.#writeTransition(record, update, now);
  }

  #writeTransition(record: OperationRecord, update: OperationUpdate, now: string): OperationRecord {
    const progress = update.progress ?? record.progress;
    const error = update.error ?? record.error;
    const output = update.output ?? record.output;
    const next: OperationRecord = {
      schemaVersion: '1',
      id: record.id,
      environmentId: record.environmentId,
      kind: record.kind,
      phase: update.phase ?? record.phase,
      status: update.status ?? record.status,
      sequence: record.sequence + 1,
      createdAt: record.createdAt,
      updatedAt: now,
      ...(progress === undefined ? {} : { progress }),
      ...(error === undefined ? {} : { error }),
      ...(output === undefined ? {} : { output }),
    };
    this.write(next);
    return next;
  }
}
