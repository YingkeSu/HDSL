/**
 * Durable creation/install journal.
 *
 * One journal file per environment-creation transaction records the lock, the
 * ids and the last completed phase. A crash can therefore be classified on the
 * next start:
 *
 * - `phase !== 'committed'` and the environment does not point at the
 *   generation → the transaction was interrupted: fail the operation, keep the
 *   environment visible as `error` and delete the uncommitted staging.
 * - `phase === 'committed'` or the environment already points at the generation
 *   → finish the commit (idempotent).
 *
 * The journal is the T004 half of restart reconciliation; `reconcile/**` (T005)
 * reuses the same records for the process half.
 */
import type { CompositionLock, ErrorCode } from '@hdsl/contracts';
import { OPAQUE_ID_PATTERN } from '@hdsl/contracts';
import { tryReadJsonFile, readDirectoryNames, removePath, writeJsonAtomic } from './fsx.js';
import { transactionRecordPath, type AppDataLayout } from './layout.js';

export type JournalPhase = 'prepared' | 'artifacts-installed' | 'committed' | 'failed';

export interface CreateJournalRecord {
  readonly schemaVersion: '1';
  readonly transactionId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly environmentId: string;
  readonly generationId: string;
  readonly compositionDigest: string;
  readonly lock: CompositionLock;
  readonly phase: JournalPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode?: ErrorCode;
}

export class JournalStore {
  readonly #layout: AppDataLayout;

  constructor(layout: AppDataLayout) {
    this.#layout = layout;
  }

  read(transactionId: string): CreateJournalRecord | undefined {
    if (!OPAQUE_ID_PATTERN.test(transactionId)) {
      return undefined;
    }
    return tryReadJsonFile<CreateJournalRecord>(transactionRecordPath(this.#layout, transactionId));
  }

  list(): CreateJournalRecord[] {
    const records: CreateJournalRecord[] = [];
    for (const name of readDirectoryNames(this.#layout.transactions)) {
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

  write(record: CreateJournalRecord): void {
    writeJsonAtomic(transactionRecordPath(this.#layout, record.transactionId), record);
  }

  remove(transactionId: string): void {
    removePath(transactionRecordPath(this.#layout, transactionId));
  }
}
