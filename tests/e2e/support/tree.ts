/**
 * Shallow tree snapshot / diff used as the host-HOME guard.
 *
 * A desktop E2E run must not write into the developer's real `~/.dsh` or the
 * conventional HDSL app-data directories. The guard is a byte-level snapshot
 * taken before and after a scenario; the diff is a deterministic assertion, not
 * a log message. `harness.test.ts` proves the diff actually reacts to an added,
 * changed and removed entry, so a green guard is never vacuously equal.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Files above this size are hashed as empty (size still compared). */
const MAX_HASH_BYTES = 256 * 1024;
const MAX_DEPTH = 4;

export interface TreeEntry {
  readonly relPath: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly size: number;
  readonly sha256: string;
}

export const snapshotTree = (root: string): readonly TreeEntry[] => {
  const entries: TreeEntry[] = [];
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
        entries.push({ relPath, kind: 'symlink', size: 0, sha256: '' });
      } else if (stats.isDirectory()) {
        entries.push({ relPath, kind: 'dir', size: 0, sha256: '' });
        if (depth < MAX_DEPTH) {
          visit(full, depth + 1);
        }
      } else if (stats.isFile()) {
        const sha256 =
          stats.size <= MAX_HASH_BYTES
            ? createHash('sha256').update(readFileSync(full)).digest('hex')
            : '';
        entries.push({ relPath, kind: 'file', size: stats.size, sha256 });
      }
    }
  };
  visit(root, 0);
  return entries.sort((left, right) => (left.relPath < right.relPath ? -1 : 1));
};

export interface TreeDiff {
  readonly equal: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export const diffTrees = (
  before: readonly TreeEntry[],
  after: readonly TreeEntry[],
): TreeDiff => {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const left = new Map(before.map((entry) => [entry.relPath, entry]));
  const right = new Map(after.map((entry) => [entry.relPath, entry]));
  for (const [relPath, entry] of right) {
    const previous = left.get(relPath);
    if (previous === undefined) {
      added.push(relPath);
    } else if (
      previous.kind !== entry.kind ||
      previous.size !== entry.size ||
      previous.sha256 !== entry.sha256
    ) {
      changed.push(relPath);
    }
  }
  for (const relPath of left.keys()) {
    if (!right.has(relPath)) {
      removed.push(relPath);
    }
  }
  return {
    equal: added.length + removed.length + changed.length === 0,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
};
