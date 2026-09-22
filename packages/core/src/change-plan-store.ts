/**
 * Durable ChangePlan store (ADR 0005 D6/D8/D9).
 *
 * Plans are written by `changes.preview` and read by `changes.apply`. Guards
 * (TTL expiry, input staleness, single consumption) are enforced by the caller;
 * this store only persists and marks consumption. A plan is never silently
 * recomputed or refreshed on replay (ADR 0005 D9).
 */
import { join } from 'node:path';
import { OPAQUE_ID_PATTERN, type ChangePlan } from '@hdsl/contracts';
import { assertWithin, readDirectoryNames, tryReadJsonFile, writeJsonAtomic } from './fsx.js';
import type { AppDataLayout } from './layout.js';

export interface ChangePlanRecord {
  readonly schemaVersion: '1';
  readonly plan: ChangePlan;
  /** `requestId` that consumed the plan (apply), or `null` while unused. */
  readonly consumedBy: string | null;
}

export class ChangePlanStore {
  readonly #layout: AppDataLayout;

  constructor(layout: AppDataLayout) {
    this.#layout = layout;
  }

  #path(planId: string): string | undefined {
    if (!OPAQUE_ID_PATTERN.test(planId)) {
      return undefined;
    }
    return assertWithin(this.#layout.plans, join(this.#layout.plans, `${planId}.json`), 'planId');
  }

  read(planId: string): ChangePlanRecord | undefined {
    const path = this.#path(planId);
    if (path === undefined) {
      return undefined;
    }
    return tryReadJsonFile<ChangePlanRecord>(path);
  }

  write(record: ChangePlanRecord): void {
    const path = this.#path(record.plan.planId);
    if (path === undefined) {
      throw new Error('planId must be an opaque id');
    }
    writeJsonAtomic(path, record);
  }

  /** Marks a plan consumed by a request; idempotent for the same request. */
  consume(planId: string, requestId: string): ChangePlanRecord | undefined {
    const record = this.read(planId);
    if (record === undefined) {
      return undefined;
    }
    if (record.consumedBy === requestId) {
      return record;
    }
    const updated: ChangePlanRecord = { ...record, consumedBy: requestId };
    this.write(updated);
    return updated;
  }

  /** Consumes only when the plan is unused (or the same request); safe on recovery. */
  consumeIfUnused(planId: string, requestId: string): ChangePlanRecord | undefined {
    const record = this.read(planId);
    if (record === undefined) {
      return undefined;
    }
    if (record.consumedBy !== null) {
      return record;
    }
    return this.consume(planId, requestId);
  }

  list(): ChangePlanRecord[] {
    const records: ChangePlanRecord[] = [];
    for (const name of readDirectoryNames(this.#layout.plans)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const record = this.read(name.slice(0, -'.json'.length));
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records.sort((left, right) => left.plan.createdAt.localeCompare(right.plan.createdAt));
  }
}
