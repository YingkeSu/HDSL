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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
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
  /** Expected `sha256` of the verified tarball bytes. */
  readonly sha256: string;
  /** Entry path inside the extracted artifact (e.g. `bin/pnpm.mjs`). */
  readonly entryPath: string;
  /** Expected `sha256` of the executed entry. */
  readonly entrySha256: string;
  /** Expected digest of the extracted dependency tree. */
  readonly treeSha256: string;
}

/**
 * Frozen managed pnpm artifact (E1). Values computed from a bounded official
 * download of `https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz`: the `sha512`
 * matches the registry integrity, the `sha256` is the artifact digest, and the
 * entry/tree digests bind the safe extraction.
 */
export const PNPM_EXECUTOR_SPEC: PnpmExecutorSpec = {
  id: 'pnpm',
  version: '11.7.0',
  url: 'https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz',
  sha512: 'sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==',
  sha256: 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee',
  entryPath: 'bin/pnpm.mjs',
  entrySha256: 'ff3224d46b47fbb24a7e9fe15fededef7e00892d07d4e376b6762d4899906bfd',
  treeSha256: '8c69f816165f8a2b005fa2fc104cf64d30f9d2beba4fc02be794244dc8b4e899',
};

/** Deterministic digest over an extracted tree (files + symlink targets). */
export const executorTreeDigest = (root: string): string => {
  const entries: unknown[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) {
        entries.push(['link', rel, readlinkSync(full)]);
      } else if (stats.isDirectory()) {
        walk(full, rel);
      } else if (stats.isFile()) {
        entries.push(['file', rel, stats.size, createHash('sha256').update(readFileSync(full)).digest('hex')]);
      }
    }
  };
  walk(root, '');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
};

export interface PluginExecutorRunRequest {
  readonly cwd: string;
  readonly homeDirectory: string;
  readonly nodeExecutable: string;
  /** pnpm arguments as an array; never shell-interpolated. */
  readonly args: readonly string[];
  /** Pinned registry; defaults to the official registry. */
  readonly registry?: string;
  /**
   * Bounded command timeout. Defaults to the executor's own bound. A caller that
   * must fail fast (for example the target-profile lock resolution) passes a
   * tighter value; the child process tree is always killed on timeout/cancel.
   */
  readonly timeoutMs?: number;
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

/**
 * Default-deny install arguments (ADR 0005 D14). `--ignore-scripts` blocks the
 * root project and every dependency lifecycle script (preinstall/install/
 * postinstall/prepare). Real rc.2-chain evidence: with `--ignore-scripts` no
 * marker was written for a root project or a git-hosted dependency; without it
 * pnpm ran the root scripts and required a precise `allowBuilds` entry
 * (`"<name>@git+<url>#<sha>": true`) to run the dependency's scripts. pnpm
 * rejects a name-only `allowBuilds` for git deps
 * (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), which matches the "authorization is
 * bound to the exact commit and script set" rule.
 */
export const DEFAULT_INSTALL_ARGS = ['install', '--ignore-scripts'] as const;


export const createManagedPnpmExecutor = (
  options: ManagedPnpmExecutorOptions,
): PluginExecutorPort => {
  const execute = options.execute ?? runCommand;
  const commandTimeoutMs = options.commandTimeoutMs ?? 10 * 60_000;
  let prepared: { readonly identity: ExecutorIdentity; readonly entry: string } | undefined;

  const ensure = async (
    signal: AbortSignal,
  ): Promise<PortOutcome<{ readonly identity: ExecutorIdentity; readonly entry: string }>> => {
    const directory = join(options.cacheDirectory, 'pnpm', options.spec.version, options.spec.sha256);
    const archive = join(directory, 'pnpm.tgz');
    const extractRoot = join(directory, 'package');
    const entry = join(extractRoot, ...options.spec.entryPath.split('/'));
    const extractionIsBound = (): boolean => {
      if (!existsSync(entry) || !existsSync(extractRoot)) {
        return false;
      }
      try {
        const entrySha = createHash('sha256').update(readFileSync(entry)).digest('hex');
        return entrySha === options.spec.entrySha256 && executorTreeDigest(extractRoot) === options.spec.treeSha256;
      } catch {
        return false;
      }
    };
    const identity: ExecutorIdentity = {
      id: options.spec.id,
      version: options.spec.version,
      sha256: options.spec.sha256,
      entrySha256: options.spec.entrySha256,
      treeSha256: options.spec.treeSha256,
    };
    if (prepared !== undefined && extractionIsBound()) {
      return portOk(prepared);
    }
    try {
      if (!extractionIsBound()) {
        mkdirSync(directory, { recursive: true });
        // Re-verify (or re-fetch) the pinned archive before re-extracting. A
        // tampered cache never becomes the executed tree.
        if (!existsSync(archive)) {
          await downloadToFile(options.spec.url, archive, {
            fetch: options.fetch,
            signal,
            maxBytes: 200 * 1024 * 1024,
          });
        }
        const integrity = await sha512Integrity(archive);
        const artifactSha = await sha256File(archive);
        if (integrity !== options.spec.sha512 || artifactSha !== options.spec.sha256) {
          return portFail('EXECUTOR_UNAVAILABLE', 'the managed pnpm artifact does not match the pinned spec');
        }
        rmSync(extractRoot, { recursive: true, force: true });
        await extractTarGz(archive, extractRoot, { stripComponents: 1 });
        if (!extractionIsBound()) {
          return portFail(
            'EXECUTOR_UNAVAILABLE',
            'the extracted managed pnpm tree does not match the pinned entry/tree digests',
          );
        }
      }
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
          timeoutMs: request.timeoutMs ?? commandTimeoutMs,
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
