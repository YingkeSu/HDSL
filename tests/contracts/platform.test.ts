/**
 * Host-platform resolution and the platform gate (#107 host wiring).
 *
 * The production desktop entry must report the real `process.platform` /
 * `process.arch`. `resolveHostPlatform` is the only narrowing seam: an unknown
 * value (Node's `freebsd`, `openharmony`, `ia32`, …) must return `undefined`
 * instead of being coerced to the verified darwin/arm64 host, and the
 * dispatcher must then refuse create/switch for that unknown host.
 */
import {
  combinationsForHost,
  isHostPlatformSupported,
  isTargetedAtHost,
  resolveHostPlatform,
  unsupportedCombinationReason,
  type HostPlatform,
} from '@hdsl/contracts';
import { FIXTURE_IDS, FIXTURE_SEED } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';

const darwinArm64Combination = FIXTURE_SEED.catalog[0];
if (darwinArm64Combination === undefined) {
  throw new Error('the contract fixture seed must carry at least one combination');
}

const knownButUnverifiedHosts: readonly HostPlatform[] = [
  { platform: 'win32', arch: 'x64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'arm64' },
];

const unknownPairs: ReadonlyArray<readonly [string, string]> = [
  ['freebsd', 'x64'],
  ['openbsd', 'x64'],
  ['android', 'arm64'],
  ['openharmony', 'arm64'],
  ['aix', 'ppc64'],
  ['darwin', 'ia32'],
  ['darwin', 'riscv64'],
  ['win32', 'ppc64'],
  ['', ''],
];

describe('resolveHostPlatform', () => {
  it('resolves the verified host without a cast', () => {
    expect(resolveHostPlatform('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'arm64' });
  });

  it.each(knownButUnverifiedHosts)(
    'resolves the known-but-unverified host $platform/$arch',
    (host) => {
      expect(resolveHostPlatform(host.platform, host.arch)).toEqual(host);
      // Known vocabulary is not a support claim: only darwin/arm64 is verified.
      expect(isHostPlatformSupported(host)).toBe(false);
    },
  );

  it.each(unknownPairs)(
    'returns undefined for the unknown pair %s/%s instead of darwin',
    (platform, arch) => {
      expect(resolveHostPlatform(platform, arch)).toBeUndefined();
    },
  );
});

describe('unsupportedCombinationReason with an unresolved host', () => {
  it('fails closed when the host is unknown', () => {
    const reason = unsupportedCombinationReason(undefined, darwinArm64Combination);
    expect(reason).toBeDefined();
    expect(reason).toMatch(/host platform could not be resolved/);
  });

  it('keeps the real verified host success', () => {
    expect(
      unsupportedCombinationReason({ platform: 'darwin', arch: 'arm64' }, darwinArm64Combination),
    ).toBeUndefined();
  });

  it.each(knownButUnverifiedHosts)(
    'rejects the simulated non-darwin host $platform/$arch on this CI host',
    (host) => {
      expect(unsupportedCombinationReason(host, darwinArm64Combination)).toMatch(
        /is not verified for this build/,
      );
    },
  );
});

/**
 * #147: the installable surface must be filtered by the REAL host, so a Windows
 * build never offers the darwin/arm64 combinations as installable.
 */
describe('combinationsForHost', () => {
  it('matches a combination target only on the exact host pair', () => {
    expect(isTargetedAtHost({ platform: 'darwin', arch: 'arm64' }, darwinArm64Combination)).toBe(
      true,
    );
    expect(isTargetedAtHost({ platform: 'darwin', arch: 'x64' }, darwinArm64Combination)).toBe(
      false,
    );
    expect(isTargetedAtHost({ platform: 'win32', arch: 'arm64' }, darwinArm64Combination)).toBe(
      false,
    );
  });

  it('keeps only combinations targeting the verified host', () => {
    const ids = combinationsForHost(
      { platform: 'darwin', arch: 'arm64' },
      FIXTURE_SEED.catalog,
    ).map((entry) => entry.id);
    expect(ids).toContain(FIXTURE_IDS.combination.verified);
    expect(ids).not.toContain(FIXTURE_IDS.combination.win32);
  });

  it.each(knownButUnverifiedHosts)(
    'is empty for the known-but-unverified host $platform/$arch (not an untested success)',
    (host) => {
      expect(combinationsForHost(host, FIXTURE_SEED.catalog)).toEqual([]);
    },
  );

  it('is empty for an unresolved host instead of falling back to darwin', () => {
    expect(combinationsForHost(undefined, FIXTURE_SEED.catalog)).toEqual([]);
  });
});
