/**
 * Generation profile publication and identity (ADR 0006 §2.3 / S2 §1, P-A).
 *
 * Under the shared environment home, DSH resolves a profile at
 * `$DSH_HOME/profiles/<name>` (fixed rc.2). Each generation therefore owns a
 * profile in the managed namespace `hdsl-<generationId>`:
 *
 * - **Identity comes only from the immutable declaration source**
 *   (`package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml`, optional
 *   `pnpm-lock.yaml`). Boot-rewritten `cordis.yml` and `node_modules` are live,
 *   derived state and never enter the identity.
 * - **Publish from the staged source**, atomically (rename), before the active
 *   generation pointer is switched. A pre-existing published profile that is not
 *   byte-identical to the staged source is a conflict (never overwritten).
 * - **GC only removes this instance's own orphan profiles** in the managed
 *   namespace, and never one referenced by a retained or active generation.
 *
 * Fingerprints hash file contents for integrity but are never logged.
 */
import { closeSync, cpSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ensureDirectory, readJsonFile, removePath } from './fsx.js';
import { environmentPaths, generationPaths, type AppDataLayout } from './layout.js';

/** Files that constitute a profile's immutable declaration source, in order. */
export const PROFILE_DECLARATION_FILES = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
] as const;

/** Managed profile namespace: only these names may be published or collected. */
export const PROFILE_NAMESPACE_PREFIX = 'hdsl-';

export const managedProfileName = (generationId: string): string => `${PROFILE_NAMESPACE_PREFIX}${generationId}`;

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Fingerprint of the declaration source of a profile directory.
 *
 * - Returns `undefined` when the directory or its `package.json` is absent (no
 *   profile / no identity).
 * - **Fails closed** (throws) when `package.json` or any present declaration file
 *   is not a regular file (symlink, directory, special file): a non-regular
 *   declaration must never collapse into an empty/constant digest.
 * - Live derived files (`cordis.yml`, `node_modules`) are excluded by construction
 *   and are never a source of identity. `pnpm-lock.yaml` is optional: when absent
 *   the identity covers the present declaration files only; it is never rebuilt
 *   from the live install.
 */
export const profileDeclarationFingerprint = (directory: string): string | undefined => {
  const packageJsonPath = join(directory, 'package.json');
  let packageStats: ReturnType<typeof lstatSync>;
  try {
    packageStats = lstatSync(packageJsonPath);
  } catch {
    return undefined;
  }
  if (!packageStats.isFile()) {
    throw new Error('the profile declaration source package.json is not a regular file');
  }
  const entries: string[] = [];
  for (const name of PROFILE_DECLARATION_FILES) {
    const path = join(directory, name);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(path);
    } catch {
      // Optional declaration files may be absent; the required package.json is
      // already proven present and regular above.
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`the profile declaration file ${name} is not a regular file`);
    }
    entries.push(`${name}\u0000${String(stats.size)}\u0000${sha256(readFileSync(path))}`);
  }
  return sha256(entries.join('\n'));
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
    // Best-effort where the platform refuses directory fsync.
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
      const descriptor = openSync(full, 'r');
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  }
  fsyncDirectory(root);
};

export interface PublishProfileResult {
  readonly published: boolean;
  readonly fingerprint: string;
  readonly actions: readonly string[];
}

export interface PublishProfileOptions {
  readonly layout: AppDataLayout;
  readonly environmentId: string;
  readonly generationId: string;
  /** Staged declaration source (e.g. `<generation>/profile`). */
  readonly stagedDirectory: string;
}

/**
 * Publishes the staged profile into `$DSH_HOME/profiles/hdsl-<gen>` (resolved as
 * `<env>/home/profiles/...`).
 *
 * The staged directory is an **immutable declaration source** and is preserved:
 * publication COPIES it to an own temporary directory, verifies the copied
 * declaration source, fsyncs, then atomically renames it into place. A crash or
 * failure never destroys or mutates the staged source; a mismatching published
 * profile is never overwritten (fail-closed).
 */
export const publishGenerationProfile = (options: PublishProfileOptions): PublishProfileResult => {
  const profileName = managedProfileName(options.generationId);
  const profilesRoot = environmentPaths(options.layout, options.environmentId).profilesDirectory;
  const target = join(profilesRoot, profileName);
  const stagedFingerprint = profileDeclarationFingerprint(options.stagedDirectory);
  if (stagedFingerprint === undefined) {
    throw new Error('the staged profile has no declaration source');
  }
  const targetFingerprint = profileDeclarationFingerprint(target);
  if (targetFingerprint !== undefined) {
    if (targetFingerprint === stagedFingerprint) {
      return { published: true, fingerprint: stagedFingerprint, actions: ['published profile already matches'] };
    }
    throw new Error('a mismatching published profile already exists');
  }
  ensureDirectory(profilesRoot);
  const temporary = join(profilesRoot, `.publish-${profileName}-${randomUUID()}`);
  removePath(temporary);
  cpSync(options.stagedDirectory, temporary, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  fsyncTree(temporary);
  const copiedFingerprint = profileDeclarationFingerprint(temporary);
  if (copiedFingerprint !== stagedFingerprint) {
    removePath(temporary);
    throw new Error('the copied profile does not match the staged declaration source');
  }
  renameSync(temporary, target);
  fsyncDirectory(profilesRoot);
  const fingerprint = profileDeclarationFingerprint(target);
  if (fingerprint !== stagedFingerprint) {
    throw new Error('the published profile does not match the staged declaration source');
  }
  // The staged immutable source must survive publication unchanged. If it did
  // not, the environment would have no provenance for `restore`. Leave the
  // published profile but surface a controlled failure.
  if (profileDeclarationFingerprint(options.stagedDirectory) !== stagedFingerprint) {
    throw new Error('the staged declaration source changed during publication');
  }
  return { published: true, fingerprint, actions: [`published profile ${profileName}`] };
};

// NOTE (MF1): there is intentionally NO automatic orphan-profile GC here. A
// namespace-prefix + retain scan cannot prove provenance and could delete
// unrelated `hdsl-*` profiles or a just-published generation when the retain set
// is momentarily empty. Journal-keyed GC (only profiles a pending, uncommitted
// transaction published and that no retained/active generation references) is
// deferred to the full transaction wiring.

/** Reads the published profile name recorded for a generation, if any. */
export const readGenerationProfileName = (
  layout: AppDataLayout,
  environmentId: string,
  generationId: string,
): string | undefined => {
  const record = readJsonFile<{ profileName?: string }>(
    generationPaths(layout, environmentId, generationId).generationRecordPath,
  );
  return typeof record?.profileName === 'string' ? record.profileName : undefined;
};
