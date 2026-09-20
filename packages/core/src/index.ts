/**
 * `@hdsl/core` — environment model, revision and state semantics, storage ports
 * (see docs/architecture/tdd.md).
 *
 * T002 scope: only the compiled workspace entry exists. Environment creation,
 * composition locking and transaction journals are owned by T004
 * (`packages/core/src/**`, `packages/runtime/src/{catalog,install,composition}/**`).
 *
 * The domain core deliberately does not depend on Electron (ADR 0001).
 */
export {};
