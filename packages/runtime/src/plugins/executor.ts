/**
 * Managed pnpm executor (ADR 0005 D8/D14).
 *
 * Identity is verified, not assumed: the pinned artifact is downloaded from the
 * official registry, its `sha512` integrity is checked against the pinned spec,
 * a `sha256` is computed from the verified bytes and recorded as the executor
 * identity, and the executed entry (`bin/pnpm.mjs`) is resolved from the safely
 * extracted artifact. Any mismatch is a controlled `EXECUTOR_UNAVAILABLE`; the
 * host `pnpm` and the host `PATH` are never used.
 *
 * `executedInstallScripts` is an observation report only. It is NOT proof that
 * the default deny held; the authoritative sentinel observes an external
 * side-effect (marker file) on the same execution chain.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { portFail, portOk, type ExecutorIdentity, type PortOutcome } from '@hdsl/contracts';
import { downloadToFile, type FetchLike } from '../install/download.js';
import { sha256File, sha512Integrity } from '../install/hash.js';
import { runCommand, type RunCommandOptions, type RunCommandResult } from '../install/run-command.js';
import { extractTarGz } from '../install/tar.js';

export interface PnpmExecutorSpec {
  readonly id: 'pnpm';
  readonly version: string;
  readonly url: string;
  /** Registry `sha512-...` integrity of the pinned tarball. */
  readonly sha512: string;
}

export interface PluginExecutorRunRequest {
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly nodeExecutable: string;
  /** pnpm arguments as an array; never shell-interpolated. */
  readonly args: readonly string[];
  /** Pinned registry; defaults to the official registry. */
  readonly registry?: string;
}

export interface ExecutorRunResult {
  /** Verified executor identity, bound into the plan inputs digest. */
  readonly executor: ExecutorIdentity;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Observation report only; never a default-deny proof. */
  readonly executedInstallScripts: readonly string[];
}

export interface PluginExecutorPort {
  identity(signal: AbortSignal): Promise<PortOutcome<ExecutorIdentity>>;
  run(
    request: PluginExecutorRunRequest,
    signal: AbortSignal,
  ): Promise<PortOutcome<ExecutorRunResult>>;
}

export interface ManagedPnpmExecutorOptions {
  readonly spec: PnpmExecutorSpec;
  readonly cacheDirectory: string;
  readonly fetch: FetchLike;
  readonly commandTimeoutMs?: number;
  /** Command-execution seam; defaults to the real bounded `runCommand`. */
  readonly execute?: (
    executable: string,
    args: readonly string[],
    options: RunCommandOptions,
  ) => Promise<RunCommandResult>;
}

export const DEFAULT_PNPM_REGISTRY = 'https://registry.npmjs.org';

export const createManagedPnpmExecutor = (
  options: ManagedPnpmExecutorOptions,
): PluginExecutorPort => {
  const execute = options.execute ?? runCommand;
  const commandTimeoutMs = options.commandTimeoutMs ?? 10 * 60_000;
  let prepared: { readonly identity: ExecutorIdentity; readonly entry: string } | undefined;

  const ensure = async (
    signal: AbortSignal,
  ): Promise<PortOutcome<{ readonly identity: ExecutorIdentity; readonly entry: string }>> => {
    if (prepared !== undefined) {
      return portOk(prepared);
    }
    const directory = join(options.cacheDirectory, 'pnpm', options.spec.version);
    const archive = join(directory, 'pnpm.tgz');
    const extractRoot = join(directory, 'package');
    const entry = join(extractRoot, 'bin', 'pnpm.mjs');
    try {
      if (!existsSync(entry)) {
        mkdirSync(directory, { recursive: true });
        await downloadToFile(options.spec.url, archive, {
          fetch: options.fetch,
          signal,
          maxBytes: 200 * 1024 * 1024,
        });
        const integrity = await sha512Integrity(archive);
        if (integrity !== options.spec.sha512) {
          return portFail(
            'EXECUTOR_UNAVAILABLE',
            'the managed pnpm artifact integrity does not match the pinned spec',
          );
        }
        rmSync(extractRoot, { recursive: true, force: true });
        await extractTarGz(archive, extractRoot, { stripComponents: 1 });
        if (!existsSync(entry)) {
          return portFail(
            'EXECUTOR_UNAVAILABLE',
            'the managed pnpm artifact did not contain bin/pnpm.mjs',
          );
        }
      }
      const sha256 = await sha256File(archive);
      const identity: ExecutorIdentity = { id: options.spec.id, version: options.spec.version, sha256 };
      prepared = { identity, entry };
      return portOk(prepared);
    } catch {
      return portFail(
        'EXECUTOR_UNAVAILABLE',
        'the managed pnpm executor could not be prepared from the pinned artifact',
      );
    }
  };

  return {
    identity: async (signal) => {
      const result = await ensure(signal);
      return result.ok ? portOk(result.value.identity) : result;
    },
    run: async (request, signal) => {
      const ready = await ensure(signal);
      if (!ready.ok) {
        return ready;
      }
      const nodeBin = dirname(request.nodeExecutable);
      const environment: Record<string, string> = {
        HOME: request.homeDirectory,
        DSH_HOME: request.homeDirectory,
        TMPDIR: join(request.homeDirectory, '.tmp'),
        // Explicit, pinned PATH: the managed Node bin plus system dirs only. The
        // host PATH is never inherited.
        PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        npm_config_registry: request.registry ?? DEFAULT_PNPM_REGISTRY,
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      };
      try {
        mkdirSync(environment['TMPDIR'] as string, { recursive: true });
        const result = await execute(request.nodeExecutable, [ready.value.entry, ...request.args], {
          cwd: request.cwd,
          env: environment,
          timeoutMs: commandTimeoutMs,
          signal,
        });
        return portOk({
          executor: ready.value.identity,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          executedInstallScripts: [],
        });
      } catch {
        return portFail('EXECUTOR_UNAVAILABLE', 'the managed pnpm run could not be executed');
      }
    },
  };
};

/** `sha256` of arbitrary bytes (used to bind an executor identity to content). */
export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
