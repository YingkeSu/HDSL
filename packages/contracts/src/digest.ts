/**
 * Composition digest input projection and canonical JSON encoding.
 *
 * data-model.md freezes the digest input as the canonical JSON of the
 * CompositionLock **subset** `schemaVersion`, `node`, `dsh` and the sorted
 * `plugins`, where node/dsh contribute only version/platform/arch/sha256.
 *
 * Issue #15 N3: the lock keeps download provenance in `sources`, but a URL
 * must never influence the digest. `compositionDigestInput` is the executable
 * boundary for that rule; T004 applies SHA-256 to the canonical bytes and
 * persists the result (this module stays platform-agnostic and does not hash).
 */
import type { CompositionLock, PluginLock, RuntimeArtifactRef } from './dto.js';

export interface CompositionDigestInput {
  readonly schemaVersion: string;
  readonly node: RuntimeArtifactRef;
  readonly dsh: RuntimeArtifactRef;
  readonly plugins: readonly PluginLock[];
}

/** UTF-8 bytes without depending on Node or browser globals. */
const utf8Bytes = (value: string): readonly number[] => {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
};

const compareUtf8Bytes = (left: string, right: string): number => {
  const a = utf8Bytes(left);
  const b = utf8Bytes(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return a.length - b.length;
};

/**
 * Canonical JSON for a digest: object keys sorted by UTF-8 byte order, no
 * insignificant whitespace, arrays kept in their semantic order.
 */
export const canonicalizeJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalizeJson: numbers must be finite');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8Bytes);
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`,
    );
    return `{${entries.join(',')}}`;
  }
  throw new TypeError('canonicalizeJson: unsupported value');
};

const artifactRefSubset = (ref: RuntimeArtifactRef): RuntimeArtifactRef => ({
  version: ref.version,
  platform: ref.platform,
  arch: ref.arch,
  sha256: ref.sha256,
});

const comparePluginLocks = (left: PluginLock, right: PluginLock): number => {
  const byId = compareUtf8Bytes(left.id, right.id);
  if (byId !== 0) {
    return byId;
  }
  const byVersion = compareUtf8Bytes(left.version, right.version);
  return byVersion !== 0 ? byVersion : compareUtf8Bytes(left.sha256, right.sha256);
};

/**
 * Projects a lock onto the digest subset. Extra fields such as `sources`
 * (download URLs) and any future non-digest metadata are dropped here.
 */
export const compositionDigestInput = (lock: CompositionLock): CompositionDigestInput => ({
  schemaVersion: lock.schemaVersion,
  node: artifactRefSubset(lock.node),
  dsh: artifactRefSubset(lock.dsh),
  plugins: [...lock.plugins].sort(comparePluginLocks),
});

/** Canonical bytes T004 hashes with SHA-256. */
export const serializeCompositionDigestInput = (lock: CompositionLock): string =>
  canonicalizeJson(compositionDigestInput(lock));
