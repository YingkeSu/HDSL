/**
 * Crash-safe first-time migration from the pre-ADR-0006 per-generation home
 * (`<generation>/home`) to the environment-scoped shared home
 * (`<environment>/home`).
 *
 * ADR 0006 / S2 §1.1. The migration runs before any `start`/`create`/`apply` for
 * an environment and is idempotent, so a crash at any point is recoverable by
 * running it again:
 *
 * - copy to a temporary directory inside the environment, fsync the tree, then
 *   atomically publish it with a single `rename` to `<environment>/home`;
 * - the durable flag records the state (`copying` -> `copied` -> `finalized`);
 * - the legacy home is removed only after the published copy exists;
 * - the secret-shaped `.credentials.yaml` is copied with its mode preserved and
 *   its contents are never read.
 *
 * The environment-scoped home is written only here and at environment commit;
 * no other path writes it before this migration finalizes.
 */
import { closeSync, cpSync, fsyncSync, openSync, readdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ensureDirectory, pathExists, removePath, tryReadJsonFile, writeJsonAtomic } from './fsx.js';
import { environmentPaths, generationPaths, type AppDataLayout } from './layout.js';

export type HomeMigrationState = 'copying' | 'copied' | 'finalized';

export interface HomeMigrationRecord {
  readonly schemaVersion: '1';
  readonly environmentId: string;
  readonly sourceGenerationId: string | null;
  readonly state: HomeMigrationState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HomeMigrationFaults {
  /** Aborts after the copy is fsynced but before it is published. */
  readonly failAfterCopy?: boolean;
  /** Aborts after the published copy exists but before the legacy home is removed. */
  readonly failAfterPublish?: boolean;
}

export interface MigrateEnvironmentHomeOptions {
  readonly layout: AppDataLayout;
  readonly environmentId: string;
  readonly activeGenerationId: string | null;
  readonly clock?: () => Date;
  readonly faults?: HomeMigrationFaults;
}

export interface HomeMigrationResult {
  readonly state: 'finalized' | 'already-finalized' | 'interrupted';
  readonly actions: readonly string[];
}

const fsyncFile = (path: string): void => {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

/** Best-effort directory fsync; some platforms refuse it, which is acceptable. */
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
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      fsyncTree(full);
    } else if (entry.isFile()) {
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

  #path(environmentId: string): string {
    return environmentPaths(this.#layout, environmentId).migrationPath;
  }

  read(environmentId: string): HomeMigrationRecord | undefined {
    return tryReadJsonFile<HomeMigrationRecord>(this.#path(environmentId));
  }

  write(record: HomeMigrationRecord): void {
    writeJsonAtomic(this.#path(record.environmentId), record);
  }
}

const record = (
  environmentId: string,
  sourceGenerationId: string | null,
  state: HomeMigrationState,
  createdAt: string,
  updatedAt: string,
): HomeMigrationRecord => ({
  schemaVersion: '1',
  environmentId,
  sourceGenerationId,
  state,
  createdAt,
  updatedAt,
});

/**
 * Migrates one environment's home to the environment-scoped layout, or resumes
 * an interrupted migration. Returns `already-finalized` when there is nothing
 * to do. Never throws for an empty/new environment.
 */
export const migrateEnvironmentHome = (
  options: MigrateEnvironmentHomeOptions,
): HomeMigrationResult => {
  const { layout, environmentId, activeGenerationId } = options;
  const now = (): string => (options.clock?.() ?? new Date()).toISOString();
  const store = new HomeMigrationStore(layout);
  const existing = store.read(environmentId);
  const actions: string[] = [];

  if (existing?.state === 'finalized') {
    return { state: 'already-finalized', actions };
  }

  const createdAt = existing?.createdAt ?? now();
  const sourceGenerationId = existing?.sourceGenerationId ?? activeGenerationId;

  // Empty environment (no active generation) or a brand-new environment with no
  // legacy home: nothing to move, but record `finalized` so this is not retried.
  if (sourceGenerationId === null) {
    store.write(record(environmentId, null, 'finalized', createdAt, now()));
    actions.push('empty environment -> finalized');
    return { state: 'finalized', actions };
  }

  const environment = environmentPaths(layout, environmentId);
  const legacyHome = generationPaths(layout, environmentId, sourceGenerationId).legacyHomeDirectory;
  const target = environment.homeDirectory;
  const temporary = join(environment.environmentDirectory, `.home.migrating-${randomUUID()}`);

  // Resume: a published copy already exists (flag `copied`, or `copying` where the
  // rename completed but the flag write did not). Finish removing the legacy home.
  if (existing?.state === 'copied' || (existing?.state === 'copying' && !pathExists(temporary) && pathExists(target))) {
    removePath(legacyHome);
    store.write(record(environmentId, sourceGenerationId, 'finalized', createdAt, now()));
    actions.push('published copy found; legacy home removed; finalized');
    return { state: 'finalized', actions };
  }

  if (!pathExists(legacyHome)) {
    store.write(record(environmentId, sourceGenerationId, 'finalized', createdAt, now()));
    actions.push('no legacy home -> finalized');
    return { state: 'finalized', actions };
  }

  ensureDirectory(environment.environmentDirectory);
  removePath(temporary);
  cpSync(legacyHome, temporary, { recursive: true });
  fsyncTree(temporary);
  store.write(record(environmentId, sourceGenerationId, 'copying', createdAt, now()));
  if (options.faults?.failAfterCopy === true) {
    actions.push('injected failure after copy (before publish)');
    return { state: 'interrupted', actions };
  }

  removePath(target);
  renameSync(temporary, target);
  store.write(record(environmentId, sourceGenerationId, 'copied', createdAt, now()));
  if (options.faults?.failAfterPublish === true) {
    actions.push('injected failure after publish (legacy home retained)');
    return { state: 'interrupted', actions };
  }

  removePath(legacyHome);
  store.write(record(environmentId, sourceGenerationId, 'finalized', createdAt, now()));
  actions.push('legacy home migrated to environment home; finalized');
  return { state: 'finalized', actions };
};
