/**
 * HDSL service-verification catalog (#77 S3, ADR 0005 D21).
 *
 * A minimal, READ-ONLY, in-repo catalog of independently reviewed verification
 * records. It exists because fixed rc.2 has no declarative server-side service
 * provider metadata (see ADR 0005 §9.5a): a plugin's provided Cordis services
 * live in code, so HDSL needs an explicit reviewed record before it can treat a
 * removed plugin's provider set as KNOWN.
 *
 * Rules (ADR 0005 D21, informational since #112):
 *   - a record only makes a declaration `known` when its `review.status` is
 *     `confirmed` AND `repository` + `commitSha` + `manifestSha256` match the
 *     installed generation exactly;
 *   - `known` with `provides: []` is a VERIFIED EMPTY set;
 *   - anything else (no entry, pending review, commit/digest mismatch, malformed
 *     record) is `unknown`. The old policy "unknown MUST block the removal" was
 *     superseded by #112: this lookup is now an INFORMATIONAL fact reported in
 *     `riskItems`, never a removal blocker;
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
  /** Runtime/loader identity the review is valid under (exact match required). */
  readonly runtime: ServiceVerificationRuntime;
  readonly review: {
    readonly status: 'confirmed' | 'pending';
    /** Review provenance: who/what reviewed which exact source. */
    readonly evidence: string;
  };
}

/**
 * Runtime identity the record is valid under. The dynamic-load conclusion comes
 * from the managed loader/cordis source semantics, so a different runtime or
 * loader version invalidates it (no cross-version support this cycle).
 */
export interface ServiceVerificationRuntime {
  readonly dshVersion: string;
  readonly dshSha256: string;
  readonly loaderVersion: string;
  readonly cordisVersion: string;
}

export interface ServiceVerificationQuery {
  readonly pluginId: string;
  readonly commitSha: string | null;
  readonly manifestSha256: string | null;
  /** Current managed generation's runtime identity (from its install manifest + install tree). */
  readonly runtime: ServiceVerificationRuntime | null;
}

export type ServiceVerificationLookup =
  | { readonly status: 'known'; readonly provides: readonly string[] }
  | { readonly status: 'unknown'; readonly reason: string };

/**
 * Frozen records. `pending` entries are intentionally NOT trusted yet: they only
 * document the exact source that an independent review must confirm (and the
 * manifest digest that must be recorded with it).
 *
 * The matching evidence files live in `catalog/service-verifications/<plugin>.json`
 * (per-file and manifest SHA-256 of the reviewed exact commit, plus provenance), and
 * the durable, reviewable record is
 * `docs/development/plugin-remove-service-verification.md`.
 */
export const SERVICE_VERIFICATION_RECORDS: readonly ServiceVerificationRecord[] = [
  {
    pluginId: 'hdsl-plugin-e2e-fixture',
    repository: 'https://github.com/YingkeSu/hdsl-plugin-e2e-fixture',
    commitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838',
    // Exact package.json digest of that commit, read-only fetched; the record
    // stays `pending` until hdsl-33 confirms the reviewed source provides no
    // services. Evidence: catalog/service-verifications/hdsl-plugin-e2e-fixture.json
    manifestSha256: 'ee613a2eb425a24bc44e946d84e36b7ceb2f594f1214913ff34dd0d0e450ba5c',
    runtime: {
      dshVersion: '0.1.5-rc.2',
      dshSha256: 'f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480',
      loaderVersion: '1.0.3',
      cordisVersion: '4.0.2',
    },
    provides: [],
    review: {
      status: 'confirmed',
      evidence:
        'hdsl-33 independent review of the exact commit (one bounded fetch of the public archive, no execution): known empty providers; durable record docs/development/plugin-remove-service-verification.md with per-file + manifest + tree SHA-256 and exact-source permalinks; valid only for this commit',
    },
  },
];

const isRecordShape = (value: unknown): value is ServiceVerificationRecord =>
  isPlainRecord(value) &&
  typeof value['pluginId'] === 'string' &&
  typeof value['repository'] === 'string' &&
  typeof value['commitSha'] === 'string' &&
  typeof value['manifestSha256'] === 'string' &&
  isPlainRecord(value['runtime']) &&
  typeof value['runtime']['dshVersion'] === 'string' &&
  typeof value['runtime']['dshSha256'] === 'string' &&
  typeof value['runtime']['loaderVersion'] === 'string' &&
  typeof value['runtime']['cordisVersion'] === 'string' &&
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
  if (query.runtime === null) {
    return { status: 'unknown', reason: 'the managed runtime identity could not be established for this generation' };
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
  // The dynamic-load conclusion depends on the managed loader/cordis semantics:
  // a different runtime or loader must NOT stay confirmed.
  const runtimeMatching = matching.filter(
    (record) =>
      record.runtime.dshVersion === query.runtime?.dshVersion &&
      record.runtime.dshSha256 === query.runtime.dshSha256 &&
      record.runtime.loaderVersion === query.runtime.loaderVersion &&
      record.runtime.cordisVersion === query.runtime.cordisVersion,
  );
  if (runtimeMatching.length === 0) {
    return {
      status: 'unknown',
      reason: 'the recorded verification was made for a different managed runtime or loader identity',
    };
  }
  const confirmed = runtimeMatching.find((record) => record.review.status === 'confirmed');
  if (confirmed === undefined) {
    return { status: 'unknown', reason: 'the service verification record is still pending independent review' };
  }
  return { status: 'known', provides: [...confirmed.provides] };
};
