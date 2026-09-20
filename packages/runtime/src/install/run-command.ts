/**
 * Runs a managed child process with an explicit environment.
 *
 * Used only by the installer (`npm ci` and the post-install preflight). The
 * child never inherits the host environment: callers pass the full variable set,
 * with `HOME`, `DSH_HOME` and every cache directory pointed inside the app-data
 * root, so the host default directories are never touched (FR-003/FR-001). Real
 * DSH process lifecycle/readiness stays in T005.
 */
import { spawn } from 'node:child_process';
import { InstallFailure } from './failure.js';

export interface RunCommandOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

export interface RunCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export const runCommand = (
  executable: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> =>
  new Promise((resolve, reject) => {
    const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const append = (current: string, chunk: Buffer, counter: number): [string, number] => {
      const nextCounter = counter + chunk.byteLength;
      if (nextCounter > maxOutputBytes) {
        return [current, nextCounter];
      }
      return [current + chunk.toString('utf8'), nextCounter];
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
      child.kill('SIGKILL');
    }, options.timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGKILL');
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
      reject(new InstallFailure('INTERNAL_ERROR', `could not run the managed command: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      termination();
      resolve({
        exitCode: code ?? (signal === null ? -1 : 128),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
