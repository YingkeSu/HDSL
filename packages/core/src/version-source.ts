/**
 * Port between the core-owned `versions.dsh` operation lifecycle and a
 * read-only upstream registry adapter (the npm registry adapter lives in
 * `@hdsl/runtime` and is injected at the composition root).
 *
 * `@hdsl/core` must not import `@hdsl/runtime`, so only this interface lives
 * here; the concrete adapter is structurally compatible and wired in `main`.
 * The port performs a public, credential-free metadata read only: it never
 * downloads a tarball, never loads or executes any package code and never
 * writes an environment (A1 / #113).
 */
import type { DshVersionListing, PortOutcome } from '@hdsl/contracts';

export interface DshVersionSourcePort {
  /**
   * Reads the current upstream DSH version listing from the public registry.
   * A rejected signal must stop the request with no further effect. The
   * returned listing already carries the audited/unaudited marking for the
   * injected catalog; unaudited versions are never reported `supported`.
   */
  listVersions(signal: AbortSignal): Promise<PortOutcome<DshVersionListing>>;
}
