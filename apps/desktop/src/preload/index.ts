/**
 * Preload entry point.
 *
 * T002 scope: only the compiled entry exists. The narrow IPC whitelist
 * (operations.subscribe/unsubscribe and the read-only queries in
 * specs/001-environment-lifecycle/contracts/local-api.md) is frozen in T003
 * and wired in T006. Until then this module intentionally exposes no bridge,
 * so the renderer has no privileged surface to call.
 */
export {};
