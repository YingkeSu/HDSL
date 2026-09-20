/**
 * Ownership verification for managed processes.
 *
 * A bare pid is never evidence: pids are reused. A recorded process is only
 * "owned" when the pid is still alive **and** the kernel start token matches
 * **and** the recorded command fragment is still part of the command line. When
 * that proof is unavailable the process is never signalled (`unverifiable`).
 */
import { isProcessAlive } from './tree.js';
import type { ProcessProbe } from './probe.js';
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
