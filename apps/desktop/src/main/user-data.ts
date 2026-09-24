/**
 * Legacy `userData` compatibility and isolated-profile bootstrap (issue #149).
 *
 * Before the product name existed, Electron used the scoped npm name
 * `@hdsl/desktop` as the application name and therefore created the Chromium
 * profile — and, by default, the HDSL data root — under
 * `appData/@hdsl/desktop`. Renaming the app to `HDSL` moves that directory to
 * `appData/HDSL`. A rename must not silently abandon an existing preview
 * profile, so main moves a populated legacy directory into the new location
 * before Electron uses it.
 *
 * Boundaries the migration keeps:
 * - it looks only at those two fixed directories and never reads file contents,
 *   so no user data leaves the profile and nothing is merged;
 * - it runs only while `userData` is still the default `appData/<product name>`
 *   path. A `--user-data-dir` / `app.setPath` override is an explicit operator
 *   choice, so a temporary profile never reads a real user's legacy directory;
 * - an explicit `--hdsl-data-root` / `HDSL_DATA_ROOT` run is isolated by intent:
 *   `applyUserDataBootstrap` redirects the Electron profile under that root
 *   *before the first* `getPath('userData')` access, so the real default profile
 *   is never created, read or migrated (`getPath('userData')` is what creates
 *   the directory — verified on Electron 44);
 * - a filesystem error other than `ENOENT` is not treated as "absent": the
 *   directory is preserved and reported instead of silently skipped;
 * - a symlinked legacy/target directory is never moved or replaced, so a
 *   migration cannot escape `appData` or follow an unexpected link;
 * - the decision is taken under an atomically-created lock file with a live
 *   owner probe, and a profile that a running process still owns is never
 *   renamed. When the lock is held or the profile is in use, the legacy
 *   directory is preserved and the outcome is reported instead of risking a
 *   rename;
 * - when both directories hold data it keeps the target and reports the
 *   retained legacy directory instead of merging two profiles;
 * - when the move fails it falls back to the legacy directory and reports the
 *   failure, so data is never lost even without write permission on the parent.
 */
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { explicitDataRoot } from './data-root.js';
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from './product-identity.js';

/**
 * `appData/@hdsl/desktop` shape. `stateOf` distinguishes a missing directory
 * (`ENOENT`, safe to treat as absent) from one that exists but cannot be read
 * (`EACCES`/`EPERM`/I/O errors), which must fail closed instead of being
 * silently skipped.
 */
export type DirectoryState = 'absent' | 'empty' | 'populated' | 'unreadable';

/** Narrow filesystem seam so the migration plan is testable without real dirs. */
export interface UserDataFileSystem {
  stateOf(directory: string): DirectoryState;
  /** True when the path itself is a symbolic link (never followed). */
  isSymbolicLink(path: string): boolean;
  /** Chromium `SingletonLock` link target, or `undefined` when absent/unreadable. */
  singletonLockTarget(directory: string): string | undefined;
  /** Atomic exclusive create; returns false when the lock already exists. */
  createLockFile(path: string, owner: string): boolean;
  /** Best-effort lock removal; a missing lock is a no-op. */
  removeLockFile(path: string): void;
  /** Lock owner marker (`<hostname>-<pid>`), or `undefined` when unreadable. */
  readLockFile(path: string): string | undefined;
  removeEmptyDirectory(directory: string): void;
  rename(from: string, to: string): void;
}

/** Directory Electron created for the scoped package name `@hdsl/desktop`. */
export const legacyUserDataDirectory = (appDataDirectory: string): string =>
  resolve(join(appDataDirectory, ...LEGACY_PRODUCT_NAME.split('/')));

/** Scoped parent Electron created for `@hdsl/desktop`. */
export const legacyScopeDirectory = (appDataDirectory: string): string =>
  resolve(join(appDataDirectory, LEGACY_PRODUCT_NAME.split('/')[0] ?? LEGACY_PRODUCT_NAME));

/** Default Electron `userData` directory for the current product name. */
export const defaultUserDataDirectory = (appDataDirectory: string): string =>
  resolve(join(appDataDirectory, PRODUCT_NAME));

/** Profile directory used under an explicit `--hdsl-data-root`/`HDSL_DATA_ROOT`. */
export const ISOLATED_PROFILE_DIRECTORY = 'electron-profile';

/** Chromium command-line switch that pins the profile directory. */
export const USER_DATA_DIR_SWITCH = '--user-data-dir';

/** Lock file that serializes the one-time legacy migration. */
export const MIGRATION_LOCK_FILE = '.hdsl-userdata-migration.lock';

/**
 * Reasons the resolved directory is not the plain target path. Every reason is
 * an enumerated literal, so the stderr signal can never leak a path or an
 * exception message.
 */
export type UserDataNote =
  | 'legacy-retained'
  | 'legacy-unreadable'
  | 'legacy-symlink'
  | 'legacy-in-use'
  | 'migration-busy'
  | 'target-unreadable'
  | 'target-symlink'
  | 'migration-failed';

export interface UserDataResolution {
  /** Directory main must use as `userData`. */
  readonly directory: string;
  /** True only when the legacy directory was moved to the target path. */
  readonly migrated: boolean;
  /** Present when the legacy directory was not moved. */
  readonly note?: UserDataNote | undefined;
}

export const USER_DATA_SIGNAL = '[hdsl] user-data';

/** One fixed, path-free stderr line so a fallback is attributable. */
export const formatUserDataSignal = (note: UserDataNote): string =>
  `${USER_DATA_SIGNAL} ${note}\n`;

export const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

const stateOf = (directory: string): DirectoryState => {
  try {
    return readdirSync(directory).length === 0 ? 'empty' : 'populated';
  } catch (error) {
    // Only a missing directory is "absent". Anything else (EACCES/EPERM/I/O)
    // means the directory may exist and hold data, so it must fail closed.
    return isEnoent(error) ? 'absent' : 'unreadable';
  }
};

const isSymbolicLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const singletonLockTarget = (directory: string): string | undefined => {
  try {
    return readlinkSync(join(directory, 'SingletonLock'));
  } catch {
    return undefined;
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; any other
    // errno (ESRCH) means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const nativeUserDataFileSystem: UserDataFileSystem = {
  stateOf,
  isSymbolicLink,
  singletonLockTarget,
  createLockFile: (path, owner) => {
    try {
      writeFileSync(path, owner, { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  },
  removeLockFile: (path) => {
    try {
      unlinkSync(path);
    } catch {
      // A missing lock is already the desired state.
    }
  },
  readLockFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  removeEmptyDirectory: (directory) => {
    rmdirSync(directory);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
};

export interface LockOwnerInput {
  readonly owner: string | undefined;
  readonly hostname: string;
  readonly isProcessAlive: (pid: number) => boolean;
}

/**
 * True when a lock/`SingletonLock` marker of the form `<hostname>-<pid>`
 * belongs to a live process on this host. A different hostname or an
 * unparseable marker is treated as stale, so a copied or crashed profile can be
 * reclaimed instead of blocking forever.
 */
export const isLiveLockOwner = (input: LockOwnerInput): boolean => {
  const owner = input.owner;
  if (owner === undefined || owner === '') {
    return false;
  }
  const separator = owner.lastIndexOf('-');
  if (separator <= 0 || separator === owner.length - 1) {
    return false;
  }
  if (owner.slice(0, separator) !== input.hostname) {
    return false;
  }
  const pid = Number(owner.slice(separator + 1));
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return input.isProcessAlive(pid);
};

export interface ResolveUserDataInput {
  readonly appDataDirectory: string;
  readonly userDataDirectory: string;
  /** Test seam; defaults to the real filesystem. */
  readonly fileSystem?: UserDataFileSystem | undefined;
  /** Test seam; defaults to `os.hostname()`. */
  readonly hostname?: string | undefined;
  /** Test seam; defaults to a `process.kill(pid, 0)` liveness probe. */
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
  /** Test seam; defaults to `process.pid`. */
  readonly pid?: number | undefined;
}

interface MigrationContext {
  readonly fileSystem: UserDataFileSystem;
  readonly hostname: string;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly pid: number;
}

const acquireMigrationLock = (
  appDataDirectory: string,
  context: MigrationContext,
): string | undefined => {
  const path = join(appDataDirectory, MIGRATION_LOCK_FILE);
  const owner = `${context.hostname}-${String(context.pid)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (context.fileSystem.createLockFile(path, owner)) {
      return path;
    }
    if (
      isLiveLockOwner({
        owner: context.fileSystem.readLockFile(path),
        hostname: context.hostname,
        isProcessAlive: context.isProcessAlive,
      })
    ) {
      // A live launcher owns the lock; never rename under it.
      return undefined;
    }
    // Stale, empty or unreadable marker: clear it and retry once.
    context.fileSystem.removeLockFile(path);
  }
  return undefined;
};

/**
 * Resolves the `userData` directory to use and moves a populated legacy
 * directory when — and only when — Electron's default path is in effect.
 */
export const resolveUserDataDirectory = (input: ResolveUserDataInput): UserDataResolution => {
  const fileSystem = input.fileSystem ?? nativeUserDataFileSystem;
  const context: MigrationContext = {
    fileSystem,
    hostname: input.hostname ?? hostname(),
    isProcessAlive: input.isProcessAlive ?? processIsAlive,
    pid: input.pid ?? process.pid,
  };
  const target = defaultUserDataDirectory(input.appDataDirectory);
  // An explicit `--user-data-dir` (or a prior `setPath`) is not the default
  // path, so the migration is skipped entirely and no legacy directory is
  // inspected or moved.
  if (resolve(input.userDataDirectory) !== target) {
    return { directory: input.userDataDirectory, migrated: false };
  }
  const legacy = legacyUserDataDirectory(input.appDataDirectory);
  const legacyState = fileSystem.stateOf(legacy);
  if (legacyState === 'absent' || legacyState === 'empty') {
    return { directory: target, migrated: false };
  }
  if (legacyState === 'unreadable') {
    // The directory may hold data but cannot be inspected. Preserve it and
    // report instead of treating it as absent and quietly starting fresh.
    return { directory: legacy, migrated: false, note: 'legacy-unreadable' };
  }
  // A symlinked legacy directory must not be moved: renaming would relocate the
  // link (or read data outside `appData`), so keep it in place and report.
  if (
    fileSystem.isSymbolicLink(legacyScopeDirectory(input.appDataDirectory)) ||
    fileSystem.isSymbolicLink(legacy)
  ) {
    return { directory: legacy, migrated: false, note: 'legacy-symlink' };
  }
  if (
    isLiveLockOwner({
      owner: fileSystem.singletonLockTarget(legacy),
      hostname: context.hostname,
      isProcessAlive: context.isProcessAlive,
    })
  ) {
    // Another instance still owns this profile; renaming it would disrupt a
    // live process. Use the legacy directory so the single-instance lock can
    // refuse the concurrent start instead.
    return { directory: legacy, migrated: false, note: 'legacy-in-use' };
  }
  if (fileSystem.isSymbolicLink(target)) {
    return { directory: target, migrated: false, note: 'target-symlink' };
  }
  const targetState = fileSystem.stateOf(target);
  if (targetState === 'unreadable') {
    return { directory: target, migrated: false, note: 'target-unreadable' };
  }
  if (targetState === 'populated') {
    // Two profiles exist. Keeping the target is the only choice that neither
    // merges nor deletes user data; the legacy directory stays on disk and the
    // fixed note makes the decision observable.
    return { directory: target, migrated: false, note: 'legacy-retained' };
  }
  const lockPath = acquireMigrationLock(input.appDataDirectory, context);
  if (lockPath === undefined) {
    // Another launcher is migrating (or holds the lock). Both keep the target
    // path, so Electron's single-instance lock serializes them; the legacy
    // directory is left untouched rather than renamed under the other process.
    return { directory: target, migrated: false, note: 'migration-busy' };
  }
  try {
    // Re-read under the lock: the competing launcher may have finished.
    if (fileSystem.stateOf(legacy) !== 'populated') {
      return { directory: target, migrated: false };
    }
    const latestTarget = fileSystem.stateOf(target);
    if (latestTarget !== 'empty' && latestTarget !== 'absent') {
      return { directory: target, migrated: false };
    }
    // Electron creates the default directory before the main script runs; it is
    // empty at that point. POSIX rename can replace an empty directory, but
    // Windows `MoveFile` cannot, so remove it first.
    if (latestTarget === 'empty') {
      fileSystem.removeEmptyDirectory(target);
    }
    fileSystem.rename(legacy, target);
    return { directory: target, migrated: true };
  } catch {
    return { directory: legacy, migrated: false, note: 'migration-failed' };
  } finally {
    fileSystem.removeLockFile(lockPath);
  }
};

/**
 * Minimal Electron path surface used by the bootstrap. Electron's `app`
 * satisfies it: `setPath` must run before the first `getPath('userData')`
 * because that access creates the directory.
 */
export interface UserDataPathHost {
  getPath(name: string): string;
  setPath(name: string, path: string): void;
}

/** Chromium's `--user-data-dir=<path>` value, or `undefined` when not pinned. */
export const chromiumUserDataDirectory = (argv: readonly string[]): string | undefined => {
  const prefix = `${USER_DATA_DIR_SWITCH}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument.startsWith(prefix)) {
      const value = argument.slice(prefix.length);
      return value === '' ? undefined : value;
    }
    if (argument === USER_DATA_DIR_SWITCH) {
      const value = argv[index + 1];
      return value !== undefined && value.trim() !== '' && !value.startsWith('--')
        ? value
        : undefined;
    }
  }
  return undefined;
};

export interface IsolatedUserDataInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Profile directory for an explicitly isolated run, or `undefined` for a normal
 * launch. When the operator already pinned `--user-data-dir`, that choice wins
 * and nothing is derived from the data root.
 */
export const isolatedUserDataDirectory = (input: IsolatedUserDataInput): string | undefined => {
  const dataRoot = explicitDataRoot({ argv: input.argv, env: input.env });
  if (dataRoot === undefined) {
    return undefined;
  }
  if (chromiumUserDataDirectory(input.argv) !== undefined) {
    return undefined;
  }
  return resolve(join(resolve(dataRoot), ISOLATED_PROFILE_DIRECTORY));
};

export interface UserDataBootstrapInput extends IsolatedUserDataInput {
  readonly appDataDirectory: string;
  readonly fileSystem?: UserDataFileSystem | undefined;
  readonly hostname?: string | undefined;
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
  readonly pid?: number | undefined;
  readonly onNote?: ((note: UserDataNote) => void) | undefined;
}

export interface UserDataBootstrapOutcome {
  /** Electron path in effect after the bootstrap. */
  readonly directory: string;
  /** True when the profile was redirected for an isolated run. */
  readonly isolated: boolean;
  readonly migrated: boolean;
  readonly note?: UserDataNote | undefined;
}

/**
 * Applies the profile decision before any other side effect.
 *
 * An explicit data-root override redirects `userData` under that root before
 * the first `getPath('userData')` call, so an isolated run never creates, reads
 * or migrates the real default profile. Otherwise the default path is resolved
 * and a populated legacy profile is migrated according to
 * {@link resolveUserDataDirectory}.
 */
export const applyUserDataBootstrap = (
  host: UserDataPathHost,
  input: UserDataBootstrapInput,
): UserDataBootstrapOutcome => {
  const isolated = isolatedUserDataDirectory(input);
  if (isolated !== undefined) {
    host.setPath('userData', isolated);
    return { directory: isolated, isolated: true, migrated: false };
  }
  const userData = host.getPath('userData');
  const resolution = resolveUserDataDirectory({
    appDataDirectory: input.appDataDirectory,
    userDataDirectory: userData,
    fileSystem: input.fileSystem,
    hostname: input.hostname,
    isProcessAlive: input.isProcessAlive,
    pid: input.pid,
  });
  if (resolution.directory !== userData) {
    host.setPath('userData', resolution.directory);
  }
  if (resolution.note !== undefined) {
    input.onNote?.(resolution.note);
  }
  return {
    directory: resolution.directory,
    isolated: false,
    migrated: resolution.migrated,
    note: resolution.note,
  };
};
