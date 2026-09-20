// Real second-process holder for the dataRoot lock tests (issue #43).
//
// Runs against the real `packages/core/src/data-root-lock.ts` via the
// `resolve-ts-hook.mjs` module hook, so this is the same implementation the
// service uses — not a re-implementation.
//
// Usage: node lock-holder.mjs <dataRoot> <acquire|try-once> [staleAfterMs]
// Prints `HELD <pid>` and keeps the lease beating, or `BUSY` and exits 3.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./resolve-ts-hook.mjs', import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const lockModule = pathToFileURL(
  join(here, '..', '..', '..', 'packages', 'core', 'src', 'data-root-lock.ts'),
).href;
const { DataRootLock } = await import(lockModule);

const dataRoot = process.argv[2];
const mode = process.argv[3] ?? 'acquire';
const staleAfterMs = Number(process.argv[4] ?? '150');
const waitTimeoutMs = Number(process.argv[5] ?? '5000');

if (dataRoot === undefined) {
  process.stderr.write('dataRoot is required\n');
  process.exit(2);
}

const lock = new DataRootLock({
  dataRoot,
  heartbeatIntervalMs: 40,
  staleAfterMs,
  guardWaitMs: 1_500,
});

const hold = () => {
  const keepAlive = setInterval(() => {}, 250);
  const shutdown = () => {
    clearInterval(keepAlive);
    void lock.release().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdout.write(`HELD ${String(process.pid)}\n`);
};

const acquired =
  mode === 'try-once'
    ? await lock.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })
    : await lock.acquire({ waitTimeoutMs, pollIntervalMs: 20 });

if (acquired) {
  hold();
} else {
  process.stdout.write('BUSY\n');
  process.exit(3);
}
