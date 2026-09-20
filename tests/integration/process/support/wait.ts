/**
 * Minimal bounded-wait helper for the lock QA slice.
 *
 * Locks are observed by event/gate, never by a fixed sleep: the wait ends the
 * instant the condition is true and times out with an explicit error otherwise.
 */
export class GateTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GateTimeoutError';
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
  throw new GateTimeoutError(`gate did not open within ${timeoutMs}ms: ${options.label ?? 'unnamed gate'}`);
};
