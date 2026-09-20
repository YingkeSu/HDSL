/**
 * Fixed, secret-free process signals for the desktop entry (T006 / issue #6).
 *
 * When the exclusive data-root lease cannot be acquired, main must be
 * attributable to an operator/QA without a window or a page: it writes exactly
 * one stderr line with a stable reason before the native error box. The line
 * never contains a path, owner, PID, hostname or secret, and the reason comes
 * from the lock snapshot's enumerated state — never from exception text.
 *
 * This is production behavior (the same code path a user build takes), not a
 * test-only flag.
 */
import type { DataRootLockSnapshot } from '@hdsl/core';

export const DATA_ROOT_UNAVAILABLE_SIGNAL = '[hdsl] data-root unavailable';

/** Enumerated, stable reasons only. */
export type DataRootUnavailableReason = 'busy' | 'unknown';

/**
 * Maps the lock snapshot to a stable reason. `busy` means another live instance
 * owns the lease; everything else is the generic `unknown` (never exception
 * text, never a path).
 */
export const dataRootUnavailableReason = (
  snapshot: DataRootLockSnapshot,
): DataRootUnavailableReason =>
  snapshot.state === 'busy' || snapshot.publishedBy === 'another-instance' ? 'busy' : 'unknown';

/**
 * The single fixed stderr line. It depends only on the enumerated reason, so no
 * snapshot field (path, owner, PID) can leak into it.
 */
export const formatDataRootUnavailableSignal = (reason: DataRootUnavailableReason): string =>
  `${DATA_ROOT_UNAVAILABLE_SIGNAL} reason=${reason}\n`;
