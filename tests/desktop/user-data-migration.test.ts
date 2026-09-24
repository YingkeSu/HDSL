/**
 * Legacy `userData` compatibility (issue #149).
 *
 * Renaming the app from the scoped `@hdsl/desktop` to `HDSL` moves Electron's
 * default `userData` directory. These checks pin the migration plan: a populated
 * legacy directory is moved, a `--user-data-dir` override is never touched, two
 * populated profiles are never merged, and a failed move falls back to the
 * legacy directory instead of dropping data.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultUserDataDirectory,
  formatUserDataSignal,
  legacyUserDataDirectory,
  resolveUserDataDirectory,
  type DirectoryState,
  type UserDataFileSystem,
} from '../../apps/desktop/src/main/user-data.js';

const APP_DATA = '/home/tester/.config';

const fakeFileSystem = (
  initial: Readonly<Record<string, DirectoryState>>,
): {
  readonly fileSystem: UserDataFileSystem;
  readonly calls: string[];
  readonly state: Map<string, DirectoryState>;
} => {
  const state = new Map(Object.entries(initial));
  const calls: string[] = [];
  return {
    calls,
    state,
    fileSystem: {
      stateOf: (directory) => state.get(directory) ?? 'absent',
      removeEmptyDirectory: (directory) => {
        calls.push(`rmdir:${directory}`);
        state.delete(directory);
      },
      rename: (from, to) => {
        calls.push(`rename:${from}->${to}`);
        state.delete(from);
        state.set(to, 'populated');
      },
    },
  };
};

describe('userData directory naming (issue #149)', () => {
  it('derives the default target from the product name', () => {
    expect(defaultUserDataDirectory(APP_DATA)).toBe(`${APP_DATA}/HDSL`);
  });

  it('reproduces the nested directory the scoped npm name created', () => {
    expect(legacyUserDataDirectory(APP_DATA)).toBe(`${APP_DATA}/@hdsl/desktop`);
  });
});

describe('userData migration plan (issue #149)', () => {
  const target = defaultUserDataDirectory(APP_DATA);
  const legacy = legacyUserDataDirectory(APP_DATA);

  it('leaves an explicit --user-data-dir override untouched', () => {
    const override = '/tmp/hdsl-smoke-userdata';
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      // A real legacy directory may exist, but the operator chose this profile.
      userDataDirectory: override,
      fileSystem: {
        stateOf: () => {
          throw new Error('the migration must not inspect any directory for an override');
        },
        removeEmptyDirectory: () => {
          throw new Error('the migration must not move anything for an override');
        },
        rename: () => {
          throw new Error('the migration must not move anything for an override');
        },
      },
    });
    expect(resolution).toEqual({ directory: override, migrated: false });
  });

  it('keeps the target when no legacy directory exists', () => {
    const fake = fakeFileSystem({ [target]: 'absent' });
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      fileSystem: fake.fileSystem,
    });
    expect(resolution).toEqual({ directory: target, migrated: false });
    expect(fake.calls).toEqual([]);
  });

  it('ignores an empty legacy directory', () => {
    const fake = fakeFileSystem({ [legacy]: 'empty', [target]: 'empty' });
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      fileSystem: fake.fileSystem,
    });
    expect(resolution).toEqual({ directory: target, migrated: false });
    expect(fake.calls).toEqual([]);
  });

  it('moves a populated legacy directory over the absent target', () => {
    const fake = fakeFileSystem({ [legacy]: 'populated', [target]: 'absent' });
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      fileSystem: fake.fileSystem,
    });
    expect(resolution).toEqual({ directory: target, migrated: true });
    expect(fake.calls).toEqual([`rename:${legacy}->${target}`]);
    expect(fake.state.get(legacy)).toBeUndefined();
    expect(fake.state.get(target)).toBe('populated');
  });

  it('removes the empty default directory Electron pre-created before renaming', () => {
    // Electron creates `appData/HDSL` before the main script runs, and Windows
    // cannot rename over an existing directory, so the empty shell goes first.
    const fake = fakeFileSystem({ [legacy]: 'populated', [target]: 'empty' });
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      fileSystem: fake.fileSystem,
    });
    expect(resolution).toEqual({ directory: target, migrated: true });
    expect(fake.calls).toEqual([`rmdir:${target}`, `rename:${legacy}->${target}`]);
  });

  it('keeps the target and reports the retained legacy profile when both are populated', () => {
    const fake = fakeFileSystem({ [legacy]: 'populated', [target]: 'populated' });
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      fileSystem: fake.fileSystem,
    });
    expect(resolution).toEqual({
      directory: target,
      migrated: false,
      note: 'legacy-retained',
    });
    expect(fake.calls).toEqual([]);
  });

  it('falls back to the legacy directory when the move fails', () => {
    const fake = fakeFileSystem({ [legacy]: 'populated', [target]: 'absent' });
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      fileSystem: {
        ...fake.fileSystem,
        rename: () => {
          throw new Error('EPERM');
        },
      },
    });
    expect(resolution).toEqual({
      directory: legacy,
      migrated: false,
      note: 'migration-failed',
    });
    // The data is still in the legacy directory, nothing was deleted.
    expect(fake.state.get(legacy)).toBe('populated');
  });
});

describe('userData fallback signal (issue #149)', () => {
  it('is a single fixed, path-free line per reason', () => {
    expect(formatUserDataSignal('legacy-retained')).toBe('[hdsl] user-data legacy-retained\n');
    expect(formatUserDataSignal('migration-failed')).toBe('[hdsl] user-data migration-failed\n');
  });
});

/**
 * Real-filesystem check of the effect the plan describes. It uses a disposable
 * app-data root so it never reads or moves a developer's real legacy profile.
 */
describe('userData migration effect (real filesystem, issue #149)', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const directory of temporary.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const appData = (): string => {
    const base = mkdtempSync(join(tmpdir(), 'hdsl-userdata-'));
    temporary.push(base);
    return base;
  };

  it('moves a populated legacy profile into the new default directory', () => {
    const base = appData();
    const legacy = legacyUserDataDirectory(base);
    const target = defaultUserDataDirectory(base);
    mkdirSync(legacy, { recursive: true });
    // Electron pre-creates the default directory before the main script runs.
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'environment.json'), '{"id":"env-1"}\n');

    const resolution = resolveUserDataDirectory({
      appDataDirectory: base,
      userDataDirectory: target,
    });

    expect(resolution).toEqual({ directory: target, migrated: true });
    expect(readFileSync(join(target, 'environment.json'), 'utf8')).toBe('{"id":"env-1"}\n');
  });

  it('keeps two existing profiles separate instead of merging them', () => {
    const base = appData();
    const legacy = legacyUserDataDirectory(base);
    const target = defaultUserDataDirectory(base);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'environment.json'), '{"id":"env-1"}\n');
    // A populated target is the realistic shape once the new build has already
    // been started once; the legacy profile must stay readable, not be merged.
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SingletonLock'), '');

    const resolution = resolveUserDataDirectory({
      appDataDirectory: base,
      userDataDirectory: target,
    });

    expect(resolution).toEqual({
      directory: target,
      migrated: false,
      note: 'legacy-retained',
    });
    expect(readFileSync(join(legacy, 'environment.json'), 'utf8')).toBe('{"id":"env-1"}\n');
  });
});
