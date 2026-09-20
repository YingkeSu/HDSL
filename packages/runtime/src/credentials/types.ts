/**
 * Narrow credential-reference boundary (T005b / issue #44).
 *
 * HDSL stores a managed user credential (for example the model API key DSH
 * reads from `DEEPSEEK_API_KEY`) only as an OS credential-store *reference*.
 * At launch the reference is resolved once and materialized into the explicit
 * environment of the managed DSH child process; the secret value never becomes
 * persistent state, a file, a log line or a renderer payload (FR-007, ADR 0002).
 *
 * The reference shape is the frozen contract DTO
 * (`packages/contracts/src/dto.ts`), imported rather than redefined so this
 * adapter cannot drift from the shared wire type. The value-bearing result is
 * {@link LaunchEnvironment}; the process owner (T005a/T005) consumes it, spawns
 * the child and calls `dispose()` immediately afterwards.
 */
import type { CredentialReference } from '@hdsl/contracts';

/** OS credential stores named by the frozen contract. Only `keychain` is implemented in this slice. */
export type OsCredentialStore = CredentialReference['store'];

export type { CredentialReference };

/**
 * One credential an environment needs in its launch environment.
 *
 * `name` is the environment-variable name the managed DSH resolves the secret
 * from (upstream `0.1.5-rc.2` uses `DEEPSEEK_API_KEY` by default; see
 * `docs/development/credentials.md`). `reference` points at the OS store item.
 */
export interface CredentialBinding {
  readonly name: string;
  readonly reference: CredentialReference;
}

/**
 * The resolved launch environment handed to the process owner.
 *
 * `env` is a fresh object containing exactly the caller's `baseEnv` plus the
 * resolved credential variables — never the host process environment. The
 * secret values live only here, so the caller MUST call `dispose()` right after
 * the child has been spawned; `dispose()` is a best-effort wipe (JavaScript
 * strings are immutable, so a copy may survive in the engine until GC).
 */
export interface LaunchEnvironment {
  /** Environment for `spawn(..., { env })`: explicit, not inherited from the host. */
  readonly env: Readonly<Record<string, string>>;
  /** Names of the credential variables that were injected (never the values). */
  readonly injectedVariables: readonly string[];
  /** Best-effort wipe of the resolved values; idempotent and safe to call twice. */
  dispose(): void;
}

/**
 * A concrete OS credential store. `read` returns the secret value; production
 * code reaches it only through {@link CredentialInjection} so the value is
 * resolved at launch and immediately discarded. Tests inject a double instead
 * of the real provider — the default factory never substitutes a mock.
 */
export interface OsCredentialProvider {
  readonly store: OsCredentialStore;
  /** Resolves one reference; rejects with a {@link import('./errors.js').CredentialFailure}. */
  read(reference: CredentialReference): Promise<string>;
}

/** Input for one launch-environment resolution. */
export interface LaunchEnvironmentRequest {
  /** Credentials the environment requires; an empty list is a configuration error. */
  readonly bindings: readonly CredentialBinding[];
  /** Explicit, caller-owned base environment (HOME, DSH_HOME, PATH, ...). */
  readonly baseEnv: Readonly<Record<string, string>>;
}

/** The injection port the process owner depends on. */
export interface CredentialInjection {
  readonly store: OsCredentialStore;
  /** Resolve every binding into an explicit child environment, or fail closed. */
  resolveLaunchEnvironment(request: LaunchEnvironmentRequest): Promise<LaunchEnvironment>;
}
