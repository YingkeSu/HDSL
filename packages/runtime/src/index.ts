/**
 * `@hdsl/runtime` — managed runtime artifact catalog, composition locks and the
 * real installer for the first slice (T004).
 *
 * The verified macOS ARM64 catalog, the exact DSH dependency closure asset and
 * the download/extract/closure/preflight pipeline live here. The environment
 * model and transaction journal live in `@hdsl/core`; the two packages are
 * siblings and are wired together at the composition root
 * (`createManagedInstall({ runtime: createRuntimePort() })`).
 *
 * This package must not depend on Electron: it runs the managed Node/DSH
 * runtime, which is independent from the application runtime (ADR 0001).
 */
export * from './catalog/index.js';
export * from './composition/index.js';
export * from './install/index.js';
export * from './credentials/index.js';
export * from './process/index.js';
export * from './plugins/index.js';
export * from './reconcile/index.js';
