/**
 * The audited DSH dependency closure.
 *
 * `@deepseek-ai/dsh@0.1.5-rc.2` declares ~60 direct dependencies and resolves
 * to 585 packages, so installing only the top-level tarball does not produce a
 * runnable CLI. The frozen `CompositionLock` shape has no field for a transitive
 * tree, so the closure is shipped as an internal catalog asset next to the
 * catalog module instead:
 *
 * ```text
 * packages/runtime/catalog/dsh-0.1.5-rc.2/
 *   package.json       canonical npm root project
 *   package-lock.json  lockfileVersion 3, integrity for every package
 *   closure.json       binding metadata (dsh sha256 + lock sha256 + tool versions)
 * ```
 *
 * The installer copies package.json + package-lock.json into the generation and
 * runs the managed Node's `npm ci`, so the closure is exact and every tarball's
 * npm `integrity` is verified by npm. `closure.json` binds the asset to the
 * catalog's audited DSH bytes and records the lock hash, so replacing the lock
 * cannot silently change what a rebuild installs: a swapped lock fails the
 * recorded-hash check before `npm ci` runs.
 *
 * Resolved relative to this module (`../../catalog/...`) so both the TypeScript
 * source and the compiled `dist` tree read the same asset directory.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface DependencyClosureMetadata {
  readonly dshVersion: string;
  readonly dshSha256: string;
  readonly lockSha256: string;
  readonly packageCount: number;
  readonly rootResolved: string;
  readonly rootIntegritySha512: string;
  readonly generatedWith: { readonly node: string; readonly npm: string };
  readonly catalogRevision: string;
}

export interface DependencyClosure extends DependencyClosureMetadata {
  /** The canonical `package.json` copied into the generation. */
  readonly packageJson: string;
  /** The exact `package-lock.json` copied into the generation. */
  readonly lockFile: string;
  readonly assetDirectory: string;
  /** SHA-256 recomputed from the shipped lock bytes. */
  readonly actualLockSha256: string;
}

export const closureAssetDirectory = (dshVersion: string): string =>
  fileURLToPath(new URL(`../../catalog/dsh-${dshVersion}`, import.meta.url));

const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

export const sha256Hex = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * Loads the closure asset for `dshVersion`, or `undefined` when none is
 * shipped. Throws when the shipped lock no longer matches its recorded hash.
 */
export const readDependencyClosure = (dshVersion: string): DependencyClosure | undefined => {
  const assetDirectory = closureAssetDirectory(dshVersion);
  const metadataRaw = readIfPresent(`${assetDirectory}/closure.json`);
  const packageJson = readIfPresent(`${assetDirectory}/package.json`);
  const lockFile = readIfPresent(`${assetDirectory}/package-lock.json`);
  if (metadataRaw === undefined || packageJson === undefined || lockFile === undefined) {
    return undefined;
  }
  const metadata = JSON.parse(metadataRaw) as DependencyClosureMetadata;
  const actualLockSha256 = sha256Hex(lockFile);
  if (actualLockSha256 !== metadata.lockSha256) {
    throw new Error(
      `dependency closure lock for dsh ${dshVersion} changed (expected ${metadata.lockSha256}, found ${actualLockSha256})`,
    );
  }
  return { ...metadata, packageJson, lockFile, assetDirectory, actualLockSha256 };
};
