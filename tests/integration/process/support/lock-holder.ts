/**
 * Spawns the real second-process lock holder (`tests/core/support/lock-holder.mjs`,
 * reused read-only as session hdsl-21 sanctioned) and tracks every child this
 * QA slice starts so an abnormal path cannot leak a real subprocess.
 *
 * `reapLockHolders` terminates only children registered here, with a bounded
 * SIGTERM then SIGKILL escalation, and awaits real exit. It never touches any
 * other process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sleep } from './wait.js';

const HOLDER = fileURLToPath(new URL('../../../core/support/lock-holder.mjs', import.meta.url));

const holders = new Set<ChildProcess>();

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
  holders.add(child);
  child.once('exit', () => holders.delete(child));
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
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
  });

/** PIDs of registered holders that have not exited yet. */
export const liveLockHolders = (): readonly number[] =>
  [...holders]
    .filter((child) => child.exitCode === null && child.signalCode === null)
    .map((child) => child.pid ?? -1);

export interface ReapReport {
  readonly terminated: number;
  readonly escalated: number;
  readonly timedOut: number;
}

const exitWithin = async (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return Promise.race([
    waitForChildExit(child).then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
};

/**
 * Terminates every registered holder: SIGTERM, bounded wait, SIGKILL, bounded
 * wait. Returns counts so a caller can fail loudly if a process did not exit
 * instead of silently reporting zero residue.
 */
export const reapLockHolders = async (timeoutMs = 3_000): Promise<ReapReport> => {
  let terminated = 0;
  let escalated = 0;
  let timedOut = 0;
  for (const child of [...holders]) {
    if (child.exitCode !== null || child.signalCode !== null) {
      holders.delete(child);
      continue;
    }
    child.kill('SIGTERM');
    if (await exitWithin(child, timeoutMs)) {
      terminated += 1;
    } else {
      child.kill('SIGKILL');
      if (await exitWithin(child, timeoutMs)) {
        escalated += 1;
      } else {
        timedOut += 1;
      }
    }
    holders.delete(child);
  }
  return { terminated, escalated, timedOut };
};
