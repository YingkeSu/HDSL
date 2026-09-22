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
import { closeSync, fsyncSync, openSync, readdirSync, renameSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ensureDirectory, pathExists, readJsonFile, removePath } from './fsx.js';
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
 * Fingerprint of the declaration source of a profile directory. Returns
 * `undefined` when the directory or its `package.json` is missing. Live derived
 * files (`cordis.yml`, `node_modules`) are excluded by construction.
 */
export const profileDeclarationFingerprint = (directory: string): string | undefined => {
  if (!pathExists(join(directory, 'package.json'))) {
    return undefined;
  }
  const entries: string[] = [];
  for (const name of PROFILE_DECLARATION_FILES) {
    const path = join(directory, name);
    if (!pathExists(path)) {
      continue;
    }
    const stats = lstatSync(path);
    if (!stats.isFile()) {
      continue;
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
 * `<env>/home/profiles/...`). Idempotent when the published copy already matches
 * the staged source. Never overwrites a mismatching published profile.
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
  // Publish the whole profile directory (declaration source + derived scaffolding)
  // by renaming the staged directory into place, then fsync the parent.
  renameSync(options.stagedDirectory, target);
  fsyncDirectory(profilesRoot);
  const fingerprint = profileDeclarationFingerprint(target);
  if (fingerprint !== stagedFingerprint) {
    throw new Error('published profile does not match the staged declaration source');
  }
  return { published: true, fingerprint, actions: [`published profile ${profileName}`] };
};

export interface CollectOrphanProfilesOptions {
  readonly layout: AppDataLayout;
  readonly environmentId: string;
  /** Profile names that must be retained (active + all retained generations). */
  readonly retain: ReadonlySet<string>;
}

/**
 * Removes managed-namespace profiles that are not retained. Never touches
 * non-managed names (e.g. `web` or user profiles) and never a retained profile.
 */
export const collectOrphanProfiles = (options: CollectOrphanProfilesOptions): readonly string[] => {
  const profilesRoot = environmentPaths(options.layout, options.environmentId).profilesDirectory;
  if (!pathExists(profilesRoot)) {
    return [];
  }
  const removed: string[] = [];
  for (const name of readdirSync(profilesRoot)) {
    if (!name.startsWith(PROFILE_NAMESPACE_PREFIX) || options.retain.has(name)) {
      continue;
    }
    removePath(join(profilesRoot, name));
    removed.push(name);
  }
  return removed;
};

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
