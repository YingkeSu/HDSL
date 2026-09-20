/**
 * Descendant-tree cleanup for a recorded managed process group.
 *
 * When a managed DSH crashes, the group leader dies but descendants it spawned
 * keep running in the same group. Cleanup never signals blindly by group id:
 * every candidate must carry **current ownership evidence**, and the evidence
 * rule is deliberately conservative (review P2-B).
 *
 * Sufficient evidence to signal a member `M`:
 * 1. the recorded leader identity is a detached group leader
 *    (`identity.pgid === identity.pid`), and `M` is enumerated in that group;
 *    AND
 * 2. at least one ownership link holds:
 *    - **captured member identity**: `M.pid` + `M.startToken` exactly match an
 *      entry the launcher recorded at the leader's exit, or
 *    - **command evidence**: `M.command` still contains the launch's unique
 *      command fragment or generation directory.
 *
 * A member's start time is **never** sufficient on its own (even bounded by the
 * leader's exit): an unrelated daemon with an old start token must not be
 * killed. Ambiguity fails closed — no signal, record retained, `close` fails.
 */
import type { ProcessInfo, ProcessProbe } from './probe.js';
import type { OwnershipReason } from './ownership.js';
import type { ProcessIdentity } from './records.js';
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

/** Kernel identities of the group members observed at a leader exit. */
export const captureGroupSurvivors = (
  probe: ProcessProbe,
  pgid: number,
  commandFragment: string,
): readonly ProcessIdentity[] | null => {
  const members = readGroupLeftovers(probe, pgid);
  if (members === undefined) {
    return null;
  }
  return members.map((member) => ({
    pid: member.pid,
    pgid: member.pgid,
    startToken: member.startToken,
    commandFragment,
    createdAt: new Date().toISOString(),
  }));
};

const isProvableMember = (
  member: ProcessInfo,
  commandFragment: string,
  generationDirectory: string,
  capturedSurvivors: readonly ProcessIdentity[] | null,
): boolean => {
  if (commandFragment.length > 0 && member.command.includes(commandFragment)) {
    return true;
  }
  if (generationDirectory.length > 0 && member.command.includes(generationDirectory)) {
    return true;
  }
  if (capturedSurvivors === null) {
    return false;
  }
  return capturedSurvivors.some(
    (captured) => captured.pid === member.pid && captured.startToken === member.startToken,
  );
};

/**
 * Resolves the survivor tree of a launch whose leader is gone.
 *
 * `leaderReason` is informational; cleanup keys off the recorded leader
 * identity, so a reused pid never broadens the signal set. When the leader
 * identity is not a detached group leader the result is unverifiable.
 */
export const cleanupLostLeaderTree = async (options: {
  readonly probe: ProcessProbe;
  readonly pgid: number;
  readonly leaderReason: OwnershipReason;
  /**
   * Captured leader identity. When absent the result is unverifiable: without a
   * detached-leader identity there is no proof the group is ours.
   */
  readonly leaderIdentity?: ProcessIdentity;
  readonly commandFragment: string;
  readonly generationDirectory: string;
  /** Members captured at the leader's exit, or null when capture failed. */
  readonly capturedSurvivors?: readonly ProcessIdentity[] | null;
  /** @deprecated Ignored: a member's start time is never sufficient evidence. */
  readonly exitedAt?: string | null;
  readonly confirmMs: number;
}): Promise<LeftoverCleanupResult> => {
  const {
    probe,
    pgid,
    leaderIdentity,
    commandFragment,
    generationDirectory,
    capturedSurvivors = null,
    confirmMs,
  } = options;
  // Only a detached leader group (pgid === pid) is ours to enumerate; without
  // the captured leader identity (or when it is not a detached leader) the
  // result fails closed instead of signalling a possibly unrelated group.
  if (
    !Number.isInteger(pgid) ||
    pgid <= 1 ||
    pgid === process.pid ||
    leaderIdentity === undefined ||
    leaderIdentity.pgid !== leaderIdentity.pid ||
    leaderIdentity.pid !== pgid
  ) {
    return { ok: false, reason: 'unverifiable-leftovers' };
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
      isProvableMember(member, commandFragment, generationDirectory, capturedSurvivors),
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
      return { ok: false, reason: 'unverifiable-leftovers' };
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: 'cleanup-failed' };
    }
    await delay(50);
  }
};
