/**
 * Process identity probe.
 *
 * `inspect()` reads the kernel's own view of a pid: the process start token
 * (`ps -o lstart=`), the process group and the full command line. `startToken`
 * is what makes a pid reusable: two different processes can share a pid across
 * time, but the kernel start token differs. T005 therefore never treats a pid
 * alone as ownership evidence.
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
  scan(): readonly ProcessScanEntry[];
  /** Pids whose full command line contains `fragment` (exact substring). */
  findIdsByCommandFragment(fragment: string): readonly number[];
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
      return undefined;
    }
  };

  const inspect = (pid: number): ProcessInfo | undefined => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return undefined;
    }
    const output = run(['-o', 'lstart=,pid=,ppid=,pgid=,command=', '-p', String(pid)]);
    if (output === undefined) {
      return undefined;
    }
    const match = LSTART_PATTERN.exec(output.trim());
    if (match === null) {
      return undefined;
    }
    const parsedPid = Number(match[2]);
    const parsedPgid = Number(match[4]);
    if (parsedPid !== pid || !Number.isInteger(parsedPgid)) {
      return undefined;
    }
    return {
      pid: parsedPid,
      pgid: parsedPgid,
      startToken: (match[1] ?? '').trim(),
      command: match[5] ?? '',
    };
  };

  const scan = (): readonly ProcessScanEntry[] => {
    const output = run(['-ax', '-o', 'pid=,ppid=,command=']);
    if (output === undefined) {
      return [];
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

  return {
    inspect,
    scan,
    findIdsByCommandFragment: (fragment: string) =>
      fragment.length === 0
        ? []
        : scan()
            .filter((entry) => entry.command.includes(fragment))
            .map((entry) => entry.pid),
  };
};
