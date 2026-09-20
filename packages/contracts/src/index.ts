/**
 * `@hdsl/contracts` — the versioned local API shared by the Electron main
 * process and the preload/renderer side.
 *
 * Frozen by T003 (issue #3) against
 * `specs/001-environment-lifecycle/contracts/local-api.md` and
 * `specs/001-environment-lifecycle/data-model.md`:
 *
 * - `API_VERSION` is matched exactly; any major/minor mismatch is
 *   `CONTRACT_VERSION_MISMATCH`.
 * - shared DTOs validate untrusted data at runtime (unknown fields, illegal
 *   ids and over-long text are `INVALID_INPUT`).
 * - state-dependent semantics (idempotency, `expectedRevision`, unknown ids,
 *   platform support, subscription sequence) run through {@link ContractPort}
 *   and the dispatcher, not through string schemas.
 * - error messages are sanitized so secrets and local paths never cross the
 *   bridge.
 *
 * The `testing/` exports are TEST/FIXTURE ONLY and are not persistence or
 * launcher behavior; T004–T006 implement the real port.
 */
export * from './version.js';
export * from './schema.js';
export * from './redaction.js';
export * from './errors.js';
export * from './ids.js';
export * from './platform.js';
export * from './dto.js';
export * from './digest.js';
export * from './events.js';
export * from './methods.js';
export * from './context.js';
export * from './dispatcher.js';
export * from './testing/reference-port.js';
export * from './testing/fixtures.js';
