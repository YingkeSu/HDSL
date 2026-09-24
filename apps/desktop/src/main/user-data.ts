/**
 * Legacy `userData` compatibility for the desktop shell (issue #149).
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
 * - when both directories hold data it keeps the target and reports the
 *   retained legacy directory instead of merging two profiles;
 * - when the move fails it falls back to the legacy directory and reports the
 *   failure, so data is never lost even without write permission on the parent.
 */
import { readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from './product-identity.js';

export type DirectoryState = 'absent' | 'empty' | 'populated';

/** Narrow filesystem seam so the migration plan is testable without real dirs. */
export interface UserDataFileSystem {
  stateOf(directory: string): DirectoryState;
  removeEmptyDirectory(directory: string): void;
  rename(from: string, to: string): void;
}

/** Directory Electron created for the scoped package name `@hdsl/desktop`. */
export const legacyUserDataDirectory = (appDataDirectory: string): string =>
  resolve(join(appDataDirectory, ...LEGACY_PRODUCT_NAME.split('/')));

/** Default Electron `userData` directory for the current product name. */
export const defaultUserDataDirectory = (appDataDirectory: string): string =>
  resolve(join(appDataDirectory, PRODUCT_NAME));

/** Reasons the resolved directory is not the plain target path. */
export type UserDataNote = 'legacy-retained' | 'migration-failed';

export interface UserDataResolution {
  /** Directory main must use as `userData`. */
  readonly directory: string;
  /** True only when the legacy directory was moved to the target path. */
  readonly migrated: boolean;
  /** Present when the legacy directory was not moved. */
  readonly note?: UserDataNote;
}

export const USER_DATA_SIGNAL = '[hdsl] user-data';

/** One fixed, path-free stderr line so a fallback is attributable. */
export const formatUserDataSignal = (note: UserDataNote): string =>
  `${USER_DATA_SIGNAL} ${note}\n`;

const stateOf = (directory: string): DirectoryState => {
  try {
    return readdirSync(directory).length === 0 ? 'empty' : 'populated';
  } catch {
    return 'absent';
  }
};

export const nativeUserDataFileSystem: UserDataFileSystem = {
  stateOf,
  removeEmptyDirectory: (directory) => {
    rmdirSync(directory);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
};

export interface ResolveUserDataInput {
  readonly appDataDirectory: string;
  readonly userDataDirectory: string;
  /** Test seam; defaults to the real filesystem. */
  readonly fileSystem?: UserDataFileSystem;
}

/**
 * Resolves the `userData` directory to use and moves a populated legacy
 * directory when — and only when — Electron's default path is in effect.
 */
export const resolveUserDataDirectory = (input: ResolveUserDataInput): UserDataResolution => {
  const fileSystem = input.fileSystem ?? nativeUserDataFileSystem;
  const target = defaultUserDataDirectory(input.appDataDirectory);
  // An explicit `--user-data-dir` (or a prior `setPath`) is not the default
  // path, so the migration is skipped entirely and no legacy directory is
  // inspected or moved.
  if (resolve(input.userDataDirectory) !== target) {
    return { directory: input.userDataDirectory, migrated: false };
  }
  const legacy = legacyUserDataDirectory(input.appDataDirectory);
  if (fileSystem.stateOf(legacy) !== 'populated') {
    return { directory: target, migrated: false };
  }
  const targetState = fileSystem.stateOf(target);
  if (targetState === 'populated') {
    // Two profiles exist. Keeping the target is the only choice that neither
    // merges nor deletes user data; the legacy directory stays on disk and the
    // fixed note makes the decision observable.
    return { directory: target, migrated: false, note: 'legacy-retained' };
  }
  try {
    // Electron creates the default directory before the main script runs; it is
    // empty at that point. POSIX rename can replace an empty directory, but
    // Windows `MoveFile` cannot, so remove it first.
    if (targetState === 'empty') {
      fileSystem.removeEmptyDirectory(target);
    }
    fileSystem.rename(legacy, target);
    return { directory: target, migrated: true };
  } catch {
    return { directory: legacy, migrated: false, note: 'migration-failed' };
  }
};
