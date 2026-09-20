/**
 * Spawns the real second-process lock holder (`tests/core/support/lock-holder.mjs`,
 * reused read-only as session hdsl-21 sanctioned) and returns its first line.
 *
 * The holder runs the same production `data-root-lock.ts` through the module
 * hook, so cross-process QA is a real boundary, not a re-implementation.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOLDER = fileURLToPath(new URL('../../../core/support/lock-holder.mjs', import.meta.url));

export interface LockHolder {
  readonly child: ChildProcess;
  readonly firstLine: Promise<string>;
}

export const spawnLockHolder = (
  dataRoot: string,
  mode: 'acquire' | 'try-once',
  staleAfterMs = 150,
  waitTimeoutMs = 5_000,
): LockHolder => {
  const child = spawn(
    process.execPath,
    [HOLDER, dataRoot, mode, String(staleAfterMs), String(waitTimeoutMs)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let buffer = '';
  const firstLine = new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index >= 0) {
        resolve(buffer.slice(0, index));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!buffer.includes('\n')) {
        resolve(`EXIT ${String(code)}`);
      }
    });
  });
  return { child, firstLine };
};

export const waitForChildExit = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
  });
