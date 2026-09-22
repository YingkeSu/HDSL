/**
 * Port between the core-owned plugin discovery operation lifecycle and a
 * read-only source adapter (the GitHub adapter lives in `@hdsl/runtime` and is
 * injected at the composition root).
 *
 * `@hdsl/core` must not import `@hdsl/runtime`, so only this interface lives
 * here; the concrete adapter is structurally compatible and wired in `main`.
 * The port performs network reads only: it never loads plugin code, never
 * writes an environment and never receives a GitHub credential (ADR 0005
 * D16/D17).
 */
import type {
  PluginInspection,
  PluginSearchResult,
  PluginSourceSelector,
  PortOutcome,
} from '@hdsl/contracts';

export interface PluginSourcePort {
  /**
   * Reads one page of a GitHub repository search. `query` must be sent exactly
   * as received (the terminal payload echoes it) and a rejected signal must
   * stop the request with no further effect.
   */
  search(query: string, signal: AbortSignal): Promise<PortOutcome<PluginSearchResult>>;
  /** Reads public repository detail for one `owner`/`name` (+ optional ref). */
  inspect(
    source: PluginSourceSelector,
    signal: AbortSignal,
  ): Promise<PortOutcome<PluginInspection>>;
}
