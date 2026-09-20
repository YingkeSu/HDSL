/**
 * Descendant-tree cleanup for a recorded managed process group.
 *
 * When a managed DSH crashes, the process-group leader dies but descendants it
 * spawned keep running in the same group. The leader's pid can no longer be
 * verified by kernel start token, so cleanup uses the recorded process-group id
 * as the ownership link: the group was created by the launcher's detached
 * child, and `pgid === leader pid` still resolves to that group while members
 * remain.
 *
 * Conservative rules (T005 review P2-2):
 * - a scan that cannot run is never treated as "nothing left";
 * - a group id that may have been reused (the leader pid now belongs to a
 *   different process) is never signalled — only observed and reported;
 * - only the launcher's own recorded group is ever signalled, never an unknown
 *   pid or group.
 */
import type { ProcessInfo, ProcessProbe } from './probe.js';
import type { OwnershipReason } from './ownership.js';
import { delay, signalProcessGroup } from './tree.js';

export type LeftoverCleanupFailure = 'scan-failed' | 'unverifiable-leftovers' | 'cleanup-failed';

export type LeftoverCleanupResult =
  | { readonly ok: true; readonly killed: number }
  | { readonly ok: false; readonly reason: LeftoverCleanupFailure };

/** Live group members excluding the launcher's own process; undefined = scan failed. */
export const readGroupLeftovers = (
  probe: ProcessProbe,
  pgid: number,
): readonly ProcessInfo[] | undefined => {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return [];
  }
  const members = probe.listProcessGroup(pgid);
  if (members === undefined) {
    return undefined;
  }
  return members.filter((member) => member.pid !== process.pid);
};

/**
 * Signals the recorded group with SIGKILL and waits for it to empty. Only call
 * this when the leader is provably gone (a `dead` verdict): a reused pid means
 * the group id may have been reassigned, and is never signalled.
 */
export const cleanProcessGroupLeftovers = async (options: {
  readonly probe: ProcessProbe;
  readonly pgid: number;
  readonly confirmMs: number;
}): Promise<LeftoverCleanupResult> => {
  const { probe, pgid, confirmMs } = options;
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    return { ok: true, killed: 0 };
  }
  const first = readGroupLeftovers(probe, pgid);
  if (first === undefined) {
    return { ok: false, reason: 'scan-failed' };
  }
  if (first.length === 0) {
    return { ok: true, killed: 0 };
  }
  signalProcessGroup(pgid, 'SIGKILL');
  const deadline = Date.now() + Math.max(0, confirmMs);
  for (;;) {
    const current = readGroupLeftovers(probe, pgid);
    if (current === undefined) {
      return { ok: false, reason: 'scan-failed' };
    }
    if (current.length === 0) {
      return { ok: true, killed: first.length };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'cleanup-failed' };
    }
    await delay(50);
  }
};

/**
 * Resolves the descendant tree of a leader that is no longer owned.
 *
 * A `dead` leader means the recorded group was created by our detached child
 * and may still hold descendants: signal and await it. Any other verdict means
 * the pid may have been reassigned, so nothing is signalled — a surviving group
 * is reported as unverifiable so the caller can refuse to report success.
 */
export const cleanupLostLeaderTree = async (options: {
  readonly probe: ProcessProbe;
  readonly pgid: number;
  readonly leaderReason: OwnershipReason;
  readonly confirmMs: number;
}): Promise<LeftoverCleanupResult> => {
  if (options.leaderReason === 'dead') {
    return cleanProcessGroupLeftovers({
      probe: options.probe,
      pgid: options.pgid,
      confirmMs: options.confirmMs,
    });
  }
  const leftovers = readGroupLeftovers(options.probe, options.pgid);
  if (leftovers === undefined) {
    return { ok: false, reason: 'scan-failed' };
  }
  return leftovers.length === 0
    ? { ok: true, killed: 0 }
    : { ok: false, reason: 'unverifiable-leftovers' };
};
