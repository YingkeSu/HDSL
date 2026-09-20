/**
 * Composition lock construction, canonical digest and integrity checks.
 *
 * The digest is computed over `serializeCompositionDigestInput(lock)` — the
 * frozen canonical JSON of `schemaVersion`, the node/dsh `version/platform/arch/
 * sha256` subset and the sorted plugins. Download URLs (`sources`) never enter
 * the digest, so a mirror change cannot change the composition identity. The
 * encoding is pure UTF-8 + SHA-256, so the same semantic composition yields the
 * same digest on every platform.
 */
import { createHash } from 'node:crypto';
import {
  compositionLockSchema,
  portFail,
  portOk,
  serializeCompositionDigestInput,
  type CompositionLock,
  type PortOutcome,
  type RuntimeCombination,
  type ValidationIssue,
} from '@hdsl/contracts';

export const computeCompositionDigest = (lock: CompositionLock): string =>
  createHash('sha256').update(serializeCompositionDigestInput(lock), 'utf8').digest('hex');

/** Builds the immutable lock a combination resolves to. */
export const resolveComposition = (combination: RuntimeCombination): PortOutcome<CompositionLock> => {
  const lock: CompositionLock = {
    schemaVersion: '1',
    node: {
      version: combination.node.version,
      platform: combination.platform,
      arch: combination.arch,
      sha256: combination.node.sha256,
    },
    dsh: {
      version: combination.dsh.version,
      platform: combination.platform,
      arch: combination.arch,
      sha256: combination.dsh.sha256,
    },
    plugins: [],
    sources: {
      node: {
        url: combination.artifactLocations.node.url,
        sha256: combination.artifactLocations.node.sha256,
      },
      dsh: {
        url: combination.artifactLocations.dsh.url,
        sha256: combination.artifactLocations.dsh.sha256,
      },
    },
  };
  const issues: ValidationIssue[] = [];
  const parsed = compositionLockSchema(lock, 'compositionLock', issues);
  if (parsed === undefined) {
    return portFail('INTERNAL_ERROR', 'catalog combination could not be turned into a composition lock');
  }
  const mismatch =
    parsed.node.sha256 !== combination.artifactLocations.node.sha256 ||
    parsed.dsh.sha256 !== combination.artifactLocations.dsh.sha256 ||
    parsed.node.version !== combination.artifactLocations.node.version ||
    parsed.dsh.version !== combination.artifactLocations.dsh.version;
  return mismatch
    ? portFail('INTERNAL_ERROR', 'composition lock does not match the catalog artifact locations')
    : portOk(parsed);
};

/** True when the lock's own refs and sources are internally consistent. */
export const isCompositionLockConsistent = (lock: CompositionLock): boolean =>
  lock.node.sha256 === lock.sources.node.sha256 && lock.dsh.sha256 === lock.sources.dsh.sha256;
