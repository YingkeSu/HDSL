/**
 * PID identity verification for process-lifecycle QA.
 *
 * A raw PID is not an ownership proof: the OS reuses PIDs and a launcher (or a
 * QA cleanup) that kills by PID alone can terminate an unrelated process. Every
 * signal this harness sends must first pass {@link verifyOwnership}, which
 * checks that the live process still carries the fixture's unique token in its
 * command line *and* that its `ps lstart` start time matches the one recorded
 * when the fixture started. A mismatch is a hard error, never a silent kill.
 */
import { execFileSync } from 'node:child_process';

export interface FixtureRecord {
  readonly token: string;
  readonly role: string;
  readonly mode: string;
  readonly label: string;
  readonly pid: number;
  readonly ppid: number;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly startedAt: number;
  readonly startTime: string;
  readonly grandchildPid?: number;
  readonly boundPort?: number;
  /** Present when the fixture was spawned with an explicit environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProcessTableEntry {
  readonly pid: number;
  readonly startTime: string;
  readonly command: string;
}

export class OwnershipError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

/** Reads `pid`, `lstart` and `command` from `ps`; undefined when the PID is gone. */
export const readProcessTableEntry = (pid: number): ProcessTableEntry | undefined => {
  let output: string;
  try {
    output = execFileSync('ps', ['-o', 'pid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const tokens = trimmed.split(/\s+/);
  const parsedPid = Number(tokens[0]);
  if (!Number.isInteger(parsedPid) || tokens.length < 6) {
    return undefined;
  }
  // `lstart` is the five tokens after the PID (e.g. "Sun Sep 20 19:03:28 2026");
  // everything after that is the command line.
  const startTime = tokens.slice(1, 6).join(' ');
  const command = trimmed.slice(trimmed.indexOf(tokens[5] as string));
  return { pid: parsedPid, startTime, command };
};

/** True when a signal with `0` succeeds, i.e. the PID exists (any owner). */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Proves a live PID is still the fixture identified by `record`.
 *
 * Throws {@link OwnershipError} — it never returns "probably fine" — when the
 * PID is gone, the start time differs (PID reuse) or the command line does not
 * carry the fixture token.
 */
export const verifyOwnership = (record: Pick<FixtureRecord, 'pid' | 'token' | 'startTime'>): ProcessTableEntry => {
  const entry = readProcessTableEntry(record.pid);
  if (entry === undefined) {
    throw new OwnershipError(`pid ${record.pid} is not present`);
  }
  if (entry.startTime !== record.startTime) {
    throw new OwnershipError(
      `pid ${record.pid} start time changed (${record.startTime} -> ${entry.startTime}); PID was reused`,
    );
  }
  if (!entry.command.includes(record.token)) {
    throw new OwnershipError(`pid ${record.pid} command line does not carry token ${record.token}`);
  }
  return entry;
};

/**
 * Signals a PID only after {@link verifyOwnership}. The negative control in the
 * harness proves that a token mismatch is refused instead of killing.
 */
export const killGuarded = (
  record: Pick<FixtureRecord, 'pid' | 'token' | 'startTime'>,
  signal: NodeJS.Signals = 'SIGTERM',
): void => {
  verifyOwnership(record);
  process.kill(record.pid, signal);
};
