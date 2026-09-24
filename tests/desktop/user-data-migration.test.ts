/**
 * Legacy `userData` compatibility, isolated-profile bootstrap and migration
 * safety (issue #149).
 *
 * Renaming the app from the scoped `@hdsl/desktop` to `HDSL` moves Electron's
 * default `userData` directory. These checks pin the safety envelope:
 * - an explicit `--hdsl-data-root`/`HDSL_DATA_ROOT` run redirects the profile
 *   before the first `getPath('userData')` and never touches the real default;
 * - `ENOENT` is "absent" but any other filesystem error preserves the directory
 *   and reports it instead of silently starting fresh;
 * - symlinked directories are never moved;
 * - a profile a live process owns, or a lock held by another launcher, is never
 *   renamed;
 * - two populated profiles are never merged, and a failed move falls back to
 *   the legacy directory instead of dropping data.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyUserDataBootstrap,
  configureUserData,
  defaultUserDataDirectory,
  formatLaunchArgumentSignal,
  formatUserDataSignal,
  isolatedUserDataDirectory,
  isLiveLockOwner,
  ISOLATED_PROFILE_DIRECTORY,
  LAUNCH_ARGUMENT_SIGNAL,
  launchArgumentProblem,
  legacyScopeDirectory,
  legacyUserDataDirectory,
  MIGRATION_LOCK_FILE,
  resolveUserDataDirectory,
  spaceSeparatedUserDataDirectory,
  USER_DATA_DIR_SWITCH,
  userDataDirProblem,
  chromiumUserDataDirectory,
  type DirectoryState,
  type UserDataFileSystem,
  type UserDataNote,
} from '../../apps/desktop/src/main/user-data.js';
import {
  dataRootOverrideProblem,
  explicitDataRoot,
  resolveDataRoot,
} from '../../apps/desktop/src/main/data-root.js';

const HOST = 'test-host';
const APP_DATA = '/tmp/appdata';
type Present = Exclude<DirectoryState, 'absent'>;
type Pair = readonly [string, Present];
type OwnerPair = readonly [string, string];

interface FakeInitial {
  readonly dirs?: readonly Pair[];
  readonly symlinks?: readonly string[];
  readonly singletonLocks?: readonly OwnerPair[];
  readonly lockFiles?: readonly OwnerPair[];
}

const fakeFileSystem = (initial: FakeInitial = {}) => {
  const dirs = new Map<string, Present>(initial.dirs ?? []);
  const symlinks = new Set<string>(initial.symlinks ?? []);
  const singletonLocks = new Map<string, string>(initial.singletonLocks ?? []);
  const lockFiles = new Map<string, string>(initial.lockFiles ?? []);
  const calls: string[] = [];
  const fileSystem: UserDataFileSystem = {
    stateOf: (directory) => dirs.get(directory) ?? 'absent',
    isSymbolicLink: (path) => symlinks.has(path),
    singletonLockTarget: (directory) => singletonLocks.get(directory),
    createLockFile: (path, owner) => {
      calls.push(`lock:${path}`);
      if (lockFiles.has(path)) {
        return false;
      }
      lockFiles.set(path, owner);
      return true;
    },
    removeLockFile: (path) => {
      calls.push(`unlock:${path}`);
      lockFiles.delete(path);
    },
    readLockFile: (path) => lockFiles.get(path),
    removeEmptyDirectory: (directory) => {
      calls.push(`rmdir:${directory}`);
      dirs.delete(directory);
    },
    rename: (from, to) => {
      calls.push(`rename:${from}->${to}`);
      const entry = dirs.get(from);
      if (entry === undefined) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      dirs.delete(from);
      dirs.set(to, entry);
    },
  };
  return { fileSystem, calls, dirs, lockFiles };
};

/**
 * Records every `getPath('userData')` (which is what creates the directory) so a
 * negative control can prove a rejected launch never touched the profile.
 */
const recordingHost = (appData: string, defaultPath: string) => {
  const userDataAccesses: string[] = [];
  const setPaths: string[] = [];
  let current: string | undefined;
  return {
    userDataAccesses,
    setPaths,
    host: {
      getPath(name: string): string {
        if (name === 'appData') {
          return appData;
        }
        if (name === 'userData') {
          const path = current ?? defaultPath;
          userDataAccesses.push(path);
          return path;
        }
        throw new Error(`unexpected getPath: ${name}`);
      },
      setPath(name: string, path: string): void {
        setPaths.push(`${name}=${path}`);
        current = path;
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
    expect(legacyScopeDirectory(APP_DATA)).toBe(`${APP_DATA}/@hdsl`);
  });
});

describe('explicit data-root detection (issue #149)', () => {
  it('detects the space form, the equals form and the environment value', () => {
    expect(explicitDataRoot({ argv: ['electron', '--hdsl-data-root', '/tmp/root'], env: {} })).toBe(
      '/tmp/root',
    );
    expect(explicitDataRoot({ argv: ['electron', '--hdsl-data-root=/tmp/equals'], env: {} })).toBe(
      '/tmp/equals',
    );
    expect(explicitDataRoot({ argv: ['electron'], env: { HDSL_DATA_ROOT: '/tmp/env' } })).toBe(
      '/tmp/env',
    );
  });

  it('resolves valid duplicates with positional first-wins', () => {
    expect(
      explicitDataRoot({ argv: ['--hdsl-data-root', '/first', '--hdsl-data-root', '/second'], env: {} }),
    ).toBe('/first');
    expect(
      explicitDataRoot({ argv: ['--hdsl-data-root=/one', '--hdsl-data-root=/two'], env: {} }),
    ).toBe('/one');
    expect(
      explicitDataRoot({ argv: ['--hdsl-data-root=/flag'], env: { HDSL_DATA_ROOT: '/env' } }),
    ).toBe('/flag');
  });

  it('reports every present-but-invalid override instead of falling back', () => {
    const invalid: ReadonlyArray<[string[], Record<string, string | undefined>, string]> = [
      [['electron', '--hdsl-data-root'], {}, 'missing-value'],
      [['electron', '--hdsl-data-root='], {}, 'empty-value'],
      [['electron', '--hdsl-data-root', ''], {}, 'missing-value'],
      [['electron', '--hdsl-data-root', '--enable-logging'], {}, 'switch-value'],
      [['electron'], { HDSL_DATA_ROOT: '' }, 'empty-value'],
      [['electron'], { HDSL_DATA_ROOT: '   ' }, 'empty-value'],
    ];
    for (const [argv, env, reason] of invalid) {
      expect(dataRootOverrideProblem({ argv, env })).toBe(reason);
      // An invalid override never yields a value, so nothing falls back silently.
      expect(explicitDataRoot({ argv, env })).toBeUndefined();
    }
  });

  it('does not let a later valid value rescue an earlier invalid one', () => {
    expect(
      dataRootOverrideProblem({
        argv: ['--hdsl-data-root', '--enable-logging', '--hdsl-data-root', '/valid'],
        env: {},
      }),
    ).toBe('switch-value');
    expect(
      dataRootOverrideProblem({
        argv: ['--hdsl-data-root=', '--hdsl-data-root', '/valid'],
        env: {},
      }),
    ).toBe('empty-value');
  });

  it('treats an absent override as a normal launch', () => {
    expect(dataRootOverrideProblem({ argv: ['electron'], env: {} })).toBeUndefined();
    expect(explicitDataRoot({ argv: ['electron'], env: {} })).toBeUndefined();
  });

  it('feeds resolveDataRoot so both forms select the same data root', () => {
    expect(
      resolveDataRoot({
        argv: ['electron', '--hdsl-data-root=/tmp/equals'],
        env: {},
        userDataDirectory: '/tmp/user-data',
      }),
    ).toBe('/tmp/equals');
    expect(
      resolveDataRoot({
        argv: ['electron'],
        env: {},
        userDataDirectory: '/tmp/user-data',
      }),
    ).toBe('/tmp/user-data');
  });
});

describe('Chromium --user-data-dir parsing (issue #149)', () => {
  it('recognizes only the Chromium --switch=value form', () => {
    expect(chromiumUserDataDirectory([`${USER_DATA_DIR_SWITCH}=/tmp/profile`])).toBe('/tmp/profile');
    expect(chromiumUserDataDirectory([`${USER_DATA_DIR_SWITCH}=`])).toBeUndefined();
    expect(chromiumUserDataDirectory([USER_DATA_DIR_SWITCH, '/tmp/profile'])).toBeUndefined();
    expect(chromiumUserDataDirectory([USER_DATA_DIR_SWITCH])).toBeUndefined();
    expect(chromiumUserDataDirectory([])).toBeUndefined();
  });

  it('follows Chromium last-wins for a duplicate equals switch', () => {
    expect(
      chromiumUserDataDirectory([`${USER_DATA_DIR_SWITCH}=/first`, `${USER_DATA_DIR_SWITCH}=/second`]),
    ).toBe('/second');
  });

  it('reads the space form separately so it can be normalized instead of trusted', () => {
    expect(spaceSeparatedUserDataDirectory([USER_DATA_DIR_SWITCH, '/tmp/profile'])).toBe(
      '/tmp/profile',
    );
    expect(spaceSeparatedUserDataDirectory([`${USER_DATA_DIR_SWITCH}=`])).toBeUndefined();
    expect(spaceSeparatedUserDataDirectory([USER_DATA_DIR_SWITCH])).toBeUndefined();
    expect(spaceSeparatedUserDataDirectory([USER_DATA_DIR_SWITCH, '--hdsl-data-root'])).toBeUndefined();
    expect(spaceSeparatedUserDataDirectory([])).toBeUndefined();
  });
});

describe('isolated profile bootstrap (issue #149)', () => {
  const dataRoot = '/tmp/hdsl-data-root';

  it('redirects the profile under an explicit --hdsl-data-root', () => {
    expect(
      isolatedUserDataDirectory({ argv: ['electron', '--hdsl-data-root', dataRoot], env: {} }),
    ).toBe(`${dataRoot}/${ISOLATED_PROFILE_DIRECTORY}`);
  });

  it('redirects the profile under the equals form --hdsl-data-root=<path>', () => {
    expect(
      isolatedUserDataDirectory({ argv: ['electron', `--hdsl-data-root=${dataRoot}`], env: {} }),
    ).toBe(`${dataRoot}/${ISOLATED_PROFILE_DIRECTORY}`);
  });

  it('redirects the profile under HDSL_DATA_ROOT', () => {
    expect(
      isolatedUserDataDirectory({ argv: ['electron'], env: { HDSL_DATA_ROOT: dataRoot } }),
    ).toBe(`${dataRoot}/${ISOLATED_PROFILE_DIRECTORY}`);
  });

  it('treats a flag without a value and a blank env as unusable rather than isolated', () => {
    expect(
      isolatedUserDataDirectory({ argv: ['electron', '--hdsl-data-root'], env: {} }),
    ).toBeUndefined();
    expect(
      isolatedUserDataDirectory({ argv: ['electron'], env: { HDSL_DATA_ROOT: '   ' } }),
    ).toBeUndefined();
  });

  it('keeps an explicit --user-data-dir instead of deriving one from the data root', () => {
    expect(
      isolatedUserDataDirectory({
        argv: [`--hdsl-data-root=${dataRoot}`, `${USER_DATA_DIR_SWITCH}=/tmp/explicit`],
        env: {},
      }),
    ).toBeUndefined();
  });

  it('never reads, creates or migrates the real default profile for an isolated run', () => {
    const legacy = legacyUserDataDirectory(APP_DATA);
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    const defaultPath = defaultUserDataDirectory(APP_DATA);
    const created: string[] = [];
    const setPaths: string[] = [];
    let current: string | undefined;
    const host = {
      getPath(name: string): string {
        if (name === 'appData') {
          return APP_DATA;
        }
        if (name === 'userData') {
          const path = current ?? defaultPath;
          created.push(path);
          return path;
        }
        throw new Error(`unexpected getPath: ${name}`);
      },
      setPath(name: string, path: string): void {
        setPaths.push(`${name}=${path}`);
        current = path;
      },
    };

    const outcome = applyUserDataBootstrap(host, {
      argv: ['electron', '--hdsl-data-root', dataRoot],
      env: {},
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
    });

    expect(outcome).toEqual({
      directory: `${dataRoot}/${ISOLATED_PROFILE_DIRECTORY}`,
      isolated: true,
      migrated: false,
    });
    // The default path was never requested (so never created) and the legacy
    // directory was neither inspected nor moved.
    expect(created).toEqual([]);
    expect(setPaths).toEqual([`userData=${dataRoot}/${ISOLATED_PROFILE_DIRECTORY}`]);
    expect(fake.calls).toEqual([]);
    expect(fake.dirs.get(legacy)).toBe('populated');
  });
});

describe('malformed isolation arguments fail loud (issue #149)', () => {
  const dataRoot = '/tmp/hdsl-root';
  const target = defaultUserDataDirectory(APP_DATA);

  // Every malformed spelling from the review matrix, plus the conflict case.
  const cases: ReadonlyArray<
    readonly [string, readonly string[], Readonly<Record<string, string | undefined>>, string, string]
  > = [
    ['dangling data-root flag', ['electron', '--hdsl-data-root'], {}, 'data-root', 'missing-value'],
    ['empty equals data-root', ['electron', '--hdsl-data-root='], {}, 'data-root', 'empty-value'],
    ['empty string data-root', ['electron', '--hdsl-data-root', ''], {}, 'data-root', 'missing-value'],
    [
      'switch used as data-root',
      ['electron', '--hdsl-data-root', '--enable-logging'],
      {},
      'data-root',
      'switch-value',
    ],
    ['empty data-root env', ['electron'], { HDSL_DATA_ROOT: '' }, 'data-root', 'empty-value'],
    ['blank data-root env', ['electron'], { HDSL_DATA_ROOT: '   ' }, 'data-root', 'empty-value'],
    ['empty equals user-data-dir', ['electron', '--user-data-dir='], {}, 'user-data-dir', 'empty-value'],
    ['dangling user-data-dir', ['electron', '--user-data-dir'], {}, 'user-data-dir', 'missing-value'],
    [
      'empty string user-data-dir',
      ['electron', '--user-data-dir', ''],
      {},
      'user-data-dir',
      'missing-value',
    ],
    [
      'switch used as user-data-dir',
      ['electron', '--user-data-dir', '--hdsl-data-root', dataRoot],
      {},
      'user-data-dir',
      'switch-value',
    ],
    [
      'valid data root plus empty user-data-dir',
      ['electron', `--hdsl-data-root=${dataRoot}`, '--user-data-dir='],
      {},
      'user-data-dir',
      'empty-value',
    ],
  ];

  it.each(cases)('%s is rejected before any userData access', (_label, argv, env, kind, reason) => {
    expect(launchArgumentProblem({ argv, env })).toEqual({ kind, problem: reason });
    const fake = fakeFileSystem({ dirs: [[legacyUserDataDirectory(APP_DATA), 'populated']] });
    const record = recordingHost(APP_DATA, target);
    const setup = configureUserData(record.host, {
      argv,
      env,
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
      onNote: () => {
        throw new Error('a rejected launch must not emit a migration note');
      },
    });
    expect(setup).toEqual({ kind: 'invalid', problem: { kind, problem: reason } });
    // The guard runs before `getPath('userData')`, so the default profile is
    // never created, read or migrated.
    expect(record.userDataAccesses).toEqual([]);
    expect(record.setPaths).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('allows an absent override and documented first-wins duplicates', () => {
    expect(launchArgumentProblem({ argv: ['electron'], env: {} })).toBeUndefined();
    expect(
      launchArgumentProblem({
        argv: ['electron', '--hdsl-data-root', '/a', '--hdsl-data-root', '/b'],
        env: {},
      }),
    ).toBeUndefined();
  });

  it('formats a fixed, path-free rejection signal', () => {
    expect(formatLaunchArgumentSignal({ kind: 'data-root', problem: 'missing-value' })).toBe(
      `${LAUNCH_ARGUMENT_SIGNAL} kind=data-root reason=missing-value\n`,
    );
    expect(formatLaunchArgumentSignal({ kind: 'user-data-dir', problem: 'empty-value' })).toBe(
      `${LAUNCH_ARGUMENT_SIGNAL} kind=user-data-dir reason=empty-value\n`,
    );
  });
});

describe('user-data-dir validation (issue #149)', () => {
  it('reports empty, dangling and switch values for both spellings', () => {
    expect(userDataDirProblem([`${USER_DATA_DIR_SWITCH}=`])).toBe('empty-value');
    expect(userDataDirProblem([`${USER_DATA_DIR_SWITCH}=   `])).toBe('empty-value');
    expect(userDataDirProblem([USER_DATA_DIR_SWITCH])).toBe('missing-value');
    expect(userDataDirProblem([USER_DATA_DIR_SWITCH, ''])).toBe('missing-value');
    expect(userDataDirProblem([USER_DATA_DIR_SWITCH, '--hdsl-data-root'])).toBe('switch-value');
    expect(userDataDirProblem([`${USER_DATA_DIR_SWITCH}=/tmp/p`])).toBeUndefined();
    expect(userDataDirProblem([USER_DATA_DIR_SWITCH, '/tmp/p'])).toBeUndefined();
    expect(userDataDirProblem([])).toBeUndefined();
  });
});

describe('userData migration plan (issue #149)', () => {
  const target = defaultUserDataDirectory(APP_DATA);
  const legacy = legacyUserDataDirectory(APP_DATA);
  const lockPath = join(APP_DATA, MIGRATION_LOCK_FILE);

  const resolve = (
    fake: ReturnType<typeof fakeFileSystem>,
    isProcessAlive: (pid: number) => boolean = () => false,
  ): ReturnType<typeof resolveUserDataDirectory> =>
    resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      fileSystem: fake.fileSystem,
      hostname: HOST,
      isProcessAlive,
      pid: 4242,
    });

  it('leaves an explicit --user-data-dir override untouched', () => {
    const override = '/tmp/hdsl-smoke-userdata';
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: override,
      fileSystem: new Proxy({} as UserDataFileSystem, {
        get: () => () => {
          throw new Error('the migration must not inspect any directory for an override');
        },
      }),
    });
    expect(resolution).toEqual({ directory: override, migrated: false });
  });

  it('keeps the target when no legacy directory exists', () => {
    const fake = fakeFileSystem();
    expect(resolve(fake)).toEqual({ directory: target, migrated: false });
    expect(fake.calls).toEqual([]);
  });

  it('ignores an empty legacy directory', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'empty']] });
    expect(resolve(fake)).toEqual({ directory: target, migrated: false });
    expect(fake.calls).toEqual([]);
  });

  it('preserves an unreadable legacy directory instead of treating it as absent', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'unreadable']] });
    expect(resolve(fake)).toEqual({ directory: legacy, migrated: false, note: 'legacy-unreadable' });
    expect(fake.calls).toEqual([]);
  });

  it('never moves a symlinked legacy directory', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']], symlinks: [legacy] });
    expect(resolve(fake)).toEqual({ directory: legacy, migrated: false, note: 'legacy-symlink' });
    expect(fake.calls).toEqual([]);
  });

  it('never moves a legacy directory whose scoped parent is a symlink', () => {
    const fake = fakeFileSystem({
      dirs: [[legacy, 'populated']],
      symlinks: [legacyScopeDirectory(APP_DATA)],
    });
    expect(resolve(fake)).toEqual({ directory: legacy, migrated: false, note: 'legacy-symlink' });
    expect(fake.calls).toEqual([]);
  });

  it('never renames a profile a live process still owns', () => {
    const fake = fakeFileSystem({
      dirs: [[legacy, 'populated']],
      singletonLocks: [[legacy, `${HOST}-999`]],
    });
    expect(resolve(fake, (pid) => pid === 999)).toEqual({
      directory: legacy,
      migrated: false,
      note: 'legacy-in-use',
    });
    expect(fake.calls).toEqual([]);
  });

  it('reclaims a profile whose lock owner is dead', () => {
    const fake = fakeFileSystem({
      dirs: [[legacy, 'populated']],
      singletonLocks: [[legacy, `${HOST}-999`]],
    });
    expect(resolve(fake)).toEqual({ directory: target, migrated: true });
    expect(fake.calls).toContain(`rename:${legacy}->${target}`);
  });

  it('keeps a symlinked target instead of replacing it', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']], symlinks: [target] });
    expect(resolve(fake)).toEqual({ directory: target, migrated: false, note: 'target-symlink' });
    expect(fake.calls).toEqual([]);
  });

  it('keeps an unreadable target instead of replacing it', () => {
    const fake = fakeFileSystem({
      dirs: [
        [legacy, 'populated'],
        [target, 'unreadable'],
      ],
    });
    expect(resolve(fake)).toEqual({ directory: target, migrated: false, note: 'target-unreadable' });
    expect(fake.calls).toEqual([]);
  });

  it('keeps two populated profiles separate instead of merging them', () => {
    const fake = fakeFileSystem({
      dirs: [
        [legacy, 'populated'],
        [target, 'populated'],
      ],
    });
    expect(resolve(fake)).toEqual({ directory: target, migrated: false, note: 'legacy-retained' });
    expect(fake.calls).toEqual([]);
  });

  it('moves a populated legacy directory over the absent target and releases the lock', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    expect(resolve(fake)).toEqual({ directory: target, migrated: true });
    expect(fake.calls).toEqual([
      `lock:${lockPath}`,
      `rename:${legacy}->${target}`,
      `unlock:${lockPath}`,
    ]);
    expect(fake.lockFiles.size).toBe(0);
  });

  it('removes the empty default directory Electron pre-created before renaming', () => {
    const fake = fakeFileSystem({
      dirs: [
        [legacy, 'populated'],
        [target, 'empty'],
      ],
    });
    expect(resolve(fake)).toEqual({ directory: target, migrated: true });
    expect(fake.calls).toEqual([
      `lock:${lockPath}`,
      `rmdir:${target}`,
      `rename:${legacy}->${target}`,
      `unlock:${lockPath}`,
    ]);
  });

  it('never renames while another launcher holds the migration lock', () => {
    const fake = fakeFileSystem({
      dirs: [[legacy, 'populated']],
      lockFiles: [[lockPath, `${HOST}-777`]],
    });
    expect(resolve(fake, (pid) => pid === 777)).toEqual({
      directory: target,
      migrated: false,
      note: 'migration-busy',
    });
    // The other launcher's lock is left in place; only the failed create ran.
    expect(fake.calls).toEqual([`lock:${lockPath}`]);
    expect(fake.lockFiles.get(lockPath)).toBe(`${HOST}-777`);
  });

  it('reclaims a stale migration lock and finishes the move', () => {
    const fake = fakeFileSystem({
      dirs: [[legacy, 'populated']],
      lockFiles: [[lockPath, `${HOST}-777`]],
    });
    expect(resolve(fake)).toEqual({ directory: target, migrated: true });
    expect(fake.calls).toContain(`rename:${legacy}->${target}`);
    expect(fake.lockFiles.size).toBe(0);
  });

  it('falls back to the legacy directory when the move fails', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      hostname: HOST,
      isProcessAlive: () => false,
      fileSystem: {
        ...fake.fileSystem,
        rename: () => {
          throw new Error('EPERM');
        },
      },
    });
    expect(resolution).toEqual({ directory: legacy, migrated: false, note: 'migration-failed' });
    expect(fake.dirs.get(legacy)).toBe('populated');
  });

  it('uses the target when the competing launcher migrated between the check and the lock', () => {
    // Model the interleaving: the pre-check sees a populated legacy directory,
    // the re-read under the lock sees it already consumed by the other launcher.
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    let legacyReads = 0;
    const fileSystem: UserDataFileSystem = {
      ...fake.fileSystem,
      stateOf: (directory) => {
        if (directory === legacy) {
          legacyReads += 1;
          return legacyReads === 1 ? 'populated' : 'absent';
        }
        return fake.fileSystem.stateOf(directory);
      },
    };
    const resolution = resolveUserDataDirectory({
      appDataDirectory: APP_DATA,
      userDataDirectory: target,
      hostname: HOST,
      isProcessAlive: () => false,
      fileSystem,
    });
    expect(resolution).toEqual({ directory: target, migrated: false });
    expect(fake.calls).not.toContain(`rename:${legacy}->${target}`);
    expect(fake.lockFiles.size).toBe(0);
  });
});

describe('applyUserDataBootstrap on the default path (issue #149)', () => {
  const target = defaultUserDataDirectory(APP_DATA);
  const legacy = legacyUserDataDirectory(APP_DATA);

  const hostWith = (initialUserData?: string) => {
    const created: string[] = [];
    const setPaths: string[] = [];
    let current = initialUserData;
    return {
      created,
      setPaths,
      host: {
        getPath(name: string): string {
          if (name === 'appData') {
            return APP_DATA;
          }
          if (name === 'userData') {
            const path = current ?? target;
            created.push(path);
            return path;
          }
          throw new Error(`unexpected getPath: ${name}`);
        },
        setPath(name: string, path: string): void {
          setPaths.push(`${name}=${path}`);
          current = path;
        },
      },
    };
  };

  it('migrates a populated legacy profile and reports the default path', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    const { host, created, setPaths } = hostWith();
    const notes: UserDataNote[] = [];
    const outcome = applyUserDataBootstrap(host, {
      argv: ['electron'],
      env: {},
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
      isProcessAlive: () => false,
      onNote: (note) => notes.push(note),
    });
    expect(outcome).toMatchObject({ directory: target, isolated: false, migrated: true });
    expect(created).toEqual([target]);
    expect(setPaths).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('reports a note and keeps the legacy directory when it is unreadable', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'unreadable']] });
    const { host, setPaths } = hostWith();
    const notes: UserDataNote[] = [];
    const outcome = applyUserDataBootstrap(host, {
      argv: ['electron'],
      env: {},
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
      onNote: (note) => notes.push(note),
    });
    expect(outcome.directory).toBe(legacy);
    expect(outcome.note).toBe('legacy-unreadable');
    expect(notes).toEqual(['legacy-unreadable']);
    expect(setPaths).toEqual([`userData=${legacy}`]);
  });

  it('leaves the default path in place for a normal launch with no legacy data', () => {
    const fake = fakeFileSystem();
    const { host, created, setPaths } = hostWith();
    applyUserDataBootstrap(host, {
      argv: ['electron'],
      env: {},
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
    });
    expect(created).toEqual([target]);
    expect(setPaths).toEqual([]);
  });

  it('round-trips an explicit --user-data-dir without creating or migrating the default', () => {
    const explicit = '/tmp/hdsl-explicit-profile';
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    const { host, created, setPaths } = hostWith();
    const outcome = applyUserDataBootstrap(host, {
      argv: [`--hdsl-data-root=/tmp/root`, `${USER_DATA_DIR_SWITCH}=${explicit}`],
      env: {},
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
    });
    expect(outcome).toEqual({ directory: explicit, isolated: true, migrated: false });
    // `getPath('userData')` is what creates the directory, so it is never called.
    expect(created).toEqual([]);
    expect(setPaths).toEqual([`userData=${explicit}`]);
    expect(fake.calls).toEqual([]);
  });

  it('applies a space-separated --user-data-dir that Chromium would ignore', () => {
    // Chromium treats the space form as a positional argument; without this
    // normalization the run would fall back to the real default profile.
    const explicit = '/tmp/hdsl-space-profile';
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    const { host, created, setPaths } = hostWith();
    const outcome = applyUserDataBootstrap(host, {
      argv: ['--hdsl-data-root', '/tmp/root', USER_DATA_DIR_SWITCH, explicit],
      env: {},
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
    });
    expect(outcome).toEqual({ directory: explicit, isolated: true, migrated: false });
    expect(created).toEqual([]);
    expect(setPaths).toEqual([`userData=${explicit}`]);
    expect(fake.calls).toEqual([]);
  });

  it('prefers the equals form when both switch spellings are present', () => {
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    const { host, setPaths } = hostWith();
    const outcome = applyUserDataBootstrap(host, {
      argv: [`${USER_DATA_DIR_SWITCH}=/tmp/equals`, USER_DATA_DIR_SWITCH, '/tmp/space'],
      env: {},
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
    });
    expect(outcome.directory).toBe('/tmp/equals');
    expect(setPaths).toEqual(['userData=/tmp/equals']);
  });

  it('isolates an equals-form --hdsl-data-root without creating the default', () => {
    const dataRoot = '/tmp/hdsl-equals-root';
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    const { host, created, setPaths } = hostWith();
    const outcome = applyUserDataBootstrap(host, {
      argv: ['electron', `--hdsl-data-root=${dataRoot}`],
      env: {},
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
    });
    expect(outcome).toEqual({
      directory: `${dataRoot}/${ISOLATED_PROFILE_DIRECTORY}`,
      isolated: true,
      migrated: false,
    });
    expect(created).toEqual([]);
    expect(setPaths).toEqual([`userData=${dataRoot}/${ISOLATED_PROFILE_DIRECTORY}`]);
    expect(fake.calls).toEqual([]);
  });

  it('prefers an explicit data-root flag over the environment', () => {
    const dataRoot = '/tmp/flag-wins-root';
    const fake = fakeFileSystem({ dirs: [[legacy, 'populated']] });
    const { host, created } = hostWith();
    const outcome = applyUserDataBootstrap(host, {
      argv: ['electron', '--hdsl-data-root', dataRoot],
      env: { HDSL_DATA_ROOT: '/tmp/env-root' },
      appDataDirectory: APP_DATA,
      fileSystem: fake.fileSystem,
      hostname: HOST,
    });
    expect(outcome).toEqual({
      directory: `${dataRoot}/${ISOLATED_PROFILE_DIRECTORY}`,
      isolated: true,
      migrated: false,
    });
    expect(created).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe('userData signal and lock classification (issue #149)', () => {
  it('is a single fixed, path-free line per reason', () => {
    const notes: UserDataNote[] = [
      'legacy-retained',
      'legacy-unreadable',
      'legacy-symlink',
      'legacy-in-use',
      'migration-busy',
      'target-unreadable',
      'target-symlink',
      'migration-failed',
    ];
    for (const note of notes) {
      expect(formatUserDataSignal(note)).toBe(`[hdsl] user-data ${note}\n`);
    }
  });

  it('treats only a live same-host owner as in use', () => {
    expect(isLiveLockOwner({ owner: `${HOST}-10`, hostname: HOST, isProcessAlive: () => true })).toBe(
      true,
    );
    expect(isLiveLockOwner({ owner: `${HOST}-10`, hostname: HOST, isProcessAlive: () => false })).toBe(
      false,
    );
    expect(isLiveLockOwner({ owner: 'other-10', hostname: HOST, isProcessAlive: () => true })).toBe(
      false,
    );
    expect(isLiveLockOwner({ owner: 'garbage', hostname: HOST, isProcessAlive: () => true })).toBe(
      false,
    );
    expect(isLiveLockOwner({ owner: undefined, hostname: HOST, isProcessAlive: () => true })).toBe(
      false,
    );
  });
});

/**
 * Real-filesystem checks. Every root is a disposable `mkdtemp` directory and no
 * developer profile is read or moved. Symlink/permission cases are skipped where
 * the platform or privileges make them meaningless.
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
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'environment.json'), '{"id":"env-1"}\n');

    const resolution = resolveUserDataDirectory({
      appDataDirectory: base,
      userDataDirectory: target,
    });

    expect(resolution).toEqual({ directory: target, migrated: true });
    expect(readFileSync(join(target, 'environment.json'), 'utf8')).toBe('{"id":"env-1"}\n');
    expect(() => readFileSync(join(base, MIGRATION_LOCK_FILE), 'utf8')).toThrow();
  });

  it('keeps two existing profiles separate instead of merging them', () => {
    const base = appData();
    const legacy = legacyUserDataDirectory(base);
    const target = defaultUserDataDirectory(base);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'environment.json'), '{"id":"env-1"}\n');
    writeFileSync(join(target, 'SingletonLock'), '');

    const resolution = resolveUserDataDirectory({
      appDataDirectory: base,
      userDataDirectory: target,
    });

    expect(resolution).toEqual({ directory: target, migrated: false, note: 'legacy-retained' });
    expect(readFileSync(join(legacy, 'environment.json'), 'utf8')).toBe('{"id":"env-1"}\n');
  });

  it.skipIf(process.platform === 'win32')('never moves a symlinked legacy directory', () => {
    const base = appData();
    const external = appData();
    const legacy = legacyUserDataDirectory(base);
    const target = defaultUserDataDirectory(base);
    writeFileSync(join(external, 'environment.json'), '{"id":"env-1"}\n');
    mkdirSync(legacyScopeDirectory(base), { recursive: true });
    symlinkSync(external, legacy);

    const resolution = resolveUserDataDirectory({
      appDataDirectory: base,
      userDataDirectory: target,
    });

    expect(resolution).toEqual({ directory: legacy, migrated: false, note: 'legacy-symlink' });
    // The link itself is still a link; the data was not relocated.
    expect(readFileSync(join(legacy, 'environment.json'), 'utf8')).toBe('{"id":"env-1"}\n');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'preserves a legacy directory it cannot read (EACCES)',
    () => {
      const base = appData();
      const legacy = legacyUserDataDirectory(base);
      const target = defaultUserDataDirectory(base);
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'environment.json'), '{"id":"env-1"}\n');
      chmodSync(legacy, 0o000);
      try {
        const resolution = resolveUserDataDirectory({
          appDataDirectory: base,
          userDataDirectory: target,
        });
        expect(resolution).toEqual({
          directory: legacy,
          migrated: false,
          note: 'legacy-unreadable',
        });
      } finally {
        chmodSync(legacy, 0o700);
      }
    },
  );
});
