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
 */
export const API_VERSION = '1.0' as const;

export type ApiVersion = typeof API_VERSION;

/** Well-formed `major.minor` label (structure only, not equality). */
export const API_VERSION_PATTERN = /^\d+\.\d+$/;

export const isWellFormedApiVersion = (value: string): boolean =>
  API_VERSION_PATTERN.test(value);

/** Exact match against the frozen wire version. */
export const matchesApiVersion = (value: unknown): value is ApiVersion =>
  value === API_VERSION;
