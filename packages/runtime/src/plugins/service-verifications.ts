/**
 * HDSL service-verification catalog (#77 S3, ADR 0005 D21).
 *
 * A minimal, READ-ONLY, in-repo catalog of independently reviewed verification
 * records. It exists because fixed rc.2 has no declarative server-side service
 * provider metadata (see ADR 0005 §9.5a): a plugin's provided Cordis services
 * live in code, so HDSL needs an explicit reviewed record before it can treat a
 * removed plugin's provider set as KNOWN.
 *
 * Rules (ADR 0005 D21):
 *   - a record only makes a declaration `known` when its `review.status` is
 *     `confirmed` AND `repository` + `commitSha` + `manifestSha256` match the
 *     installed generation exactly;
 *   - `known` with `provides: []` is a VERIFIED EMPTY set (removal may proceed
 *     when no retained consumer intersects);
 *   - anything else (no entry, pending review, commit/digest mismatch, malformed
 *     record) is `unknown` and MUST block the removal — an empty scan is never
 *     proof of safety;
 *   - there is deliberately NO runtime auto-trust: install can only match and
 *     persist existing verified facts, it never creates them.
 */
import { isPlainRecord } from '@hdsl/contracts';

export interface ServiceVerificationRecord {
  readonly pluginId: string;
  readonly repository: string;
  readonly commitSha: string;
  /** Digest of the reviewed package manifest at that exact commit. */
  readonly manifestSha256: string;
  /** Services the reviewed source provides; `[]` is a verified-empty set. */
  readonly provides: readonly string[];
  readonly review: {
    readonly status: 'confirmed' | 'pending';
    /** Review provenance: who/what reviewed which exact source. */
    readonly evidence: string;
  };
}

export interface ServiceVerificationQuery {
  readonly pluginId: string;
  readonly commitSha: string | null;
  readonly manifestSha256: string | null;
}

export type ServiceVerificationLookup =
  | { readonly status: 'known'; readonly provides: readonly string[] }
  | { readonly status: 'unknown'; readonly reason: string };

/**
 * Frozen records. `pending` entries are intentionally NOT trusted yet: they only
 * document the exact source that an independent review must confirm (and the
 * manifest digest that must be recorded with it).
 */
export const SERVICE_VERIFICATION_RECORDS: readonly ServiceVerificationRecord[] = [
  {
    pluginId: 'hdsl-plugin-e2e-fixture',
    repository: 'https://github.com/YingkeSu/hdsl-plugin-e2e-fixture',
    commitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838',
    // Filled only together with the confirmed review of that exact commit.
    manifestSha256: '',
    provides: [],
    review: {
      status: 'pending',
      evidence:
        'independent review must confirm, at exactly this commit, that the reviewed source provides no Cordis services, then record its manifest digest',
    },
  },
];

const isRecordShape = (value: unknown): value is ServiceVerificationRecord =>
  isPlainRecord(value) &&
  typeof value['pluginId'] === 'string' &&
  typeof value['repository'] === 'string' &&
  typeof value['commitSha'] === 'string' &&
  typeof value['manifestSha256'] === 'string' &&
  Array.isArray(value['provides']) &&
  (value['provides'] as unknown[]).every((entry) => typeof entry === 'string') &&
  isPlainRecord(value['review']) &&
  (value['review']['status'] === 'confirmed' || value['review']['status'] === 'pending') &&
  typeof value['review']['evidence'] === 'string';

/**
 * Looks up the reviewed provider set for an installed plugin. Strict matching:
 * a mismatch on commit or manifest digest is `unknown`, never "no services".
 */
export const lookupServiceVerification = (
  query: ServiceVerificationQuery,
  records: readonly ServiceVerificationRecord[] = SERVICE_VERIFICATION_RECORDS,
): ServiceVerificationLookup => {
  if (query.commitSha === null || query.manifestSha256 === null) {
    return { status: 'unknown', reason: 'the installed plugin has no recorded exact commit or manifest digest' };
  }
  const candidates = records.filter((record) => isRecordShape(record) && record.pluginId === query.pluginId);
  if (candidates.length === 0) {
    return { status: 'unknown', reason: 'no HDSL service verification record for this plugin' };
  }
  const matching = candidates.filter(
    (record) => record.commitSha === query.commitSha && record.manifestSha256 === query.manifestSha256,
  );
  if (matching.length === 0) {
    return {
      status: 'unknown',
      reason: 'the recorded verification does not match the installed exact commit and manifest digest',
    };
  }
  const confirmed = matching.find((record) => record.review.status === 'confirmed');
  if (confirmed === undefined) {
    return { status: 'unknown', reason: 'the service verification record is still pending independent review' };
  }
  return { status: 'known', provides: [...confirmed.provides] };
};
