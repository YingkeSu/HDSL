/**
 * Restart reconciliation for managed processes and managed installer children
 * (T005). Consumed by the process manager's `recover()`; the core service merges
 * the returned entries with its creation-transaction reconciliation.
 */
export * from './reconcile.js';
