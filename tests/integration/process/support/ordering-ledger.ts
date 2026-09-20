/**
 * Append-only ordering ledger for close / lock / writer ordering QA.
 *
 * The M1 requirement is an *order*: on a normal `close`, every proven-owned
 * DSH/install/preflight subtree must have exited before the core releases the
 * `dataRoot` lock, and the next instance must not acquire the lock until the
 * previous writer is gone. Asserting that by sampling state can pass by luck;
 * the ledger records the real events (`writer-exit`, `lock-release`,
 * `next-acquire`) with timestamps and sequence, and {@link assertOrdered}
 * fails deterministically on the wrong order — a negative control the harness
 * exercises on purpose.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LedgerEvent {
  readonly actor: string;
  readonly event: string;
  readonly at: number;
  readonly pid?: number;
}

export class OrderViolationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OrderViolationError';
  }
}

export class OrderingLedger {
  public readonly path: string;

  public constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  public append(actor: string, event: string, pid?: number): LedgerEvent {
    const entry: LedgerEvent = {
      actor,
      event,
      at: Date.now(),
      ...(pid === undefined ? {} : { pid }),
    };
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  public read(): readonly LedgerEvent[] {
    if (!existsSync(this.path)) {
      return [];
    }
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LedgerEvent);
  }

  /** Index of the first event matching actor+event, or -1. */
  public indexOf(actor: string, event: string): number {
    return this.read().findIndex((entry) => entry.actor === actor && entry.event === event);
  }
}

export interface OrderExpectation {
  readonly actor: string;
  readonly event: string;
}

/**
 * Asserts `before` appears strictly earlier than `after` in the ledger. Missing
 * events are failures (the API did not emit the observable signal), not skips.
 */
export const assertOrdered = (
  ledger: OrderingLedger,
  before: OrderExpectation,
  after: OrderExpectation,
): void => {
  const beforeIndex = ledger.indexOf(before.actor, before.event);
  const afterIndex = ledger.indexOf(after.actor, after.event);
  if (beforeIndex < 0) {
    throw new OrderViolationError(`missing ledger event ${before.actor}/${before.event}`);
  }
  if (afterIndex < 0) {
    throw new OrderViolationError(`missing ledger event ${after.actor}/${after.event}`);
  }
  if (beforeIndex >= afterIndex) {
    throw new OrderViolationError(
      `${before.actor}/${before.event} (index ${beforeIndex}) must precede ` +
        `${after.actor}/${after.event} (index ${afterIndex})`,
    );
  }
};
