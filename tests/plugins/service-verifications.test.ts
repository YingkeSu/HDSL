/**
 * #77 S3 / ADR 0005 D21: the reviewed service-verification catalog is the ONLY
 * way a plugin's provider set becomes `known`. Strict binding: commit + manifest
 * digest + confirmed review. Everything else is unknown (must block).
 */
import { describe, expect, it } from 'vitest';
import { lookupServiceVerification, type ServiceVerificationRecord } from '@hdsl/runtime';

const RUNTIME = { dshVersion: '0.1.5-rc.2', dshSha256: 'f'.repeat(64), loaderVersion: '1.0.3', cordisVersion: '4.0.2' };

const CONFIRMED: ServiceVerificationRecord = {
  pluginId: 'demo-plugin',
  repository: 'https://example.invalid/demo',
  commitSha: 'a'.repeat(40),
  manifestSha256: 'b'.repeat(64),
  provides: [],
  runtime: RUNTIME,
  review: { status: 'confirmed', evidence: 'independent review of exact source at commit' },
};

const PENDING: ServiceVerificationRecord = { ...CONFIRMED, review: { status: 'pending', evidence: 'awaiting review' } };

const query = { pluginId: 'demo-plugin', commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), runtime: RUNTIME };

describe('lookupServiceVerification', () => {
  it('returns known-empty for a confirmed record at the exact commit and digest', () => {
    const lookup = lookupServiceVerification(query, [CONFIRMED]);
    expect(lookup.status).toBe('known');
    if (lookup.status === 'known') expect(lookup.provides).toEqual([]);
  });

  it('treats a pending review, a missing record, or a binding mismatch as unknown', () => {
    expect(lookupServiceVerification(query, [PENDING]).status).toBe('unknown');
    expect(lookupServiceVerification(query, []).status).toBe('unknown');
    expect(lookupServiceVerification({ ...query, commitSha: 'c'.repeat(40) }, [CONFIRMED]).status).toBe('unknown');
    expect(lookupServiceVerification({ ...query, manifestSha256: 'd'.repeat(64) }, [CONFIRMED]).status).toBe('unknown');
    expect(lookupServiceVerification({ ...query, commitSha: null }, [CONFIRMED]).status).toBe('unknown');
    expect(lookupServiceVerification({ ...query, runtime: null }, [CONFIRMED]).status).toBe('unknown');
  });

  it("does not stay confirmed under a different managed runtime/loader identity", () => {
    const runtime = { dshVersion: '0.1.5-rc.2', dshSha256: 'f'.repeat(64), loaderVersion: '1.0.3', cordisVersion: '4.0.2' };
    for (const drifted of [
      { ...runtime, dshVersion: '0.1.6' },
      { ...runtime, dshSha256: 'e'.repeat(64) },
      { ...runtime, loaderVersion: '1.0.4' },
      { ...runtime, cordisVersion: '4.1.0' },
    ]) {
      const lookup = lookupServiceVerification({ ...query, runtime: drifted }, [CONFIRMED]);
      expect(lookup.status).toBe('unknown');
      if (lookup.status === 'unknown') expect(lookup.reason).toContain('runtime');
    }
  });

  it('resolves the controlled fixture to a VERIFIED EMPTY provider set (hdsl-33 confirmed)', () => {
    const exact = 'ee613a2eb425a24bc44e946d84e36b7ceb2f594f1214913ff34dd0d0e450ba5c';
    const runtime = {
      dshVersion: '0.1.5-rc.2',
      dshSha256: 'f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480',
      loaderVersion: '1.0.3',
      cordisVersion: '4.0.2',
    };
    const lookup = lookupServiceVerification(
      { pluginId: 'hdsl-plugin-e2e-fixture', commitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838', manifestSha256: exact, runtime },
    );
    expect(lookup.status).toBe('known');
    if (lookup.status === 'known') expect(lookup.provides).toEqual([]);

    // Any other digest/commit is a different (unreviewed) source => unknown.
    expect(
      lookupServiceVerification(
        { pluginId: 'hdsl-plugin-e2e-fixture', commitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838', manifestSha256: 'f'.repeat(64), runtime },
      ).status,
    ).toBe('unknown');
    expect(
      lookupServiceVerification(
        { pluginId: 'hdsl-plugin-e2e-fixture', commitSha: 'a'.repeat(40), manifestSha256: exact, runtime },
      ).status,
    ).toBe('unknown');
  });
});
