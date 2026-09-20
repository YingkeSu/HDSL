/**
 * Runs a managed child process with an explicit environment.
 *
 * Used by the installer (`npm ci` and the post-install preflight) and by the
 * managed process lifecycle. Two T005 guarantees live here:
 *
 * - **whole-tree termination**: every managed child is spawned as its own
 *   process-group leader (`detached` on POSIX), so a cancel, timeout or spawn
 *   error terminates the entire subtree — `npm ci`'s own Node children included
 *   — not just the direct child. The promise settles only after the tree has
 *   been signalled and the direct child reaped.
 * - **durable identity**: for managed installs the child's identity
 *   (pid + kernel start token + executable) is journalled under the generation
 *   directory, so a crash leaves an ownership record that restart
 *   reconciliation can prove with the same check the DSH launch uses. The
 *   journal never contains argv credentials (credentials are only ever passed
 *   through the explicit environment, not argv).
 *
 * The child never inherits the host environment: callers pass the full variable
 * set, with `HOME`, `DSH_HOME` and every cache directory pointed inside the
 * app-data root (FR-003/FR-001). Real DSH process lifecycle/readiness stays in
 * `process/`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { InstallFailure } from './failure.js';
import { createPosixProcessProbe, type ProcessProbe } from '../process/probe.js';
import {
  InstallChildJournal,
  installChildDirectoryForEnvironment,
  type InstallChildRecord,
} from '../process/records.js';
import { delay, killProcessTreeSync } from '../process/tree.js';

export interface RunCommandOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  /** Explicit install-child journal directory; derived from `env` by default. */
  readonly processJournalDirectory?: string;
  readonly probe?: ProcessProbe;
}

export interface RunCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const captureChildIdentity = async (
  probe: ProcessProbe,
  pid: number,
): Promise<{ readonly pgid: number; readonly startToken: string } | undefined> => {
  const deadline = Date.now() + 1_500;
  for (;;) {
    const info = probe.inspect(pid);
    if (info !== undefined) {
      return { pgid: info.pgid, startToken: info.startToken };
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await delay(25);
  }
};

export const runCommand = (
  executable: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> =>
  new Promise((resolve, reject) => {
    const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    const supportsProcessGroups = process.platform !== 'win32';
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: supportsProcessGroups,
    });

    const journalDirectory =
      options.processJournalDirectory ?? installChildDirectoryForEnvironment(options.env);
    const journal = journalDirectory === undefined ? undefined : new InstallChildJournal(journalDirectory);
    const token = randomUUID();
    let journalWrite: Promise<void> | undefined;

    const pid = child.pid;
    if (journal !== undefined && pid !== undefined) {
      const probe = options.probe ?? createPosixProcessProbe();
      journalWrite = (async () => {
        const identity = await captureChildIdentity(probe, pid);
        if (identity === undefined) {
          // Without a kernel identity the record cannot be verified later, so
          // it is not written; tree termination on timeout/cancel still applies.
          return;
        }
        const record: InstallChildRecord = {
          schemaVersion: '1',
          token,
          pid,
          pgid: identity.pgid,
          startToken: identity.startToken,
          // Executable path only: argv may carry values that must not persist.
          commandFragment: executable,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        journal.write(record);
      })().catch(() => {
        // Journaling is best effort; it must never fail the managed command.
      });
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (current: string, chunk: Buffer, counter: number): [string, number] => {
      const nextCounter = counter + chunk.byteLength;
      if (nextCounter > maxOutputBytes) {
        return [current, nextCounter];
      }
      return [current + chunk.toString('utf8'), nextCounter];
    };

    const killTree = (): void => {
      if (pid === undefined) {
        child.kill('SIGKILL');
        return;
      }
      killProcessTreeSync({ pid, pgid: pid }, { group: supportsProcessGroups });
    };

    const releaseJournal = async (): Promise<void> => {
      if (journalWrite !== undefined) {
        await journalWrite;
      }
      journal?.remove(token);
    };

    const termination = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      [stdout, stdoutBytes] = append(stdout, chunk, stdoutBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      [stderr, stderrBytes] = append(stderr, chunk, stderrBytes);
    });
    child.on('error', (error) => {
      termination();
      killTree();
      void releaseJournal().finally(() => {
        reject(
          new InstallFailure('INTERNAL_ERROR', `could not run the managed command: ${error.message}`),
        );
      });
    });
    child.on('close', (code, signal) => {
      termination();
      // A timed-out or aborted command may have left descendants behind the
      // (now reaped) direct child; signal the group once more before settling.
      if (timedOut || aborted) {
        killTree();
      }
      void releaseJournal().finally(() => {
        resolve({
          exitCode: code ?? (signal === null ? -1 : 128),
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  });
