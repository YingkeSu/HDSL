/**
 * `@hdsl/contracts` — shared DTOs, `API_VERSION`, the response envelope and the
 * runtime input validation used by both the Electron main process and the
 * preload bridge.
 *
 * T002 scope: this package only establishes the compiled workspace entry.
 * The actual contract surface (DTO fields, error codes, exact `API_VERSION`
 * matching, idempotency and subscription semantics) is owned by T003
 * (`specs/001-environment-lifecycle/contracts/local-api.md`) and must be
 * frozen there before any consumer relies on it.
 *
 * Nothing is exported yet on purpose: an empty entry is more honest than a
 * guessed contract that later implementations would silently inherit.
 */
export {};
