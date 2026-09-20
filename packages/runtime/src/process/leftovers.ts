/**
 * Descendant-tree cleanup for a recorded managed process group.
 *
 * When a managed DSH crashes, the group leader dies but descendants it spawned
 * keep running in the same group. Cleanup therefore never signals blindly by
 * group id: every candidate must carry **current ownership evidence** that ties
 * it to the recorded launch.
 *
 * Ownership proof for cleanup (review P2-B) is a combination, never one field:
 * - the process is enumerated as a member of the recorded process group (the
 *   group the launcher's detached child created), and
 * - its command line still references the launch's unique command fragment or
 *   its generation directory.
 *
 * A member that cannot be proven is never signalled. Proven members are killed
 * individually (so an unknown member in the same group is never collateral),
 * and any remaining unproven member makes the whole cleanup fail closed: the
 * record is retained and `close()` refuses to report success.
 */
import type { ProcessInfo, ProcessProbe } from './probe.js';
import type { OwnershipReason } from './ownership.js';
import { delay, signalProcess } from './tree.js';

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
  return members.filter((member) => member.pid !== process.pid && member.pid !== pgid);
};

const isProvableMember = (
  member: ProcessInfo,
  commandFragment: string,
  generationDirectory: string,
  exitedAt: string | null,
): boolean => {
  if (commandFragment.length > 0 && member.command.includes(commandFragment)) {
    return true;
  }
  if (generationDirectory.length > 0 && member.command.includes(generationDirectory)) {
    return true;
  }
  // OS process-group evidence: the member already existed at the recorded
  // leader exit. While the leader was alive the group id was ours, so the group
  // could not have been freed and reused; a member present then is ours.
  // `ps -o lstart=` has one-second granularity, hence the small tolerance.
  if (exitedAt === null) {
    return false;
  }
  const exitAt = Date.parse(exitedAt);
  const startedAt = Date.parse(member.startToken);
  return Number.isFinite(exitAt) && Number.isFinite(startedAt) && startedAt <= exitAt + 1_000;
};

/**
 * Resolves the survivor tree of a launch whose leader is gone.
 *
 * `leaderReason` is accepted for callers/documentation, but cleanup never keys
 * off the dead leader's pid: a reused pid is exactly the case where a blind
 * `kill(-pgid)` could hit an unrelated group. Instead every live member of the
 * recorded group is proven from the launch's own evidence before any signal.
 */
export const cleanupLostLeaderTree = async (options: {
  readonly probe: ProcessProbe;
  readonly pgid: number;
  readonly leaderReason: OwnershipReason;
  readonly commandFragment: string;
  readonly generationDirectory: string;
  /** ISO time the launcher observed the leader exit, or null. */
  readonly exitedAt: string | null;
  readonly confirmMs: number;
}): Promise<LeftoverCleanupResult> => {
  const { probe, pgid, commandFragment, generationDirectory, exitedAt, confirmMs } = options;
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    return { ok: true, killed: 0 };
  }
  let killed = 0;
  const deadline = Date.now() + Math.max(0, confirmMs);
  for (;;) {
    const members = readGroupLeftovers(probe, pgid);
    if (members === undefined) {
      return { ok: false, reason: 'scan-failed' };
    }
    if (members.length === 0) {
      return { ok: true, killed };
    }
    const proven = members.filter((member) =>
      isProvableMember(member, commandFragment, generationDirectory, exitedAt),
    );
    const unproven = members.length - proven.length;
    if (proven.length === 0) {
      // Only members we cannot prove: never signal them.
      return { ok: false, reason: 'unverifiable-leftovers' };
    }
    for (const member of proven) {
      signalProcess(member.pid, 'SIGKILL');
      killed += 1;
    }
    if (unproven > 0) {
      // Proven members were signalled; unprovable survivors remain, so cleanup
      // is not complete and must not be reported as success.
      if (Date.now() >= deadline) {
        return { ok: false, reason: 'unverifiable-leftovers' };
      }
      await delay(50);
      return { ok: false, reason: 'unverifiable-leftovers' };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'cleanup-failed' };
    }
    await delay(50);
  }
};
