/**
 * The wire contract version shared by the Electron main process and the
 * renderer/preload bridge.
 *
 * `API_VERSION` is `major.minor` and is matched **exactly**: both sides ship
 * from the same build, and the main process rejects unknown fields, so a
 * "minor is compatible" promise could not be honored. Any major or minor
 * mismatch is `CONTRACT_VERSION_MISMATCH`.
 *
 * Version bumps are explicit: change this constant, update
 * `specs/001-environment-lifecycle/contracts/local-api.md` and the fixture
 * table in `fixtures.ts`, and let the orchestrator tag the frozen revision
 * after review. No consumer may silently accept a different version.
 *
 * `1.1` adds the plugin discovery surface (`plugins.search`/`plugins.inspect`,
 * `OperationSnapshot.output`, `retryAfterSeconds` and the D11 error codes) per
 * ADR 0005. The frozen `1.0` contract is retained as the tag
 * `contracts-v1.0.0`; this constant is the single authority for the wire
 * version and both sides ship from the same build.
 *
 * `1.2` adds `entries.patch` (desired-config entry patch, #135/E1-T1). It is
 * additive: a saved home user patch is `saved: true` + `runtime: 'pending'`
 * and is NEVER reported as the runtime ACTIVE set. The `1.1` contract is
 * retained as the tag `contracts-v1.1.0`.
 */
export const API_VERSION = '1.2' as const;

export type ApiVersion = typeof API_VERSION;

/** Well-formed `major.minor` label (structure only, not equality). */
export const API_VERSION_PATTERN = /^\d+\.\d+$/;

export const isWellFormedApiVersion = (value: string): boolean =>
  API_VERSION_PATTERN.test(value);

/** Exact match against the frozen wire version. */
export const matchesApiVersion = (value: unknown): value is ApiVersion =>
  value === API_VERSION;
