/**
 * Ownership verification for managed processes.
 *
 * A bare pid is never evidence: pids are reused. A recorded process is only
 * "owned" when the pid is still alive **and** the kernel start token matches
 * **and** the recorded command fragment is still part of the command line. When
 * that proof is unavailable the process is never signalled (`unverifiable`).
 */
import { isProcessAlive } from './tree.js';
import type { ProcessInfo, ProcessProbe } from './probe.js';
import type { ProcessIdentity } from './records.js';

export type OwnershipReason =
  | 'live-owned'
  | 'dead'
  | 'pid-reused'
  | 'command-mismatch'
  | 'unverifiable';

export interface OwnershipVerdict {
  readonly owned: boolean;
  readonly alive: boolean;
  readonly reason: OwnershipReason;
  /** True when the process group id still matches, so a group signal is safe. */
  readonly pgidMatches: boolean;
}

export const verifyIdentity = (
  probe: ProcessProbe,
  identity: ProcessIdentity,
): OwnershipVerdict => {
  if (!isProcessAlive(identity.pid)) {
    return { owned: false, alive: false, reason: 'dead', pgidMatches: false };
  }
  const info = probe.inspect(identity.pid);
  if (info === undefined) {
    // The pid exists but the probe could not read it (ps unavailable/permission).
    return { owned: false, alive: true, reason: 'unverifiable', pgidMatches: false };
  }
  if (info.startToken !== identity.startToken) {
    return { owned: false, alive: true, reason: 'pid-reused', pgidMatches: false };
  }
  if (!info.command.includes(identity.commandFragment)) {
    return { owned: false, alive: true, reason: 'command-mismatch', pgidMatches: false };
  }
  return {
    owned: true,
    alive: true,
    reason: 'live-owned',
    pgidMatches: info.pgid === identity.pgid,
  };
};

/**
 * True when the recorded process is provably gone: either the pid no longer
 * exists, or the pid exists with a different kernel start token (it was reused
 * by an unrelated process). In both cases nothing of ours remains to stop, and
 * a matching record may safely be replaced.
 */
export const identityIsGone = (verdict: OwnershipVerdict): boolean =>
  !verdict.alive || verdict.reason === 'pid-reused';

/**
 * Finds live processes that match a launch record whose identity was never
 * captured (a crash between spawn and record write).
 *
 * Matching only the command fragment is not enough: a fixture — or any future
 * shared entrypoint — can reuse it, and two concurrent environments must never
 * signal each other. The candidate must also carry the record's unique
 * generation directory in its command line.
 */
export type OwnedProcessScan =
  | { readonly ok: true; readonly processes: readonly ProcessInfo[] }
  | { readonly ok: false; readonly reason: 'scan-failed' | 'unverifiable-candidate' };

/**
 * Finds live processes that match a launch record whose identity was never
 * captured (a crash between spawn and record write).
 *
 * Matching only the command fragment is not enough: a fixture — or any future
 * shared entrypoint — can reuse it, and two concurrent environments must never
 * signal each other. The candidate must also carry the record's unique
 * generation directory in its command line.
 *
 * The result is tri-state on purpose: `ok: false` means the scan or a candidate
 * could not be read, which must be treated as "unprovable", never as "no
 * process".
 */
export const findOwnedProcessesDetailed = (
  probe: ProcessProbe,
  commandFragment: string,
  generationDirectory: string,
): OwnedProcessScan => {
  const ids = probe.tryFindIdsByCommandFragment(commandFragment);
  if (ids === undefined) {
    return { ok: false, reason: 'scan-failed' };
  }
  const processes: ProcessInfo[] = [];
  for (const pid of ids) {
    if (pid === process.pid) {
      continue;
    }
    const info = probe.inspect(pid);
    if (info === undefined) {
      return { ok: false, reason: 'unverifiable-candidate' };
    }
    if (info.command.includes(generationDirectory)) {
      processes.push(info);
    }
  }
  return { ok: true, processes };
};

/**
 * Legacy convenience wrapper used by tests: returns the matched processes and
 * collapses an unavailable scan to `[]`. Production cleanup paths must use
 * {@link findOwnedProcessesDetailed} so a failed scan is never mistaken for an
 * empty one.
 */
export const findOwnedProcesses = (
  probe: ProcessProbe,
  commandFragment: string,
  generationDirectory: string,
): readonly ProcessInfo[] => {
  const scan = findOwnedProcessesDetailed(probe, commandFragment, generationDirectory);
  return scan.ok ? scan.processes : [];
};
