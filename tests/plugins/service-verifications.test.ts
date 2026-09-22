/**
 * #77 S3 / ADR 0005 D21: the reviewed service-verification catalog is the ONLY
 * way a plugin's provider set becomes `known`. Strict binding: commit + manifest
 * digest + confirmed review. Everything else is unknown (must block).
 */
import { describe, expect, it } from 'vitest';
import { lookupServiceVerification, type ServiceVerificationRecord } from '@hdsl/runtime';

const CONFIRMED: ServiceVerificationRecord = {
  pluginId: 'demo-plugin',
  repository: 'https://example.invalid/demo',
  commitSha: 'a'.repeat(40),
  manifestSha256: 'b'.repeat(64),
  provides: [],
  review: { status: 'confirmed', evidence: 'independent review of exact source at commit' },
};

const PENDING: ServiceVerificationRecord = { ...CONFIRMED, review: { status: 'pending', evidence: 'awaiting review' } };

const query = { pluginId: 'demo-plugin', commitSha: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };

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
  });

  it('ships the controlled fixture entry as pending (no auto-trust)', () => {
    // The real fixture record must stay unknown until an independent review
    // confirms the exact commit and its manifest digest is recorded.
    const lookup = lookupServiceVerification(
      { pluginId: 'hdsl-plugin-e2e-fixture', commitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838', manifestSha256: 'f'.repeat(64) },
    );
    expect(lookup.status).toBe('unknown');
  });
});
