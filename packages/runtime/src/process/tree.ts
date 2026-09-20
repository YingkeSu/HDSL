/**
 * POSIX process-tree primitives shared by the managed installer (`npm ci`,
 * preflight) and the managed DSH lifecycle.
 *
 * Ownership rule (T005): a process is signalled only through a process group
 * that the caller proved belongs to a child this launcher spawned, or through
 * an exact pid after an identity check (pid + kernel start token + command).
 * Nothing here ever guesses; a stale pid alone is never signalled.
 *
 * The launcher spawns its managed children with `detached: true`, so each child
 * is the leader of its own process group and `kill(-pid, ...)` reaches the
 * whole tree without touching the launcher's own group.
 */
import { execFileSync } from 'node:child_process';

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** True while `pid` exists (a zombie still counts until reaped). */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const signalProcess = (pid: number, signal: NodeJS.Signals): boolean => {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * Signals a whole process group. Refuses pid 0/1 and the launcher's own group
 * so a bogus record can never kill the process running the launcher.
 */
export const signalProcessGroup = (pgid: number, signal: NodeJS.Signals): boolean => {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    return false;
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
};

/** Direct child pids of `pid`, via `ps` (portable across macOS and Linux). */
export const listChildPids = (pid: number): readonly number[] => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return [];
  }
  let output: string;
  try {
    output = execFileSync('ps', ['-ax', '-o', 'ppid=,pid='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const children: number[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match !== null && Number(match[1]) === pid) {
      children.push(Number(match[2]));
    }
  }
  return children;
};

/** All descendants of `rootPid`, deepest last. */
export const collectDescendants = (rootPid: number): readonly number[] => {
  const ordered: number[] = [];
  const queue: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of listChildPids(current)) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      ordered.push(child);
      queue.push(child);
    }
  }
  return ordered;
};

export interface TreeIdentity {
  readonly pid: number;
  readonly pgid?: number;
}

/**
 * Signals a recorded process and every descendant. When the recorded identity
 * is a group leader (`pgid === pid`) the whole group is signalled in one call;
 * otherwise descendants are signalled deepest-first and the root last.
 *
 * Returns the number of signals delivered (best effort).
 */
export const signalProcessTree = (
  identity: TreeIdentity,
  signal: NodeJS.Signals,
  options: { readonly group?: boolean } = {},
): number => {
  const useGroup =
    options.group !== false && identity.pgid !== undefined && identity.pgid === identity.pid;
  if (useGroup && identity.pgid !== undefined) {
    if (signalProcessGroup(identity.pgid, signal)) {
      return 1;
    }
  }
  let count = 0;
  const descendants = collectDescendants(identity.pid);
  for (const child of [...descendants].reverse()) {
    if (signalProcess(child, signal)) {
      count += 1;
    }
  }
  if (signalProcess(identity.pid, signal)) {
    count += 1;
  }
  return count;
};

/** Resolves true when `pid` is gone before the deadline. */
export const waitForProcessExit = async (
  pid: number,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(intervalMs);
  }
};

/**
 * Best-effort guarantee that no descendant survives: after the group/root is
 * signalled, any remaining descendant is signalled directly. Used after a
 * timeout or cancellation, where "the child was killed" is not enough.
 */
export const killProcessTreeSync = (
  identity: TreeIdentity,
  options: { readonly group?: boolean } = {},
): void => {
  signalProcessTree(identity, 'SIGKILL', options);
  for (const descendant of collectDescendants(identity.pid)) {
    signalProcess(descendant, 'SIGKILL');
  }
  signalProcess(identity.pid, 'SIGKILL');
};
