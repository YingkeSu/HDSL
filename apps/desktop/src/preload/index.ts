/**
 * Preload contract surface (T003 + T006).
 *
 * This type-checked ESM module is the single shared description of what the
 * preload bridge exposes: exactly the frozen method whitelist, one push channel
 * and one selection notification. The sandboxed runtime preload is
 * `bridge.cts`, which cannot import this ESM module; it exposes the same two
 * functions and three channels, and `tests/desktop/preload-surface.test.ts`
 * pins the literals so the surface cannot drift.
 *
 * There is intentionally no generic `send`/`invoke`/`on` bridge, so the
 * renderer cannot reach an arbitrary channel, and no token-bearing URL ever
 * crosses this boundary.
 */
import { CONTRACT_METHODS } from '@hdsl/contracts';
import {
  HDSL_CONTRACT_CHANNEL,
  HDSL_OPERATION_UPDATED_CHANNEL,
  HDSL_SELECTION_CHANNEL,
} from '../ipc-channels.js';

export {
  HDSL_CONTRACT_CHANNEL,
  HDSL_OPERATION_UPDATED_CHANNEL,
  HDSL_SELECTION_CHANNEL,
};

/** Exactly the methods in `contracts/local-api.md`; nothing else is exposed. */
export const PRELOAD_CONTRACT_METHODS = CONTRACT_METHODS;

/** The only push channel; per-caller scoping and sender validation live in main. */
export const PRELOAD_OPERATION_UPDATED_CHANNEL = HDSL_OPERATION_UPDATED_CHANNEL;

/** Name of the single request channel surfaced to the renderer. */
export const PRELOAD_CONTRACT_CHANNEL = HDSL_CONTRACT_CHANNEL;

/** Name of the one-way selection notification channel. */
export const PRELOAD_SELECTION_CHANNEL = HDSL_SELECTION_CHANNEL;

/**
 * The full object installed on `window.hdsl`. No other member exists; the
 * renderer can only send a contract envelope and observe operation events.
 */
export interface PreloadBridge {
  /** Sends one `{ apiVersion, method, input }` envelope; main validates it. */
  call(request: unknown): Promise<unknown>;
  /** Subscribes to validated `operation.updated` events; returns an unsubscriber. */
  onOperationUpdated(listener: (event: unknown) => void): () => void;
  /** Reports the renderer's current (opaque) environment selection to main. */
  selectEnvironment(environmentId: string): void;
}
