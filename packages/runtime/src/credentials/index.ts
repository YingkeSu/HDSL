/**
 * `@hdsl/runtime` credentials slice (T005b / issue #44).
 *
 * Trusted OS credential-reference resolution and explicit launch-environment
 * construction. Consumed by the process owner (T005a/T005) at spawn time; the
 * resolved secret lives only in the returned {@link LaunchEnvironment} and is
 * wiped by `dispose()` right after the child is spawned.
 *
 * Scope and evidence: `docs/development/credentials.md`. The runtime root
 * `index.ts` is owned by the process author and intentionally does not re-export
 * this module in this slice.
 */
export * from './types.js';
export * from './errors.js';
export * from './reference.js';
export * from './keychain.js';
export * from './injection.js';
export * from './port.js';
