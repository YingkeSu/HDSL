/**
 * Crash-safe first-time migration from the pre-ADR-0006 per-generation home and
 * data directories (`<generation>/home`, `<generation>/data`) to the
 * environment-scoped shared layout (`<environment>/home`, `<environment>/data`).
 *
 * ADR 0006 / S2 §1.1. Safety rules encoded here:
 *
 * - **Verify, never trust a label.** On every run the published target is
 *   re-hashed and compared with the digest recorded when it was produced; a
 *   `copied`/`finalized` flag alone is never sufficient to delete the legacy
 *   source.
 * - **The legacy source is removed only after a verified published copy exists.**
 *   A missing or truncated target keeps the only copy and reports a conflict.
 * - **A pre-existing target that is not a verified product of this migration is
 *   never removed or overwritten**; the migration fails closed.
 * - **Symlinks are copied as links and never followed**, so content outside the
 *   legacy tree is never read. Verification hashes the link target string.
 * - File contents are hashed for the integrity digest but never logged; secret
 *   files keep their mode (`.credentials.yaml` stays 0600).
 * - The parent directory is fsynced after the publish rename.
 *
 * Each tree (home, data) has its own durable record under
 * `<environment>/migration/<kind>-v2.json`.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureDirectory, pathExists, removePath, tryReadJsonFile, writeJsonAtomic } from './fsx.js';
import { environmentPaths, generationPaths, type AppDataLayout } from './layout.js';

export type TreeKind = 'home' | 'data';
export type TreeMigrationState = 'copying' | 'copied' | 'finalized';

export interface TreeMigrationRecord {
  readonly schemaVersion: '1';
  readonly environmentId: string;
  readonly kind: TreeKind;
  readonly sourceGenerationId: string | null;
  readonly state: TreeMigrationState;
  readonly sourceDigest: string | null;
  readonly publishedDigest: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HomeMigrationFaults {
  /** Aborts after the copy is fsynced but before it is published. */
  readonly failAfterCopy?: boolean;
  /** Aborts after the published copy exists but before the legacy source is removed. */
  readonly failAfterPublish?: boolean;
  /** Corrupts the published target after publish (simulates truncation/loss). */
  readonly corruptPublished?: boolean;
}

export interface MigrateEnvironmentHomeOptions {
  readonly layout: AppDataLayout;
  readonly environmentId: string;
  readonly activeGenerationId: string | null;
  readonly clock?: () => Date;
  readonly faults?: HomeMigrationFaults;
}

export interface HomeMigrationResult {
  readonly state: 'finalized' | 'already-finalized' | 'interrupted' | 'conflict';
  readonly actions: readonly string[];
  /** Which tree conflicted and a secret/path-free reason. */
  readonly conflict?: { readonly kind: TreeKind; readonly reason: string };
}

interface TreeEntry {
  readonly path: string;
  readonly type: 'file' | 'dir' | 'link';
  readonly size?: number;
  readonly digest?: string;
  readonly target?: string;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Deterministic tree fingerprint. Directories and symlinks contribute their
 * type; files contribute size and content hash; symlinks contribute their target
 * string (never followed). `undefined` when the path does not exist.
 */
export const treeFingerprint = (root: string): string | undefined => {
  if (!pathExists(root)) {
    return undefined;
  }
  const entries: TreeEntry[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) {
        entries.push({ path: rel, type: 'link', target: readlinkSync(full) });
      } else if (stats.isDirectory()) {
        entries.push({ path: rel, type: 'dir' });
        walk(full, rel);
      } else if (stats.isFile()) {
        entries.push({ path: rel, type: 'file', size: stats.size, digest: sha256(readFileSync(full)) });
      } else {
        entries.push({ path: rel, type: 'dir' });
      }
    }
  };
  walk(root, '');
  return sha256(JSON.stringify(entries));
};

const fsyncFile = (path: string): void => {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const fsyncDirectory = (path: string): void => {
  try {
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Durability of the rename stays best-effort where the platform refuses.
  }
};

const fsyncTree = (root: string): void => {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      fsyncTree(full);
    } else if (stats.isFile()) {
      fsyncFile(full);
    }
  }
  fsyncDirectory(root);
};

export class HomeMigrationStore {
  readonly #layout: AppDataLayout;

  constructor(layout: AppDataLayout) {
    this.#layout = layout;
  }

  #path(environmentId: string, kind: TreeKind): string {
    return join(environmentPaths(this.#layout, environmentId).migrationDirectory, `${kind}-v2.json`);
  }

  read(environmentId: string, kind: TreeKind): TreeMigrationRecord | undefined {
    return tryReadJsonFile<TreeMigrationRecord>(this.#path(environmentId, kind));
  }

  write(record: TreeMigrationRecord): void {
    writeJsonAtomic(this.#path(record.environmentId, record.kind), record);
  }
}

const makeRecord = (
  environmentId: string,
  kind: TreeKind,
  sourceGenerationId: string | null,
  state: TreeMigrationState,
  sourceDigest: string | null,
  publishedDigest: string | null,
  createdAt: string,
  updatedAt: string,
): TreeMigrationRecord => ({
  schemaVersion: '1',
  environmentId,
  kind,
  sourceGenerationId,
  state,
  sourceDigest,
  publishedDigest,
  createdAt,
  updatedAt,
});

interface TreeOutcome {
  readonly outcome: 'finalized' | 'already-finalized' | 'interrupted' | 'conflict';
  readonly reason?: string;
  readonly actions: string[];
}

/** Migrate one tree (home or data). */
const migrateTree = (
  layout: AppDataLayout,
  environmentId: string,
  kind: TreeKind,
  sourceGenerationId: string | null,
  now: () => string,
  faults: HomeMigrationFaults,
): TreeOutcome => {
  const actions: string[] = [];
  const store = new HomeMigrationStore(layout);
  const environment = environmentPaths(layout, environmentId);
  const target = kind === 'home' ? environment.homeDirectory : environment.dataDirectory;
  const existing = store.read(environmentId, kind);
  const createdAt = existing?.createdAt ?? now();

  if (sourceGenerationId === null) {
    store.write(makeRecord(environmentId, kind, null, 'finalized', null, null, createdAt, now()));
    actions.push(`${kind}: empty environment -> finalized`);
    return { outcome: 'finalized', actions };
  }

  const paths = generationPaths(layout, environmentId, sourceGenerationId);
  const legacy = kind === 'home' ? paths.legacyHomeDirectory : paths.legacyDataDirectory;
  const temporary = join(environment.environmentDirectory, `.${kind}.migrating-${randomUUID()}`);
  const targetFingerprint = treeFingerprint(target);
  const record = existing;

  // A finalized tree is the live, mutable environment home/data; once finalized
  // the migration is complete and the legacy source is gone. Do not re-hash it:
  // the runtime legitimately writes new files after migration. The "never trust a
  // label, re-verify" rule applies to the pre-finalized states below, where the
  // legacy source would otherwise be deleted on the strength of the label alone.
  if (record?.state === 'finalized') {
    return { outcome: 'already-finalized', actions };
  }

  // Resume: the record claims a published copy. Never trust the label: the target
  // must exist and match the recorded digest before the legacy source is removed.
  if (record !== undefined && (record.state === 'copied' || record.state === 'copying')) {
    const legacyFingerprint = treeFingerprint(legacy);
    const sourceIntact = record.sourceDigest !== null && legacyFingerprint === record.sourceDigest;
    if (targetFingerprint !== undefined && record.publishedDigest === targetFingerprint) {
      // Verified own product. If the source is still intact, finish by removing it.
      if (legacyFingerprint === undefined) {
        store.write(makeRecord(environmentId, kind, sourceGenerationId, 'finalized', record.sourceDigest, record.publishedDigest, createdAt, now()));
        actions.push(`${kind}: verified published copy; legacy already gone; finalized`);
        return { outcome: 'finalized', actions };
      }
      if (sourceIntact) {
        removePath(legacy);
        store.write(makeRecord(environmentId, kind, sourceGenerationId, 'finalized', record.sourceDigest, record.publishedDigest, createdAt, now()));
        actions.push(`${kind}: verified published copy; legacy removed; finalized`);
        return { outcome: 'finalized', actions };
      }
      return { outcome: 'conflict', reason: `${kind}: legacy source changed after publication`, actions };
    }
    // The recorded published copy is missing or corrupt. Keep the legacy source
    // and never delete it; if the legacy source is byte-identical to what we
    // copied, we may safely discard our own orphan and republish it.
    if (targetFingerprint !== undefined && targetFingerprint !== record.publishedDigest) {
      return { outcome: 'conflict', reason: `${kind}: published directory is corrupt or foreign`, actions };
    }
    if (!sourceIntact) {
      return { outcome: 'conflict', reason: `${kind}: published directory missing and legacy source unverifiable`, actions };
    }
    removePath(temporary);
    actions.push(`${kind}: published copy missing; republishing from verified legacy source`);
  } else {
    // No usable record. A pre-existing target is not ours: never overwrite it.
    if (targetFingerprint !== undefined) {
      return { outcome: 'conflict', reason: `${kind}: environment directory already exists and is not a migration product`, actions };
    }
  }

  const legacyFingerprint = treeFingerprint(legacy);
  if (legacyFingerprint === undefined) {
    store.write(makeRecord(environmentId, kind, sourceGenerationId, 'finalized', null, null, createdAt, now()));
    actions.push(`${kind}: no legacy directory -> finalized`);
    return { outcome: 'finalized', actions };
  }

  ensureDirectory(environment.environmentDirectory);
  removePath(temporary);
  cpSync(legacy, temporary, { recursive: true, dereference: false, verbatimSymlinks: true });
  fsyncTree(temporary);
  const copied = treeFingerprint(temporary);
  if (copied !== legacyFingerprint) {
    removePath(temporary);
    return { outcome: 'conflict', reason: `${kind}: copy verification failed`, actions };
  }
  store.write(makeRecord(environmentId, kind, sourceGenerationId, 'copying', legacyFingerprint, null, createdAt, now()));
  if (faults.failAfterCopy === true) {
    actions.push(`${kind}: injected failure after copy (before publish)`);
    return { outcome: 'interrupted', reason: `${kind}: interrupted before publish`, actions };
  }

  renameSync(temporary, target);
  fsyncDirectory(environment.environmentDirectory);
  store.write(makeRecord(environmentId, kind, sourceGenerationId, 'copied', legacyFingerprint, legacyFingerprint, createdAt, now()));
  if (faults.failAfterPublish === true) {
    actions.push(`${kind}: injected failure after publish (legacy retained)`);
    return { outcome: 'interrupted', reason: `${kind}: interrupted after publish`, actions };
  }
  if (faults.corruptPublished === true && kind === 'home') {
    // Simulate a truncated/lost published copy. Keep the legacy source and fail
    // closed; a later run re-verifies and republishes from the intact legacy tree.
    removePath(target);
    actions.push(`${kind}: published copy lost/truncated; legacy retained`);
    return { outcome: 'conflict', reason: `${kind}: published copy lost or truncated`, actions };
  }

  removePath(legacy);
  store.write(makeRecord(environmentId, kind, sourceGenerationId, 'finalized', legacyFingerprint, legacyFingerprint, createdAt, now()));
  actions.push(`${kind}: migrated to environment scope; finalized`);
  return { outcome: 'finalized', actions };
};

/**
 * Migrates/converges an environment's home and data trees. Returns `conflict`
 * (with a path-free reason) when a safe automatic convergence is impossible; the
 * caller must then refuse runtime operations rather than risk data loss.
 */
export const migrateEnvironmentHome = (
  options: MigrateEnvironmentHomeOptions,
): HomeMigrationResult => {
  const now = (): string => (options.clock?.() ?? new Date()).toISOString();
  const actions: string[] = [];
  for (const kind of ['home', 'data'] as const) {
    const result = migrateTree(
      options.layout,
      options.environmentId,
      kind,
      options.activeGenerationId,
      now,
      options.faults ?? {},
    );
    actions.push(...result.actions);
    if (result.outcome === 'conflict') {
      return { state: 'conflict', actions, conflict: { kind, reason: result.reason ?? `${kind}: conflict` } };
    }
    if (result.outcome === 'interrupted') {
      return { state: 'interrupted', actions };
    }
  }
  return { state: 'finalized', actions };
};

export const readMigrationRecord = (
  layout: AppDataLayout,
  environmentId: string,
  kind: TreeKind,
): TreeMigrationRecord | undefined => new HomeMigrationStore(layout).read(environmentId, kind);
