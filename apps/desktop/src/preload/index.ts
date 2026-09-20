/**
 * Preload entry point.
 *
 * T003 exposes only the frozen method whitelist and the single event channel
 * from `@hdsl/contracts`. The actual `contextBridge` wiring and IPC transport
 * land in T006. There is intentionally no generic `send`/`invoke`/`on` bridge,
 * so the renderer cannot reach an arbitrary channel, and no token-bearing URL
 * ever crosses this boundary.
 */
import { CONTRACT_METHODS, OPERATION_UPDATED_CHANNEL } from '@hdsl/contracts';

/** Exactly the methods in `contracts/local-api.md`; nothing else is exposed. */
export const PRELOAD_CONTRACT_METHODS = CONTRACT_METHODS;

/** The only push channel; `operations.subscribe` scopes it per caller. */
export const PRELOAD_OPERATION_UPDATED_CHANNEL = OPERATION_UPDATED_CHANNEL;
