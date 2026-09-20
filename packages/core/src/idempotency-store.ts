/**
 * Durable idempotency ledger.
 *
 * `contracts/local-api.md` freezes the two ledger states: `in-progress` (written
 * after every guard passed and before the effect started) and `completed`. The
 * dispatcher reads/writes it synchronously, so this store is synchronous.
 *
 * The file name is the SHA-256 of the `requestId` instead of the id itself:
 * request ids may contain `:` and `.`, which are hostile to some filesystems.
 * The id is stored inside the record so recovery can map it back.
 */
import { createHash } from 'node:crypto';
import type { IdempotencyRecord } from '@hdsl/contracts';
import { REQUEST_ID_PATTERN } from '@hdsl/contracts';
import { readJsonFile, readDirectoryNames, writeJsonAtomic } from './fsx.js';
import type { AppDataLayout } from './layout.js';
import { join } from 'node:path';

interface IdempotencyFile {
  readonly requestId: string;
  readonly record: IdempotencyRecord;
}

const fileNameFor = (requestId: string): string =>
  `${createHash('sha256').update(requestId, 'utf8').digest('hex')}.json`;

export class IdempotencyStore {
  readonly #layout: AppDataLayout;

  constructor(layout: AppDataLayout) {
    this.#layout = layout;
  }

  read(requestId: string): IdempotencyRecord | undefined {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      return undefined;
    }
    const file = readJsonFile<IdempotencyFile>(join(this.#layout.idempotency, fileNameFor(requestId)));
    return file?.record;
  }

  write(requestId: string, record: IdempotencyRecord): void {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error('requestId must be a bounded opaque token');
    }
    writeJsonAtomic(join(this.#layout.idempotency, fileNameFor(requestId)), { requestId, record });
  }

  list(): Array<{ readonly requestId: string; readonly record: IdempotencyRecord }> {
    const entries: Array<{ requestId: string; record: IdempotencyRecord }> = [];
    for (const name of readDirectoryNames(this.#layout.idempotency)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const file = readJsonFile<IdempotencyFile>(join(this.#layout.idempotency, name));
      if (file !== undefined) {
        entries.push({ requestId: file.requestId, record: file.record });
      }
    }
    return entries;
  }
}
