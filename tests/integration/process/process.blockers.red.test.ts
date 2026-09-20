/**
 * T007b — correct-behaviour variants for the runtime process blockers
 * (issue #45) on candidate pair main `562fa03` + runtime `4acb95a8`.
 *
 * Assertions encode the *correct* behaviour; the ones marked RED fail on the
 * recorded candidate and must pass unchanged after the fix. QA-only.
 *
 * - PROCESS-SCAN-01: unavailable scan must fail, not masquerade as empty.
 * - PROCESS-ORPHAN-01: close success implies no own descendant survives.
 * - PROCESS-RESTART-01 (RED): after a leader crash, a successful restart+close
 *   must leave no descendant of the old or new group; if the old group cannot
 *   be proven, restart must fail rather than silently drop the old record.
 * - PROCESS-GROUP-ATTR01 (RED, aligns #59 P2-B): an unrelated process that
 *   merely matches the fragment+generation must never be signalled; close must
 *   fail and keep the lock.
 * - PROCESS-GROUP-ATTR01-TIME (RED, #57 P2-B latest): group membership plus the
 *   start-time window alone is not ownership proof; an in-window member with no
 *   fragment/generation/ancestor identity must never be signalled.
 *
 * Preconditions verify the subtree is established at ready, never that an
 * orphan must remain alive (the implementation may clean up early).
 *
 * Safety: only pids recorded by these fixtures are killed, never a group or an
 * unknown pid.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupLostLeaderTree, createPosixProcessProbe } from '@hdsl/runtime';

import { isProcessAlive } from './support/identity.js';
import { waitFor } from './support/isolation.js';
import {
  cleanupProcessRoots,
  createProcessHarness,
  FIXTURE_SCRIPT,
  type ProcessHarness,
} from './support/managed-process.js';

const tempDirs: string[] = [];
const spawned: ChildProcess[] = [];
const harnesses: ProcessHarness[] = [];

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeNullIdentityRecord = (
  dataRoot: string,
  environmentId: string,
  generationDirectory: string,
  commandFragment: string,
): void => {
  const directory = join(dataRoot, 'process', 'launches');
  mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(directory, `${environmentId}.json`),
    `${JSON.stringify(
      {
        schemaVersion: '1',
        environmentId,
        expectedRevision: 1,
        generationDirectory,
        commandFragment,
        state: 'running',
        identity: null,
        endpoint: null,
        exitCode: null,
        errorCode: null,
        errorDetail: null,
        createdAt: now,
        updatedAt: now,
        sequence: 1,
      },
      null,
      2,
    )}\n`,
  );
};

const readInfo = (path: string): { pid: number; grandchildPid: number | null } | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { pid: number; grandchildPid: number | null };
  } catch {
    return undefined;
  }
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
  for (const child of spawned.splice(0)) {
    child.kill('SIGKILL');
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupProcessRoots();
});

describe('process QA correct-behaviour variants (main 562fa03 + runtime 4acb95a8)', () => {
  it('PROCESS-SCAN-01: an unavailable scan must not masquerade as "nothing to stop"', async () => {
    const dataRoot = tempDir('hdsl-proc-scan-');
    const environmentId = 'env-scan';
    const generationDirectory = join(dataRoot, 'generations', environmentId);
    // A shared fragment with no live process behind it.
    writeNullIdentityRecord(dataRoot, environmentId, generationDirectory, '/nonexistent/shared-dsh.js');

    // Control (passes today): a working scan that genuinely finds no candidate
    // is a legitimate success and reports wasRunning:false.
    const working = createProcessHarness({ dataRoot, probe: createPosixProcessProbe() });
    harnesses.push(working);
    const control = await working.manager.stop(working.request(environmentId));
    expect(control.ok).toBe(true);
    if (control.ok) {
      expect(control.value.wasRunning).toBe(false);
    }

    // Correct behaviour (RED today): with an unavailable scan the result must
    // not be a success, because nothing was actually proven.
    const failing = createProcessHarness({
      dataRoot,
      probe: createPosixProcessProbe({ psPath: '/nonexistent/ps-hdsl-qa' }),
    });
    harnesses.push(failing);
    const result = await failing.manager.stop(failing.request(environmentId));
    expect(result.ok).toBe(false);
  }, 30_000);

  it('PROCESS-ORPHAN-01: close leaves no own descendant (or fails) after the parent is killed', async () => {
    const infoRoot = tempDir('hdsl-proc-orphan-');
    mkdirSync(join(infoRoot, 'info'), { recursive: true });
    const infoPath = join(infoRoot, 'info', 'env-orphan.json');

    // Unrelated control: must survive the whole scenario.
    const control = spawn(
      process.execPath,
      [FIXTURE_SCRIPT, '--role', 'parent', '--mode', 'hold', '--label', 'orphan-control', '--record-dir', infoRoot],
      {
        env: { ...process.env, HDSL_QA_PROC_TOKEN: `hdsl-qa-orphan-control-${String(Date.now())}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    spawned.push(control);

    // `ready` mode: the parent stays alive with a real grandchild until we
    // SIGKILL it. This does not couple the test to the runtime's cleanup
    // timing: the runtime may reap the orphan early via watchExit, so the
    // precondition is "both exist at ready", not "the orphan stays alive".
    const harness = createProcessHarness({
      env: {
        HDSL_QA_DSH_MODE: 'ready',
        HDSL_QA_INFO_FILE: infoPath,
      },
    });
    harnesses.push(harness);

    let parentPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const started = await harness.manager.start(harness.request('env-orphan'));
      expect(started.ok).toBe(true);
      await waitFor(() => readInfo(infoPath)?.grandchildPid !== null, {
        timeoutMs: 5_000,
        label: 'orphan info written',
      });
      const info = readInfo(infoPath);
      parentPid = info?.pid;
      grandchildPid = info?.grandchildPid ?? undefined;
      // Precondition, before the crash: parent and grandchild really exist.
      expect(parentPid).toBeTruthy();
      expect(grandchildPid).toBeTruthy();
      await waitFor(() => isProcessAlive(parentPid as number) && isProcessAlive(grandchildPid as number), {
        timeoutMs: 5_000,
        label: 'parent and grandchild both alive at ready',
      });

      // Kill the parent outright (a crash, no cleanup handler runs).
      process.kill(parentPid as number, 'SIGKILL');
      await waitFor(() => !isProcessAlive(parentPid as number), {
        timeoutMs: 5_000,
        label: 'crashed parent gone',
      });

      const closed = await harness.manager.close();
      if (closed.ok) {
        // Correct: a successful close implies no own descendant remains,
        // whether the runtime reaped it early or during close.
        await waitFor(() => !isProcessAlive(grandchildPid as number), {
          timeoutMs: 5_000,
          label: 'no own descendant after successful close',
        });
      } else {
        // Correct: an unverifiable survivor must fail rather than be ignored.
        expect(closed.code).toBeTruthy();
      }
      expect(isProcessAlive(control.pid as number)).toBe(true);
    } finally {
      if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL');
      }
      if (parentPid !== undefined && isProcessAlive(parentPid)) {
        process.kill(parentPid, 'SIGKILL');
      }
    }
  }, 30_000);

  it('PROCESS-RESTART-01: restart after a leader crash, then close, leaves no old or new descendant', async () => {
    const harness = createProcessHarness({ env: { HDSL_QA_DSH_MODE: 'ready' } });
    harnesses.push(harness);
    const request = harness.request('env-restart');
    const infoPath = join(request.homeDirectory, '.hdsl-qa-fixture.json');

    let oldGrandchild: number | undefined;
    let newGrandchild: number | undefined;
    let oldParent: number | undefined;
    try {
      const started = await harness.manager.start(request);
      expect(started.ok).toBe(true);
      await waitFor(() => readInfo(infoPath)?.grandchildPid !== null, {
        timeoutMs: 5_000,
        label: 'first subtree established',
      });
      const first = readInfo(infoPath);
      oldParent = first?.pid;
      oldGrandchild = first?.grandchildPid ?? undefined;
      // Precondition: the subtree was established (not that the orphan stays up).
      await waitFor(() => isProcessAlive(oldParent as number) && isProcessAlive(oldGrandchild as number), {
        timeoutMs: 5_000,
        label: 'parent and grandchild established at ready',
      });

      // Crash the leader; the runtime may safely clean the orphan early.
      process.kill(oldParent as number, 'SIGKILL');
      await waitFor(() => !isProcessAlive(oldParent as number), {
        timeoutMs: 5_000,
        label: 'old leader gone',
      });

      const restarted = await harness.manager.start(request);
      if (restarted.ok) {
        await waitFor(
          () => {
            const info = readInfo(infoPath);
            return info?.pid !== oldParent && info?.grandchildPid !== null && info?.grandchildPid !== undefined;
          },
          { timeoutMs: 5_000, label: 'second subtree established' },
        );
        newGrandchild = readInfo(infoPath)?.grandchildPid ?? undefined;

        const closed = await harness.manager.close();
        if (closed.ok) {
          // Correct: after a successful restart+close no own descendant of the
          // old *or* new group remains.
          await waitFor(() => !isProcessAlive(oldGrandchild as number), {
            timeoutMs: 5_000,
            label: 'old descendant gone after restart+close',
          });
          if (newGrandchild !== undefined) {
            await waitFor(() => !isProcessAlive(newGrandchild as number), {
              timeoutMs: 5_000,
              label: 'new descendant gone after close',
            });
          }
        } else {
          // A failed close is acceptable, but the old orphan must not be
          // silently abandoned: it must still be gone (or close failed).
          expect(closed.code).toBeTruthy();
        }
      } else {
        // Correct if ownership cannot be proven: restart fails and does not
        // pretend success; the old group must not be left unaccounted for.
        expect(restarted.code).toBeTruthy();
        await harness.manager.close();
        await waitFor(() => !isProcessAlive(oldGrandchild as number), {
          timeoutMs: 5_000,
          label: 'old descendant gone after failed restart',
        });
      }
    } finally {
      for (const pid of [oldGrandchild, newGrandchild, oldParent]) {
        if (pid !== undefined && isProcessAlive(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
    }
  }, 30_000);

  it('PROCESS-GROUP-ATTR01: an unrelated process matching fragment+generation is never signalled; close fails', async () => {
    const dataRoot = tempDir('hdsl-proc-decoy-');
    const environmentId = 'env-decoy';
    const generationDirectory = join(dataRoot, 'generations', environmentId, 'dsh');
    mkdirSync(generationDirectory, { recursive: true });
    // identity-null record whose fragment+generation would match the decoy.
    writeNullIdentityRecord(dataRoot, environmentId, generationDirectory, FIXTURE_SCRIPT);

    const decoy = spawn(
      process.execPath,
      [FIXTURE_SCRIPT, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0', '--generation', generationDirectory],
      {
        env: {
          ...process.env,
          HDSL_QA_DSH_MODE: 'ready',
          HDSL_QA_NO_GRANDCHILD: '1',
          HDSL_QA_INFO_FILE: join(dataRoot, 'decoy-info.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    spawned.push(decoy);

    const probe = createPosixProcessProbe();
    await waitFor(
      () =>
        probe.findIdsByCommandFragment(FIXTURE_SCRIPT).includes(decoy.pid as number) &&
        (probe.inspect(decoy.pid as number)?.command.includes(generationDirectory) ?? false),
      { timeoutMs: 5_000, label: 'decoy matches the record fragment+generation' },
    );

    const harness = createProcessHarness({ dataRoot });
    harnesses.push(harness);
    try {
      const closed = await harness.manager.close();
      // Correct: an unprovable/unrelated member must not receive a signal, and
      // close must fail (and leave the lock) rather than report success.
      expect(isProcessAlive(decoy.pid as number)).toBe(true);
      expect(closed.ok).toBe(false);
    } finally {
      if (isProcessAlive(decoy.pid as number)) {
        process.kill(decoy.pid as number, 'SIGKILL');
      }
    }
  }, 30_000);

  it('PROCESS-GROUP-ATTR01-TIME: group/time evidence alone never signals an unowned member (even in-window)', async () => {
    const probe = createPosixProcessProbe();
    const pidFile = join(tempDir('hdsl-proc-time-decoy-'), 'member.pid');

    // A detached group leader that spawns a member in the same group. The
    // member's command carries neither the fragment nor the generation, so
    // only the time window could "prove" it.
    const leader = spawn(
      process.execPath,
      [
        '-e',
        "const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1<<30)'],{stdio:'ignore'});fs.writeFileSync(process.env.M_PID_FILE,String(c.pid));setInterval(()=>{},1<<30);",
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, M_PID_FILE: pidFile },
      },
    );
    spawned.push(leader);

    let memberPid = 0;
    const readPid = (): number => {
      try {
        const value = Number(readFileSync(pidFile, 'utf8').trim());
        return Number.isInteger(value) && value > 0 ? value : 0;
      } catch {
        return 0;
      }
    };
    try {
      await waitFor(() => readPid() > 0, {
        timeoutMs: 5_000,
        label: 'member pid written',
      });
      memberPid = readPid();
      expect(memberPid).toBeGreaterThan(0);
      await waitFor(() => probe.inspect(memberPid)?.pgid === (leader.pid as number), {
        timeoutMs: 5_000,
        label: 'member shares the group',
      });

      // In-window: the member started before exitedAt+1000ms; no fragment or
      // generation evidence ties it to any launch.
      const result = await cleanupLostLeaderTree({
        probe,
        pgid: leader.pid as number,
        leaderReason: 'dead',
        commandFragment: '/nonexistent-fragment-hdsl-qa',
        generationDirectory: '/nonexistent-generation-hdsl-qa',
        exitedAt: new Date().toISOString(),
        confirmMs: 200,
      });
      // Correct: group + time alone is not ownership proof. The member must not
      // be signalled and cleanup must fail closed.
      expect(isProcessAlive(memberPid)).toBe(true);
      expect(result.ok).toBe(false);
    } finally {
      for (const pid of [memberPid, leader.pid as number]) {
        if (pid > 0 && isProcessAlive(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
    }
  }, 30_000);
});
