/**
 * Deterministic gates for the desktop E2E slice.
 *
 * Desktop scenarios involve asynchronous, concurrent actors (main process,
 * renderer window, managed DSH child, a second app instance). They are ordered
 * with explicit gates and an ordering ledger instead of `sleep`/retry luck:
 * `waitFor` ends the instant the predicate is true and fails closed with
 * `GateTimeoutError` otherwise. `harness.test.ts` proves both directions —
 * resolution after an opened gate and a bounded failure for a gate that never
 * opens — so a "gate passed" result cannot be a hang or a vacuous success
 * (lessons L17, L19).
 */
import { existsSync, writeFileSync } from 'node:fs';

export class GateTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GateTimeoutError';
  }
}

export class OrderViolationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OrderViolationError';
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly label?: string } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new GateTimeoutError(
    `gate did not open within ${timeoutMs}ms: ${options.label ?? 'unnamed gate'}`,
  );
};

export interface FileGate {
  readonly path: string;
  open(): void;
  isOpen(): boolean;
}

export const createFileGate = (path: string): FileGate => ({
  path,
  open: () => {
    writeFileSync(path, `${Date.now()}\n`);
  },
  isOpen: () => existsSync(path),
});

/**
 * Append-only event ledger. Scenarios record `actor:event` marks and assert a
 * strict prefix order, which is how "unsubscribe happened before the queue was
 * drained" or "instance B was refused before it wrote anything" is proven.
 */
export class OrderingLedger {
  readonly #marks: { readonly index: number; readonly event: string }[] = [];

  public mark(actor: string, event: string): number {
    const index = this.#marks.length;
    this.#marks.push({ index, event: `${actor}:${event}` });
    return index;
  }

  public events(): readonly string[] {
    return this.#marks.map((mark) => mark.event);
  }

  public assertOrdered(first: string, second: string): void {
    const firstIndex = this.#marks.findIndex((mark) => mark.event === first);
    const secondIndex = this.#marks.findIndex((mark) => mark.event === second);
    if (firstIndex === -1 || secondIndex === -1) {
      throw new OrderViolationError(
        `missing ledger event for ordering check (${first}=${firstIndex}, ${second}=${secondIndex})`,
      );
    }
    if (firstIndex >= secondIndex) {
      throw new OrderViolationError(
        `expected ${first} before ${second}; observed ${this.events().join(' -> ')}`,
      );
    }
  }
}
