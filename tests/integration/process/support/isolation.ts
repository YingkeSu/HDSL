/**
 * Process-owned temporary roots and host-HOME isolation.
 *
 * Process QA never writes inside the repository or the developer's HOME. Every
 * scenario runs under `mkdtemp`. Fixture processes are spawned with a minimal
 * environment (`HOME`/`DSH_HOME` unset, not redirected); scenarios that need an
 * isolated root opt in through {@link withIsolatedEnv}, which redirects
 * HOME/DSH_HOME/XDG into the sandbox for the duration. The host-guard snapshots
 * the real `~/.dsh` (and the conventional HDSL app-data locations) so a launcher
 * or fixture that ignores the managed root is caught instead of quietly writing
 * into the host home.
 *
 * This mirrors the isolation contract of `tests/integration/install`, but is
 * kept inside `tests/integration/process` because the two QA slices own
 * separate directories (see issue #45).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

export interface TempRoot {
  readonly path: string;
  cleanup(): void;
}

export const createTempRoot = (label: string): TempRoot => {
  const path = mkdtempSync(join(tmpdir(), `hdsl-proc-${label}-`));
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    },
  };
};

export interface HomeEntry {
  readonly relPath: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly size: number;
  readonly hash: string;
}

const hashFile = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** Records a home tree shallowly; enough to detect a launcher write. */
export const snapshotHome = (root: string, maxDepth = 4): readonly HomeEntry[] => {
  const entries: HomeEntry[] = [];
  if (!existsSync(root)) {
    return entries;
  }
  const visit = (dir: string, depth: number): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const relPath = relative(root, full).split(sep).join('/');
      const stats = statSync(full, { throwIfNoEntry: false });
      if (stats === undefined) {
        continue;
      }
      if (stats.isSymbolicLink()) {
        entries.push({ relPath, kind: 'symlink', size: 0, hash: '' });
      } else if (stats.isDirectory()) {
        entries.push({ relPath, kind: 'dir', size: 0, hash: '' });
        if (depth < maxDepth) {
          visit(full, depth + 1);
        }
      } else if (stats.isFile()) {
        entries.push({
          relPath,
          kind: 'file',
          size: stats.size,
          hash: stats.size <= 256 * 1024 ? hashFile(full) : '',
        });
      }
    }
  };
  visit(root, 0);
  return entries.sort((left, right) => (left.relPath < right.relPath ? -1 : 1));
};

export interface HostDefaults {
  readonly homeTopLevel: readonly string[];
  readonly dshHomes: readonly { readonly path: string; readonly entries: readonly HomeEntry[] }[];
}

/**
 * Locations a managed launcher must not write when a managed dataRoot is
 * configured. `~/.dsh` is the upstream default (T001 R003); the rest are the
 * conventional Electron app-data names for this project.
 */
const guardedPaths = (): readonly string[] => {
  const home = homedir();
  return [
    join(home, '.dsh'),
    join(home, '.config', 'hdsl'),
    join(home, '.config', 'HDSL'),
    join(home, 'Library', 'Application Support', 'HDSL'),
    join(home, 'Library', 'Application Support', 'hdsl'),
  ];
};

export const captureHostDefaults = (): HostDefaults => ({
  homeTopLevel: readdirSync(homedir()).sort(),
  dshHomes: guardedPaths().map((path) => ({ path, entries: snapshotHome(path) })),
});

export interface HostDiff {
  readonly equal: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export const diffHostDefaults = (before: HostDefaults, after: HostDefaults): HostDiff => {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const name of after.homeTopLevel) {
    if (!before.homeTopLevel.includes(name)) {
      added.push(`HOME/${name}`);
    }
  }
  for (let index = 0; index < before.dshHomes.length; index += 1) {
    const left = before.dshHomes[index];
    const right = after.dshHomes[index];
    if (left === undefined || right === undefined) {
      continue;
    }
    const leftMap = new Map(left.entries.map((entry) => [entry.relPath, entry]));
    const rightMap = new Map(right.entries.map((entry) => [entry.relPath, entry]));
    for (const [relPath, entry] of rightMap) {
      const previous = leftMap.get(relPath);
      if (previous === undefined) {
        added.push(`${left.path}/${relPath}`);
      } else if (previous.hash !== entry.hash || previous.size !== entry.size || previous.kind !== entry.kind) {
        changed.push(`${left.path}/${relPath}`);
      }
    }
    for (const relPath of leftMap.keys()) {
      if (!rightMap.has(relPath)) {
        removed.push(`${left.path}/${relPath}`);
      }
    }
  }
  return { equal: added.length + removed.length + changed.length === 0, added, removed, changed };
};

/**
 * Runs `fn` with HOME and every relevant data root redirected into `root`, and
 * restores the previous environment (including absent keys) afterwards.
 */
export const withIsolatedEnv = async <T>(root: string, fn: () => Promise<T>): Promise<T> => {
  const sandboxHome = join(root, 'home');
  for (const directory of [sandboxHome, join(root, 'dsh-home'), join(root, 'tmp')]) {
    mkdirSync(directory, { recursive: true });
  }
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

export class GateTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GateTimeoutError';
  }
}

/**
 * Bounded wait for a deterministic gate (a file, a socket, a state). Tests use
 * this instead of `sleep`: the wait ends the instant the gate opens, and times
 * out with an explicit error rather than hanging forever.
 */
export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly label?: string } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new GateTimeoutError(`gate did not open within ${timeoutMs}ms: ${options.label ?? 'unnamed gate'}`);
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
