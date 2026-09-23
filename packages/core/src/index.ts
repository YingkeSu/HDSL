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
export * from './home-migration.js';
export * from './generation-profile.js';
export * from './generation-runtime-reuse.js';
export * from './generation-runtime-identity.js';
export * from './target-profile-cache.js';
export * from './change-plan-store.js';
export * from './plugin-preview.js';
export * from './plugin-apply.js';
export * from './data-root-lock.js';
export * from './credential-store.js';
export * from './environment-store.js';
export * from './operation-store.js';
export * from './plugin-source.js';
export * from './plugin-discovery-service.js';
export * from './version-source.js';
export * from './version-discovery-service.js';
export * from './journal.js';
export * from './idempotency-store.js';
export * from './ports.js';
export * from './creation-service.js';
export * from './contract-port.js';
export * from './managed-install.js';
export * from './plugin-removal.js';
export * from './installed-plugins.js';
