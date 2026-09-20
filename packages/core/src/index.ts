/**
 * `@hdsl/core` — environment model, revision/state semantics, the creation
 * transaction journal and the managed-install service (T004).
 *
 * This package owns no download/extract code and does not depend on
 * `@hdsl/runtime`; the concrete runtime port is injected at the composition
 * root (see {@link createManagedInstall}).
 *
 * The domain core deliberately does not depend on Electron (ADR 0001).
 */
export * from './errors.js';
export * from './fsx.js';
export * from './ids.js';
export * from './layout.js';
export * from './data-root-lock.js';
export * from './environment-store.js';
export * from './operation-store.js';
export * from './journal.js';
export * from './idempotency-store.js';
export * from './ports.js';
export * from './creation-service.js';
export * from './contract-port.js';
export * from './managed-install.js';
