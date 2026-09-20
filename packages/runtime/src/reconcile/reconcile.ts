/**
 * Restart reconciliation for managed processes (T005).
 *
 * Called once per app start, after the caller acquired the data-root exclusive
 * lock and confirmed no other live instance owns it. It never rolls back another
 * instance's work: if `isPermitted` says the lock is not ours, it returns an
 * empty report and touches nothing.
 *
 * Two classes of leftovers are covered with the *same* ownership check
 * (pid + kernel start token + command fragment):
 *
 * - a managed DSH launch left by a crashed instance: a still-live owned process
 *   with a verified endpoint is `adopted`, anything else (owned but not ready,
 *   or dead) is `stopped`/`no-process`;
 * - managed installer children (`npm ci`, preflight) journalled under each
 *   generation: still-live owned children are killed so no install subtree
 *   survives a crash.
 *
 * A process whose ownership cannot be proven is never signalled: it is reported
 * as `unverifiable` and left running.
 */
import {
  listInstallChildJournals,
  type LaunchRecordStore,
  type ProcessLaunchRecord,
} from '../process/records.js';
import { identityIsGone, verifyIdentity } from '../process/ownership.js';
import type { ProcessProbe } from '../process/probe.js';
import { probeLoopbackTcp } from '../process/readiness.js';
import { killProcessTreeSync, signalProcessTree, waitForProcessExit } from '../process/tree.js';
import type { ProcessRecoveryEntry, ProcessRecoveryReport } from '../process/types.js';

export interface ReconcileOptions {
  readonly dataRoot: string;
  readonly launches: LaunchRecordStore;
  readonly probe: ProcessProbe;
  readonly stopGraceMs: number;
  readonly confirmMs: number;
  /** Returns false when the data-root lock belongs to another live instance. */
  readonly isPermitted?: () => boolean;
}

const transition = (
  record: ProcessLaunchRecord,
  state: ProcessLaunchRecord['state'],
): ProcessLaunchRecord => ({
  ...record,
  state,
  updatedAt: new Date().toISOString(),
  sequence: record.sequence + 1,
});

const stopOwnedTree = async (
  options: ReconcileOptions,
  pid: number,
  pgid: number,
): Promise<boolean> => {
  signalProcessTree({ pid, pgid }, 'SIGTERM', { group: true });
  if (await waitForProcessExit(pid, options.stopGraceMs)) {
    return true;
  }
  killProcessTreeSync({ pid, pgid }, { group: true });
  return waitForProcessExit(pid, options.confirmMs);
};

const reconcileLaunch = async (
  options: ReconcileOptions,
  record: ProcessLaunchRecord,
): Promise<ProcessRecoveryEntry> => {
  const { environmentId } = record;
  const identity = record.identity;

  if (identity === null) {
    // The instance crashed between writing the intent and recording an
    // identity. The unique DSH entrypoint path still identifies our process.
    const candidates = options.probe
      .findIdsByCommandFragment(record.commandFragment)
      .filter((pid) => pid !== process.pid);
    if (candidates.length === 0) {
      options.launches.write(transition(record, 'stopped'));
      return { environmentId, resolution: 'no-process' };
    }
    let stopped = true;
    for (const pid of candidates) {
      const info = options.probe.inspect(pid);
      if (info === undefined) {
        stopped = false;
        continue;
      }
      stopped = (await stopOwnedTree(options, info.pid, info.pgid)) && stopped;
    }
    options.launches.write(transition(record, stopped ? 'stopped' : 'unverifiable'));
    return stopped
      ? {
          environmentId,
          resolution: 'stopped',
          detail: 'interrupted before the process identity was recorded',
        }
      : {
          environmentId,
          resolution: 'unverifiable',
          detail: 'an installation process could not be confirmed exited',
        };
  }

  const verdict = verifyIdentity(options.probe, identity);
  if (identityIsGone(verdict)) {
    options.launches.write(transition(record, 'stopped'));
    return { environmentId, resolution: 'no-process' };
  }
  if (!verdict.owned) {
    options.launches.write(transition(record, 'unverifiable'));
    return {
      environmentId,
      resolution: 'unverifiable',
      detail: 'the recorded process identity no longer matches; it was not signalled',
    };
  }

  if (record.state === 'running' && record.endpoint !== null) {
    const reachable = await probeLoopbackTcp(
      record.endpoint.host,
      record.endpoint.port,
      Math.max(500, Math.min(options.confirmMs, 3000)),
    );
    if (reachable) {
      return { environmentId, resolution: 'adopted', loopbackOrigin: record.endpoint.origin };
    }
  }

  const previousState = record.state;
  options.launches.write(transition(record, 'stopping'));
  const exited = await stopOwnedTree(options, identity.pid, identity.pgid);
  options.launches.write(transition(record, exited ? 'stopped' : 'unverifiable'));
  return exited
    ? {
        environmentId,
        resolution: 'stopped',
        detail: `a ${previousState} managed process was stopped during reconciliation`,
      }
    : {
        environmentId,
        resolution: 'unverifiable',
        detail: 'an owned managed process could not be confirmed exited',
      };
};

const reconcileInstallChildren = async (options: ReconcileOptions): Promise<void> => {
  for (const { journal } of listInstallChildJournals(options.dataRoot)) {
    for (const child of journal.list()) {
      const verdict = verifyIdentity(options.probe, {
        pid: child.pid,
        pgid: child.pgid,
        startToken: child.startToken,
        commandFragment: child.commandFragment,
        createdAt: child.createdAt,
      });
      if (identityIsGone(verdict)) {
        // Dead or a reused pid: the recorded child is gone. Remove the record.
        journal.remove(child.token);
        continue;
      }
      if (!verdict.owned) {
        // Still alive but ownership is unproven: never signal it. The record is
        // kept so a later `close()` reports that it could not confirm exit.
        continue;
      }
      const exited = await stopOwnedTree(options, child.pid, child.pgid);
      if (exited) {
        journal.remove(child.token);
      }
    }
  }
};

export const reconcileRuntimeState = async (
  options: ReconcileOptions,
): Promise<ProcessRecoveryReport> => {
  if (options.isPermitted !== undefined && !options.isPermitted()) {
    return { entries: [] };
  }
  const entries: ProcessRecoveryEntry[] = [];
  for (const record of options.launches.list()) {
    entries.push(await reconcileLaunch(options, record));
  }
  await reconcileInstallChildren(options);
  return { entries };
};
