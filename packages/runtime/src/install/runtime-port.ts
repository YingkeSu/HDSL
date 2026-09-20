/**
 * The concrete managed-runtime port: audited catalog → composition lock →
 * verified download → safe extraction → DSH dependency closure → preflight.
 *
 * This is the real installer (no in-memory mock): it downloads the audited
 * artifacts, verifies their SHA-256, extracts them, installs the DSH dependency
 * closure with the managed Node's own `npm ci` from the shipped exact lock and
 * runs a bounded managed preflight. All child processes run with an explicit
 * environment rooted inside the app-data directory, so the host default HOME
 * and `~/.dsh` are never touched.
 *
 * The interface is intentionally structural so a caller can pass this object to
 * `@hdsl/core`'s `createManagedInstall` without either package depending on the
 * other.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  type CompositionLock,
  type HostPlatform,
  type PortOutcome,
  type RuntimeCombination,
} from '@hdsl/contracts';
import { CATALOG_REVISION } from '../catalog/combinations.js';
import { readDependencyClosure } from '../catalog/dependency-closure.js';
import { computeCompositionDigest, resolveComposition } from '../composition/digest.js';
import { defaultFreeBytes, type FreeBytesProbe } from './disk.js';
import { downloadToFile, type FetchLike } from './download.js';
import { InstallFailure, successOutcome, toFailure } from './failure.js';
import { sha256File, sha256TreeDigest, sha512Integrity } from './hash.js';
import { writeJsonFileSync, type InstallCheck, type InstallManifest, type InstallMode } from './manifest.js';
import { runCommand } from './run-command.js';
import { extractTarGz } from './tar.js';

export interface InstallFaults {
  /** Abort the transfer after N received bytes → `DOWNLOAD_FAILED`. */
  readonly failDownloadAfterBytes?: number;
  /** Flip a byte after a successful transfer → `DIGEST_MISMATCH`. */
  readonly corruptDownload?: boolean;
  /** Deterministic `DISK_FULL` before any download/extraction. */
  readonly forceDiskFull?: boolean;
  /** Fail the extraction step → `INTERNAL_ERROR`. */
  readonly failExtraction?: boolean;
}

export interface RuntimeLimits {
  readonly maxDownloadBytes?: number;
  readonly maxExtractedBytes?: number;
  readonly minFreeBytes?: number;
}

export interface RuntimePortOptions {
  readonly host?: HostPlatform;
  readonly fetch?: FetchLike;
  readonly faults?: InstallFaults;
  readonly urlRewrites?: Readonly<Record<string, string>>;
  /**
   * Offline fixture root: `<dir>/<sha256>/<file>`. The SHA-256 is still
   * enforced, so this only removes the network, never the integrity check.
   */
  readonly localArtifactDirectory?: string;
  readonly diskFreeBytes?: FreeBytesProbe;
  readonly limits?: RuntimeLimits;
  /**
   * `true` (default) installs the audited DSH dependency closure with the
   * managed Node's `npm ci`. Synthetic fixtures set `false`, and the manifest
   * then records `installMode: 'artifacts-only'` so the generation can never be
   * mistaken for a complete install.
   */
  readonly closureInstall?: boolean;
  /** `'managed'` (default) runs the version/help preflight; `'none'` skips it. */
  readonly precheck?: 'managed' | 'none';
  readonly npmRegistry?: string;
  readonly clock?: () => Date;
  readonly commandTimeoutMs?: number;
}

export interface InstallProgress {
  readonly phase: string;
  readonly progress?: number;
}

export interface InstallContext {
  readonly signal: AbortSignal;
  readonly cacheDirectory: string;
  readonly scratchDirectory: string;
  readonly npmCacheDirectory: string;
  readonly onProgress?: (update: InstallProgress) => void;
}

export interface InstalledRuntimeArtifacts {
  readonly directory: string;
  readonly nodeExecutable: string;
  readonly dshEntrypoint: string;
  readonly manifestPath: string;
}

export interface ManagedRuntimePort {
  resolveComposition(combination: RuntimeCombination): PortOutcome<CompositionLock>;
  compositionDigest(lock: CompositionLock): string;
  install(
    lock: CompositionLock,
    destination: string,
    context: InstallContext,
  ): Promise<PortOutcome<InstalledRuntimeArtifacts>>;
}

const MIB = 1024 * 1024;
const NODE_DIRECTORY = 'node';
const DSH_DIRECTORY = 'dsh';
const DSH_PACKAGE_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh'] as const;

/** The full child environment: nothing is inherited from the host. */
const baseEnvironment = (home: string, nodeBin: string, npmCache: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  HOME: home,
  DSH_HOME: home,
  PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  TMPDIR: join(home, '.tmp'),
  npm_config_cache: npmCache,
  npm_config_update_notifier: 'false',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_yes: 'true',
  ...extra,
});

const findLocalArtifact = (directory: string, sha256: string): string | undefined => {
  const artifactDirectory = join(directory, sha256);
  if (!existsSync(artifactDirectory) || !statSync(artifactDirectory).isDirectory()) {
    return undefined;
  }
  const names = readdirSync(artifactDirectory).sort();
  const first = names[0];
  return first === undefined ? undefined : join(artifactDirectory, first);
};

const fileNameForUrl = (url: string): string => {
  try {
    const name = basename(new URL(url).pathname);
    return name === '' ? 'artifact' : name;
  } catch {
    return 'artifact';
  }
};

const mutateLastByte = async (path: string): Promise<void> => {
  const handle = await open(path, 'r+');
  try {
    const stats = await handle.stat();
    if (stats.size === 0) {
      return;
    }
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, stats.size - 1);
    buffer[0] = (buffer[0] ?? 0) ^ 0xff;
    await handle.write(buffer, 0, 1, stats.size - 1);
  } finally {
    await handle.close();
  }
};

const lookedLikeNetworkFailure = (output: string): boolean =>
  /(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|network|socket hang up|registry)/i.test(
    output,
  );

export class RuntimePort implements ManagedRuntimePort {
  readonly #host: HostPlatform;
  readonly #fetch: FetchLike;
  readonly #faults: InstallFaults;
  readonly #urlRewrites: Readonly<Record<string, string>>;
  readonly #localArtifactDirectory: string | undefined;
  readonly #diskFreeBytes: FreeBytesProbe;
  readonly #limits: Required<RuntimeLimits>;
  readonly #closureInstall: boolean;
  readonly #precheck: 'managed' | 'none';
  readonly #npmRegistry: string | undefined;
  readonly #clock: () => Date;
  readonly #commandTimeoutMs: number;

  constructor(options: RuntimePortOptions = {}) {
    this.#host = options.host ?? { platform: 'darwin', arch: 'arm64' };
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#faults = options.faults ?? {};
    this.#urlRewrites = options.urlRewrites ?? {};
    this.#localArtifactDirectory = options.localArtifactDirectory;
    this.#diskFreeBytes = options.diskFreeBytes ?? defaultFreeBytes;
    this.#limits = {
      maxDownloadBytes: options.limits?.maxDownloadBytes ?? 512 * MIB,
      maxExtractedBytes: options.limits?.maxExtractedBytes ?? 2 * 1024 * MIB,
      minFreeBytes: options.limits?.minFreeBytes ?? 256 * MIB,
    };
    this.#closureInstall = options.closureInstall ?? true;
    this.#precheck = options.precheck ?? 'managed';
    this.#npmRegistry = options.npmRegistry;
    this.#clock = options.clock ?? (() => new Date());
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  }

  get host(): HostPlatform {
    return this.#host;
  }

  resolveComposition(combination: RuntimeCombination): PortOutcome<CompositionLock> {
    return resolveComposition(combination);
  }

  compositionDigest(lock: CompositionLock): string {
    return computeCompositionDigest(lock);
  }

  async install(
    lock: CompositionLock,
    destination: string,
    context: InstallContext,
  ): Promise<PortOutcome<InstalledRuntimeArtifacts>> {
    try {
      return successOutcome(await this.#install(lock, destination, context));
    } catch (error) {
      return toFailure(error);
    }
  }

  async #install(
    lock: CompositionLock,
    destination: string,
    context: InstallContext,
  ): Promise<InstalledRuntimeArtifacts> {
    if (this.#faults.forceDiskFull === true) {
      throw new InstallFailure('DISK_FULL', 'the disk is full (injected fault)');
    }
    mkdirSync(destination, { recursive: true });
    const homeDirectory = join(destination, 'home');
    mkdirSync(join(homeDirectory, '.tmp'), { recursive: true });
    mkdirSync(join(destination, '.tmp'), { recursive: true });

    context.onProgress?.({ phase: 'downloading', progress: 5 });
    const nodeArchive = await this.#obtainArchive(
      lock.sources.node.url,
      lock.node.sha256,
      context,
    );

    context.onProgress?.({ phase: 'extracting', progress: 30 });
    if (this.#faults.failExtraction === true) {
      throw new InstallFailure('INTERNAL_ERROR', 'artifact extraction failed (injected fault)');
    }
    const nodeDirectory = join(destination, NODE_DIRECTORY);
    await extractTarGz(nodeArchive, nodeDirectory, {
      stripComponents: 1,
      signal: context.signal,
      maxTotalBytes: this.#limits.maxExtractedBytes,
    });
    const nodeExecutable = join(nodeDirectory, 'bin', 'node');
    if (!existsSync(nodeExecutable)) {
      throw new InstallFailure('INTERNAL_ERROR', 'the Node artifact did not contain bin/node');
    }

    context.onProgress?.({ phase: 'downloading', progress: 45 });
    const dshArchive = await this.#obtainArchive(
      lock.sources.dsh.url,
      lock.dsh.sha256,
      context,
    );

    context.onProgress?.({ phase: 'extracting', progress: 60 });
    const referenceDirectory = join(destination, '.verify', 'dsh');
    await extractTarGz(dshArchive, referenceDirectory, {
      stripComponents: 1,
      signal: context.signal,
      maxTotalBytes: this.#limits.maxExtractedBytes,
    });
    const dshTreeDigest = await sha256TreeDigest(referenceDirectory);

    const dshDirectory = join(destination, DSH_DIRECTORY);
    const dshPackageDirectory = join(dshDirectory, ...DSH_PACKAGE_SEGMENTS);
    let closureMetadata: InstallManifest['closure'] = null;

    if (this.#closureInstall) {
      context.onProgress?.({ phase: 'installing-dependencies', progress: 70 });
      closureMetadata = await this.#installClosure(
        lock,
        dshArchive,
        destination,
        dshDirectory,
        homeDirectory,
        context,
      );
      const installedTreeDigest = await sha256TreeDigest(dshPackageDirectory);
      if (installedTreeDigest !== dshTreeDigest) {
        throw new InstallFailure(
          'DIGEST_MISMATCH',
          'the installed DSH package does not match the audited top-level artifact',
        );
      }
    } else {
      await extractTarGz(dshArchive, dshDirectory, {
        stripComponents: 1,
        prefix: DSH_PACKAGE_SEGMENTS.join('/'),
        signal: context.signal,
        maxTotalBytes: this.#limits.maxExtractedBytes,
      });
    }

    const dshEntrypoint = join(dshPackageDirectory, 'lib', 'bin.js');
    if (!existsSync(dshEntrypoint)) {
      throw new InstallFailure('INTERNAL_ERROR', 'the DSH artifact did not contain lib/bin.js');
    }

    context.onProgress?.({ phase: 'preflight', progress: 92 });
    const preflight = await this.#runPreflight(lock, destination, nodeExecutable, dshEntrypoint, homeDirectory, context);

    const installMode: InstallMode = this.#closureInstall ? 'npm-ci' : 'artifacts-only';
    const manifest: InstallManifest = {
      schemaVersion: '1',
      installMode,
      catalogRevision: CATALOG_REVISION,
      compositionDigest: computeCompositionDigest(lock),
      node: {
        version: lock.node.version,
        sha256: lock.node.sha256,
        executable: join(NODE_DIRECTORY, 'bin', 'node'),
      },
      dsh: {
        version: lock.dsh.version,
        sha256: lock.dsh.sha256,
        entrypoint: join(DSH_DIRECTORY, ...DSH_PACKAGE_SEGMENTS, 'lib', 'bin.js'),
        treeDigest: dshTreeDigest,
      },
      closure: closureMetadata,
      preflight,
      installedAt: this.#clock().toISOString(),
    };
    const manifestPath = join(destination, 'install-manifest.json');
    writeJsonFileSync(manifestPath, manifest);

    rmSync(join(destination, '.verify'), { recursive: true, force: true });
    context.onProgress?.({ phase: 'committing', progress: 98 });

    return { directory: destination, nodeExecutable, dshEntrypoint, manifestPath };
  }

  /** True when `cachePath` exists and hashes to the expected digest. */
  async #cacheIsValid(cachePath: string, sha256: string): Promise<boolean> {
    if (!existsSync(cachePath)) {
      return false;
    }
    try {
      return (await sha256File(cachePath)) === sha256;
    } catch {
      return false;
    }
  }

  /**
   * Publishes a verified private staging file to the content-addressed cache.
   *
   * Publish invariants (issue #37):
   * - the staging file is unique per attempt, so concurrent attempts never
   *   share a writable file;
   * - a valid cache entry is always reused and this attempt's staging discarded,
   *   so a concurrent winner is never clobbered;
   * - an invalid/corrupt existing entry is replaced atomically by `rename`, never
   *   read back in a partial state;
   * - `EEXIST`/`EPERM` (platforms that refuse rename-over-existing) and `ENOENT`
   *   races re-check the cache and either reuse the winner or retry once.
   */
  async #publishArchive(temporary: string, cachePath: string, sha256: string): Promise<void> {
    mkdirSync(dirname(cachePath), { recursive: true });
    if (await this.#cacheIsValid(cachePath, sha256)) {
      rmSync(temporary, { force: true });
      return;
    }
    try {
      renameSync(temporary, cachePath);
      return;
    } catch (error) {
      if (await this.#cacheIsValid(cachePath, sha256)) {
        rmSync(temporary, { force: true });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // The destination directory raced away; recreate and retry once.
        mkdirSync(dirname(cachePath), { recursive: true });
        renameSync(temporary, cachePath);
        return;
      }
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') {
        throw new InstallFailure(
          'INTERNAL_ERROR',
          'another attempt holds an unreadable artifact cache entry',
        );
      }
      throw new InstallFailure('INTERNAL_ERROR', 'the verified artifact could not be published to the cache');
    }
  }

  async #obtainArchive(url: string, sha256: string, context: InstallContext): Promise<string> {
    const cachePath = join(context.cacheDirectory, 'sha256', sha256, fileNameForUrl(url));
    if (await this.#cacheIsValid(cachePath, sha256)) {
      return cachePath;
    }
    if (this.#faults.forceDiskFull === true) {
      throw new InstallFailure('DISK_FULL', 'the disk is full (injected fault)');
    }
    mkdirSync(context.cacheDirectory, { recursive: true });
    const free = await this.#diskFreeBytes(context.cacheDirectory);
    if (free !== undefined && free < this.#limits.minFreeBytes) {
      throw new InstallFailure('DISK_FULL', 'not enough free disk space for the managed install');
    }

    const downloadDirectory = join(context.scratchDirectory, 'downloads');
    mkdirSync(downloadDirectory, { recursive: true });
    // Unique per attempt: concurrent creates of the same composition must never
    // share a writable staging file (issue #37).
    const temporary = join(downloadDirectory, `${sha256}.${randomUUID()}.part`);
    try {
      const local = this.#localArtifactDirectory === undefined
        ? undefined
        : findLocalArtifact(this.#localArtifactDirectory, sha256);
      if (local !== undefined) {
        copyFileSync(local, temporary);
      } else {
        const target = this.#urlRewrites[url] ?? url;
        await downloadToFile(target, temporary, {
          fetch: this.#fetch,
          signal: context.signal,
          maxBytes: this.#limits.maxDownloadBytes,
          ...(this.#faults.failDownloadAfterBytes === undefined
            ? {}
            : { failAfterBytes: this.#faults.failDownloadAfterBytes }),
        });
      }
      if (this.#faults.corruptDownload === true) {
        await mutateLastByte(temporary);
      }
      const actual = await sha256File(temporary);
      if (actual !== sha256) {
        throw new InstallFailure('DIGEST_MISMATCH', 'the downloaded artifact does not match the audited digest');
      }
      await this.#publishArchive(temporary, cachePath, sha256);
      return cachePath;
    } catch (error) {
      // Only this attempt's uniquely named staging file is removed; published
      // cache entries and other attempts' files are never touched.
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  async #installClosure(
    lock: CompositionLock,
    dshArchive: string,
    destination: string,
    dshDirectory: string,
    homeDirectory: string,
    context: InstallContext,
  ): Promise<NonNullable<InstallManifest['closure']>> {
    const closure = readDependencyClosure(lock.dsh.version);
    if (closure === undefined) {
      throw new InstallFailure(
        'INTERNAL_ERROR',
        `no audited dependency closure is recorded for DSH ${lock.dsh.version}`,
      );
    }
    if (closure.dshSha256 !== lock.dsh.sha256) {
      throw new InstallFailure('INTERNAL_ERROR', 'the dependency closure is bound to a different DSH artifact');
    }
    if (closure.rootResolved !== lock.sources.dsh.url) {
      throw new InstallFailure('INTERNAL_ERROR', 'the dependency closure resolves a different DSH tarball');
    }
    const archiveIntegrity = await sha512Integrity(dshArchive);
    if (archiveIntegrity !== closure.rootIntegritySha512) {
      throw new InstallFailure('DIGEST_MISMATCH', 'the audited DSH tarball does not match the dependency lock integrity');
    }

    mkdirSync(dshDirectory, { recursive: true });
    writeFileSync(join(dshDirectory, 'package.json'), closure.packageJson, 'utf8');
    writeFileSync(join(dshDirectory, 'package-lock.json'), closure.lockFile, 'utf8');
    const userConfig = join(dshDirectory, '.npmrc');
    writeFileSync(userConfig, '', 'utf8');
    const globalConfig = join(dshDirectory, '.npmrc-global');
    writeFileSync(globalConfig, '', 'utf8');
    const npmCache = context.npmCacheDirectory;
    mkdirSync(npmCache, { recursive: true });

    const nodeBin = join(destination, NODE_DIRECTORY, 'bin');
    const npmCli = join(destination, NODE_DIRECTORY, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmCli)) {
      throw new InstallFailure('INTERNAL_ERROR', 'the managed Node does not ship npm');
    }
    const environment = baseEnvironment(homeDirectory, nodeBin, npmCache, {
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_ignore_scripts: 'true',
      ...(this.#npmRegistry === undefined ? {} : { npm_config_registry: this.#npmRegistry }),
    });
    const result = await runCommand(
      join(nodeBin, 'node'),
      [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: dshDirectory, env: environment, timeoutMs: 15 * 60_000, signal: context.signal },
    );
    if (result.timedOut) {
      throw new InstallFailure('DOWNLOAD_FAILED', 'installing the DSH dependency closure timed out');
    }
    if (result.exitCode !== 0) {
      throw new InstallFailure(
        lookedLikeNetworkFailure(result.stderr) ? 'DOWNLOAD_FAILED' : 'INTERNAL_ERROR',
        `installing the DSH dependency closure failed with exit code ${String(result.exitCode)}`,
      );
    }
    const npmVersionResult = await runCommand(
      join(nodeBin, 'node'),
      [npmCli, '--version'],
      { cwd: dshDirectory, env: environment, timeoutMs: this.#commandTimeoutMs },
    );
    return {
      installed: true,
      lockSha256: closure.actualLockSha256,
      lockAsset: join('catalog', `dsh-${lock.dsh.version}`, 'package-lock.json'),
      packageCount: closure.packageCount,
      rootIntegritySha512: closure.rootIntegritySha512,
      npmVersion: npmVersionResult.stdout.trim(),
      nodeVersion: lock.node.version,
    };
  }

  async #runPreflight(
    lock: CompositionLock,
    destination: string,
    nodeExecutable: string,
    dshEntrypoint: string,
    homeDirectory: string,
    context: InstallContext,
  ): Promise<InstallManifest['preflight']> {
    if (this.#precheck === 'none') {
      return { skipped: true, passed: false, checks: [], reason: 'preflight disabled by runtime options' };
    }
    const nodeBin = join(destination, NODE_DIRECTORY, 'bin');
    const environment = baseEnvironment(homeDirectory, nodeBin, context.npmCacheDirectory);
    const dshEnvironment = baseEnvironment(homeDirectory, nodeBin, context.npmCacheDirectory);
    const checks: InstallCheck[] = [];

    const nodeVersion = await runCommand(nodeExecutable, ['--version'], {
      cwd: destination,
      env: environment,
      timeoutMs: this.#commandTimeoutMs,
      signal: context.signal,
    });
    const expectedNode = `v${lock.node.version}`;
    if (nodeVersion.exitCode !== 0 || nodeVersion.stdout.trim() !== expectedNode) {
      throw new InstallFailure('INTERNAL_ERROR', `the managed Node reported ${nodeVersion.stdout.trim() || 'no version'}`);
    }
    checks.push({ name: 'node --version', exitCode: nodeVersion.exitCode, stdout: nodeVersion.stdout.trim() });

    const dshVersion = await runCommand(nodeExecutable, [dshEntrypoint, '--version'], {
      cwd: dirname(dshEntrypoint),
      env: dshEnvironment,
      timeoutMs: this.#commandTimeoutMs,
      signal: context.signal,
    });
    if (dshVersion.exitCode !== 0 || dshVersion.stdout.trim() !== lock.dsh.version) {
      throw new InstallFailure('INTERNAL_ERROR', `the managed DSH reported ${dshVersion.stdout.trim() || 'no version'}`);
    }
    checks.push({ name: 'dsh --version', exitCode: dshVersion.exitCode, stdout: dshVersion.stdout.trim() });

    const dshHelp = await runCommand(nodeExecutable, [dshEntrypoint, '--help'], {
      cwd: dirname(dshEntrypoint),
      env: dshEnvironment,
      timeoutMs: this.#commandTimeoutMs,
      signal: context.signal,
    });
    if (dshHelp.exitCode !== 0) {
      throw new InstallFailure('INTERNAL_ERROR', 'the managed DSH did not answer --help');
    }
    checks.push({ name: 'dsh --help', exitCode: dshHelp.exitCode, stdout: 'ok' });

    return { skipped: false, passed: true, checks };
  }
}

export const createRuntimePort = (options: RuntimePortOptions = {}): RuntimePort =>
  new RuntimePort(options);
