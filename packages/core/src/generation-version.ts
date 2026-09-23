/**
 * Generation DSH-version bookkeeping and the non-blocking restore compatibility
 * warning (issue #114 / A2, decisions D5/D6).
 *
 * HDSL does NOT claim cross-version home/data compatibility. Two facts are
 * recorded instead, so a downgrade can be explained without blocking it:
 *
 * - each generation records the exact DSH version it was installed with
 *   (`generation.json.dshVersion`, additive; absent on older records);
 * - the environment records the generation and DSH version of its last
 *   SUCCESSFUL managed start (`environment.json.lastStarted*`, additive).
 *
 * A restore to a generation whose DSH version is strictly OLDER than the last
 * successfully started DSH version produces a bounded, path-free warning. The
 * Node-only axis (same DSH version) never warns, and an unknown version on
 * either side never warns: unknown is not evidence of incompatibility.
 */
import { tryReadJsonFile } from './fsx.js';
import { generationPaths, type AppDataLayout } from './layout.js';

export interface DshVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

/** Strict semver-ish shape: `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const parseDshVersion = (version: string): DshVersionParts | undefined => {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) {
    return undefined;
  }
  const prerelease = match[4];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease:
      prerelease === undefined
        ? []
        : prerelease.split('.').map((identifier) => (/^\d+$/.test(identifier) ? Number(identifier) : identifier)),
  };
};

const comparePrerelease = (
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number => {
  // No prerelease has higher precedence than any prerelease (semver §11).
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    if (a === b) {
      continue;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      return a < b ? -1 : 1;
    }
    if (typeof a === 'number') {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return -1;
    }
    if (typeof b === 'number') {
      return 1;
    }
    return a < b ? -1 : 1;
  }
  return 0;
};

/**
 * Total order over two DSH versions: negative when `left < right`, positive when
 * `left > right`, `0` when equal. Returns `undefined` when either version is not
 * a recognized `MAJOR.MINOR.PATCH[-PRERELEASE]` string, so callers never invent
 * an ordering they cannot justify.
 */
export const compareDshVersions = (left: string, right: string): number | undefined => {
  const a = parseDshVersion(left);
  const b = parseDshVersion(right);
  if (a === undefined || b === undefined) {
    return undefined;
  }
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
};

/**
 * Reads the DSH version recorded for one generation. Prefers the durable
 * `generation.json.dshVersion`; falls back to the install manifest (the same
 * version the composition lock pinned) for records written before the field
 * existed. Returns `undefined` when neither records a version.
 */
export const readGenerationDshVersion = (
  layout: AppDataLayout,
  environmentId: string,
  generationId: string,
): string | undefined => {
  const paths = generationPaths(layout, environmentId, generationId);
  const record = tryReadJsonFile<{ dshVersion?: unknown }>(paths.generationRecordPath);
  if (typeof record?.dshVersion === 'string' && record.dshVersion.length > 0) {
    return record.dshVersion;
  }
  const manifest = tryReadJsonFile<{ dsh?: { version?: unknown } }>(paths.manifestPath);
  return typeof manifest?.dsh?.version === 'string' && manifest.dsh.version.length > 0
    ? manifest.dsh.version
    : undefined;
};

/**
 * Non-blocking downgrade warning. `undefined` when there is nothing honest to
 * warn about: same or newer target, or an unknown version on either side.
 */
export const dshCompatibilityWarning = (input: {
  readonly targetDshVersion: string | undefined;
  readonly lastStartedDshVersion: string | null | undefined;
}): string | undefined => {
  if (input.targetDshVersion === undefined || input.lastStartedDshVersion == null) {
    return undefined;
  }
  const order = compareDshVersions(input.targetDshVersion, input.lastStartedDshVersion);
  if (order === undefined || order >= 0) {
    return undefined;
  }
  return `the target generation runs DSH ${input.targetDshVersion}, older than the last successfully started DSH ${input.lastStartedDshVersion}; workspace data written by the newer version is not guaranteed to be compatible`;
};
