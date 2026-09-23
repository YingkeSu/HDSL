/**
 * DSH-version ordering + restore compatibility warning (issue #114 / A2, D5/D6).
 *
 * These are pure, zero-I/O checks of the ordering and the warning decision, so
 * the downgrade explanation cannot drift from the semver-ish rules the runtime
 * catalog uses for DSH versions.
 */
import { describe, expect, it } from 'vitest';
import {
  compareDshVersions,
  dshCompatibilityWarning,
  parseDshVersion,
} from '@hdsl/core';

describe('compareDshVersions', () => {
  it('orders core versions numerically', () => {
    expect(compareDshVersions('0.1.5', '0.1.4')).toBeGreaterThan(0);
    expect(compareDshVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareDshVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareDshVersions('0.1.5', '0.1.5')).toBe(0);
  });

  it('orders prereleases below the release and by identifier rules', () => {
    expect(compareDshVersions('0.1.5', '0.1.5-rc.2')).toBeGreaterThan(0);
    expect(compareDshVersions('0.1.5-rc.2', '0.1.5-rc.10')).toBeLessThan(0);
    expect(compareDshVersions('0.1.5-rc.2', '0.1.5-alpha.1')).toBeGreaterThan(0);
    expect(compareDshVersions('0.1.5-rc', '0.1.5-rc.1')).toBeLessThan(0);
    // Numeric identifiers have lower precedence than alphanumeric ones.
    expect(compareDshVersions('0.1.5-1', '0.1.5-alpha')).toBeLessThan(0);
  });

  it('returns undefined for an unrecognized version instead of guessing', () => {
    expect(compareDshVersions('not-a-version', '0.1.5')).toBeUndefined();
    expect(compareDshVersions('0.1.5', 'v0.1.5')).toBeUndefined();
    expect(compareDshVersions('0.1', '0.1.5')).toBeUndefined();
    expect(parseDshVersion('0.1.5-rc.2')).toEqual({
      major: 0,
      minor: 1,
      patch: 5,
      prerelease: ['rc', 2],
    });
  });
});

describe('dshCompatibilityWarning', () => {
  it('warns only for a strict downgrade', () => {
    expect(
      dshCompatibilityWarning({ targetDshVersion: '0.1.5-rc.2', lastStartedDshVersion: '0.1.6' }),
    ).toContain('0.1.5-rc.2');
    expect(
      dshCompatibilityWarning({ targetDshVersion: '0.1.6', lastStartedDshVersion: '0.1.5-rc.2' }),
    ).toBeUndefined();
    // Same version: the Node-only axis must NOT warn.
    expect(
      dshCompatibilityWarning({ targetDshVersion: '0.1.5-rc.2', lastStartedDshVersion: '0.1.5-rc.2' }),
    ).toBeUndefined();
  });

  it('never warns when either side is unknown or unparseable', () => {
    expect(dshCompatibilityWarning({ targetDshVersion: undefined, lastStartedDshVersion: '0.1.6' })).toBeUndefined();
    expect(dshCompatibilityWarning({ targetDshVersion: '0.1.5-rc.2', lastStartedDshVersion: null })).toBeUndefined();
    expect(dshCompatibilityWarning({ targetDshVersion: '0.1.5-rc.2', lastStartedDshVersion: undefined })).toBeUndefined();
    expect(
      dshCompatibilityWarning({ targetDshVersion: 'garbage', lastStartedDshVersion: '0.1.6' }),
    ).toBeUndefined();
  });
});
