/**
 * Real temporary directories and host-default isolation for install QA.
 *
 * Every fixture root is created under the OS temp directory (`mkdtemp`), never
 * inside the repository and never inside the user's HOME. The suite overrides
 * `HOME`/`DSH_HOME`/XDG roots for the duration of a scenario so a launcher bug
 * that ignores the managed root writes into the temp sandbox instead of the
 * host. `captureHostDefaults`/`diffHostDefaults` then prove the host `~/.dsh`
 * (and the candidate app-data locations) were not touched.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

export interface TempRoot {
  readonly path: string;
  cleanup(): void;
}

export const createTempRoot = (label: string): TempRoot => {
  const path = mkdtempSync(join(tmpdir(), `hdsl-qa-${label}-`));
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    },
  };
};

export interface TreeEntry {
  readonly relPath: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly size: number;
  readonly mtimeMs: number;
  /** SHA-256 for hashed files; symlink target for symlinks; empty otherwise. */
  readonly detail: string;
}

export interface TreeSnapshot {
  readonly root: string;
  readonly exists: boolean;
  readonly entries: readonly TreeEntry[];
}

export interface SnapshotOptions {
  readonly maxDepth?: number;
  /** Directory names whose subtree is recorded but not descended into. */
  readonly skipDirNames?: readonly string[];
  /** Hash regular files up to this size; larger files use size+mtime only. */
  readonly maxHashBytes?: number;
}

const hashFile = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

export const snapshotTree = (root: string, options: SnapshotOptions = {}): TreeSnapshot => {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const skipDirNames = new Set(options.skipDirNames ?? []);
  const maxHashBytes = options.maxHashBytes ?? 2 * 1024 * 1024;
  const entries: TreeEntry[] = [];
  const visit = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const relPath = relative(root, full).split(sep).join('/');
      let stats;
      try {
        stats = statSync(full, { throwIfNoEntry: false });
      } catch {
        // A path longer than the OS limit (symlink farms under a real DSH
        // install) cannot be inspected; the host-default check still detects
        // the entry itself at its parent level.
        continue;
      }
      if (stats === undefined) {
        continue;
      }
      if (stats.isSymbolicLink()) {
        entries.push({ relPath, kind: 'symlink', size: 0, mtimeMs: stats.mtimeMs, detail: safeLink(full) });
      } else if (stats.isDirectory()) {
        entries.push({ relPath, kind: 'dir', size: 0, mtimeMs: stats.mtimeMs, detail: '' });
        if (depth < maxDepth && !skipDirNames.has(name)) {
          visit(full, depth + 1);
        }
      } else if (stats.isFile()) {
        entries.push({
          relPath,
          kind: 'file',
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          detail: stats.size <= maxHashBytes ? hashFile(full) : '',
        });
      }
    }
  };
  const exists = statSync(root, { throwIfNoEntry: false }) !== undefined;
  if (exists) {
    visit(root, 0);
  }
  entries.sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0));
  return { root, exists, entries };
};

const safeLink = (path: string): string => {
  try {
    return readlinkSync(path);
  } catch {
    return '<unreadable-link>';
  }
};

export interface SnapshotDiff {
  readonly equal: boolean;
  readonly added: readonly TreeEntry[];
  readonly removed: readonly TreeEntry[];
  readonly changed: readonly TreeEntry[];
}

export const diffSnapshots = (before: TreeSnapshot, after: TreeSnapshot): SnapshotDiff => {
  const beforeMap = new Map(before.entries.map((entry) => [entry.relPath, entry]));
  const afterMap = new Map(after.entries.map((entry) => [entry.relPath, entry]));
  const added = after.entries.filter((entry) => !beforeMap.has(entry.relPath));
  const removed = before.entries.filter((entry) => !afterMap.has(entry.relPath));
  const changed = after.entries.filter((entry) => {
    const previous = beforeMap.get(entry.relPath);
    return (
      previous !== undefined &&
      (previous.detail !== entry.detail ||
        previous.size !== entry.size ||
        previous.kind !== entry.kind ||
        previous.mtimeMs !== entry.mtimeMs)
    );
  });
  return { equal: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed };
};

/**
 * Candidate host locations a launcher must not write to when a managed root is
 * configured. `~/.dsh` is the upstream default (T001 R003); the app-data paths
 * are the conventional Electron locations for this project name.
 */
export const hostDefaultPaths = (): readonly string[] => {
  const home = homedir();
  return [
    join(home, '.dsh'),
    join(home, '.config', 'hdsl'),
    join(home, '.config', 'HDSL'),
    join(home, 'Library', 'Application Support', 'HDSL'),
    join(home, 'Library', 'Application Support', 'hdsl'),
  ];
};

export interface HostDefaults {
  readonly snapshots: readonly TreeSnapshot[];
  readonly homeTopLevel: readonly string[];
}

export const captureHostDefaults = (): HostDefaults => ({
  // Skip `node_modules`: a real DSH install is a deep symlink farm whose paths
  // exceed the OS limit. Its top-level entry is still recorded, so a launcher
  // write to the host home remains detectable.
  snapshots: hostDefaultPaths().map((path) =>
    snapshotTree(path, { maxDepth: 4, skipDirNames: ['node_modules'], maxHashBytes: 256 * 1024 }),
  ),
  homeTopLevel: readdirSync(homedir()),
});

export const diffHostDefaults = (before: HostDefaults, after: HostDefaults): SnapshotDiff => {
  const differences: TreeEntry[] = [];
  for (let index = 0; index < before.snapshots.length; index += 1) {
    const left = before.snapshots[index];
    const right = after.snapshots[index];
    if (left === undefined || right === undefined) {
      continue;
    }
    const diff = diffSnapshots(left, right);
    differences.push(...diff.added, ...diff.removed, ...diff.changed);
  }
  const newTopLevel = after.homeTopLevel.filter((name) => !before.homeTopLevel.includes(name));
  for (const name of newTopLevel) {
    differences.push({
      relPath: `HOME/${name}`,
      kind: 'file',
      size: 0,
      mtimeMs: 0,
      detail: 'new host HOME entry',
    });
  }
  return {
    equal: differences.length === 0,
    added: newTopLevel.map((name) => ({
      relPath: `HOME/${name}`,
      kind: 'file' as const,
      size: 0,
      mtimeMs: 0,
      detail: '',
    })),
    removed: [],
    changed: [],
  };
};

/**
 * Runs `fn` with HOME and all relevant data roots redirected into `root`, so a
 * launcher that resolves a default root by environment cannot escape to the
 * host. Restores the previous environment (including absent keys) afterwards.
 */
export const withIsolatedEnv = async <T>(root: string, fn: () => Promise<T>): Promise<T> => {
  const sandboxHome = join(root, 'home');
  const overrides: Record<string, string> = {
    HOME: sandboxHome,
    DSH_HOME: join(root, 'dsh-home'),
    XDG_CONFIG_HOME: join(sandboxHome, '.config'),
    XDG_DATA_HOME: join(sandboxHome, '.local', 'share'),
    XDG_CACHE_HOME: join(sandboxHome, '.cache'),
    XDG_STATE_HOME: join(sandboxHome, '.local', 'state'),
    TMPDIR: join(root, 'tmp'),
    USERPROFILE: sandboxHome,
    LOCALAPPDATA: join(sandboxHome, 'AppData', 'Local'),
    APPDATA: join(sandboxHome, 'AppData', 'Roaming'),
  };
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

/** Bounded poll helper: never waits forever on an operation that hangs. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
