/**
 * Process identity probe.
 *
 * `inspect()` reads the kernel's own view of a pid: the process start token
 * (`ps -o lstart=`), the process group and the full command line. `startToken`
 * is what makes a pid reusable: two different processes can share a pid across
 * time, but the kernel start token differs. T005 therefore never treats a pid
 * alone as ownership evidence.
 *
 * Scan results are **tri-state**: a successful scan returns entries (possibly
 * empty), while an unavailable/failed scan returns `undefined`. Callers must
 * never treat "we could not scan" as "nothing is running" — that would be
 * fail-open and could let a live managed process be reported as stopped.
 *
 * The probe is an interface so unit tests can inject deterministic identity
 * transitions (for example: "the recorded pid is now an unrelated process")
 * without having to race the operating system.
 */
import { execFileSync } from 'node:child_process';

export interface ProcessInfo {
  readonly pid: number;
  readonly pgid: number;
  /** Kernel start time, raw `ps -o lstart=` text (C locale). */
  readonly startToken: string;
  readonly command: string;
}

export interface ProcessScanEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface ProcessProbe {
  inspect(pid: number): ProcessInfo | undefined;
  /** Legacy scan; returns `[]` on failure. Prefer the checked variants below. */
  scan(): readonly ProcessScanEntry[];
  /** Legacy id lookup; returns `[]` on failure. Prefer {@link tryFindIdsByCommandFragment}. */
  findIdsByCommandFragment(fragment: string): readonly number[];
  /**
   * Pids whose command line contains `fragment`; `undefined` means the scan
   * failed and must never be treated as "no match".
   */
  tryFindIdsByCommandFragment(fragment: string): readonly number[] | undefined;
  /** Live members of one process group, or `undefined` when the scan failed. */
  listProcessGroup(pgid: number): readonly ProcessInfo[] | undefined;
}

export interface PosixProcessProbeOptions {
  readonly psPath?: string;
}

const LSTART_PATTERN = /^(\w{3} \w{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/s;

const probeEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C' });

/** `ps` based probe for macOS and Linux; unsupported elsewhere. */
export const createPosixProcessProbe = (
  options: PosixProcessProbeOptions = {},
): ProcessProbe => {
  const ps = options.psPath ?? 'ps';

  const run = (args: readonly string[]): string | undefined => {
    try {
      return execFileSync(ps, [...args], {
        encoding: 'utf8',
        env: probeEnvironment(),
        maxBuffer: 8 * 1024 * 1024,
        // stderr is discarded: an unknown pid is a normal "not found" result,
        // not launcher noise.
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // Covers a missing `ps`, a permission failure and maxBuffer overflow.
      // All three mean "the scan is unreliable", not "no processes".
      return undefined;
    }
  };

  const parseInfoLine = (line: string): ProcessInfo | undefined => {
    const match = LSTART_PATTERN.exec(line.trim());
    if (match === null) {
      return undefined;
    }
    const pid = Number(match[2]);
    const pgid = Number(match[4]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(pgid)) {
      return undefined;
    }
    return {
      pid,
      pgid,
      startToken: (match[1] ?? '').trim(),
      command: match[5] ?? '',
    };
  };

  const inspect = (pid: number): ProcessInfo | undefined => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    const output = run(['-o', 'lstart=,pid=,ppid=,pgid=,command=', '-p', String(pid)]);
    if (output === undefined) {
      return undefined;
    }
    const info = parseInfoLine(output);
    return info !== undefined && info.pid === pid ? info : undefined;
  };

  const tryScan = (): readonly ProcessScanEntry[] | undefined => {
    const output = run(['-ax', '-o', 'pid=,ppid=,command=']);
    if (output === undefined) {
      return undefined;
    }
    const entries: ProcessScanEntry[] = [];
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null) {
        continue;
      }
      entries.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3] ?? '',
      });
    }
    return entries;
  };

  const scan = (): readonly ProcessScanEntry[] => tryScan() ?? [];

  const tryFindIdsByCommandFragment = (
    fragment: string,
  ): readonly number[] | undefined => {
    if (fragment.length === 0) {
      return [];
    }
    const entries = tryScan();
    if (entries === undefined) {
      return undefined;
    }
    return entries.filter((entry) => entry.command.includes(fragment)).map((entry) => entry.pid);
  };

  const listProcessGroup = (pgid: number): readonly ProcessInfo[] | undefined => {
    if (!Number.isInteger(pgid) || pgid <= 0) {
      return [];
    }
    const output = run(['-ax', '-o', 'lstart=,pid=,ppid=,pgid=,command=']);
    if (output === undefined) {
      return undefined;
    }
    const members: ProcessInfo[] = [];
    for (const line of output.split('\n')) {
      const info = parseInfoLine(line);
      if (info !== undefined && info.pgid === pgid) {
        members.push(info);
      }
    }
    return members;
  };

  return {
    inspect,
    scan,
    findIdsByCommandFragment: (fragment: string) =>
      tryFindIdsByCommandFragment(fragment) ?? [],
    tryFindIdsByCommandFragment,
    listProcessGroup,
  };
};
