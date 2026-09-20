/**
 * Environment-scoped adapter for the process owner (T005a/T005).
 *
 * `createCredentialInjection` is the environment-agnostic mechanism. The
 * process module needs the agreed `LaunchCredentialPort` signature keyed by
 * `environmentId`, so this adapter adds the process-owned lookup (environment
 * config -> bindings + explicit base environment) and maps every
 * {@link CredentialFailure} to a contract {@link PortOutcome} failure whose
 * message is already value-free.
 *
 * The credentials module still owns no environment state: `load` is supplied by
 * the process module, which is also the only place that reads the environment
 * store. The returned env map is the explicit child environment; the process
 * module uses it for `spawn` and must not persist it (it is the only copy of
 * the secret and is reclaimed by GC once dropped).
 */
import { portFail, portOk, type ErrorCode, type PortOutcome } from '@hdsl/contracts';
import { CredentialFailure } from './errors.js';
import { createCredentialInjection } from './injection.js';
import type { SecurityRunner } from './keychain.js';
import type { CredentialBinding, CredentialInjection } from './types.js';

/** What the process module loads for one environment before a start. */
export interface LaunchCredentialRequest {
  /** Credential references the environment requires (empty = configuration error). */
  readonly bindings: readonly CredentialBinding[];
  /** Explicit base environment the managed child should receive. */
  readonly baseEnv: Readonly<Record<string, string>>;
}

/** Process-owned lookup; must never return a secret value. */
export type LaunchCredentialLoader = (
  environmentId: string,
) => Promise<LaunchCredentialRequest>;

/** The frozen narrow interface consumed by `createProcessManager({ credentials })`. */
export interface LaunchCredentialPort {
  resolveLaunchEnvironment(environmentId: string): Promise<PortOutcome<Readonly<Record<string, string>>>>;
}

export interface LaunchCredentialPortOptions {
  readonly load: LaunchCredentialLoader;
  /** Explicit injection (tests); defaults to the real platform provider. */
  readonly injection?: CredentialInjection | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly runner?: SecurityRunner | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Maps a value-free credential failure to the frozen error-code set. The frozen
 * contract has no credential-specific code: an unsupported platform is
 * `UNSUPPORTED_COMBINATION`, every other resolution failure is `INTERNAL_ERROR`.
 */
export const credentialFailureCode = (code: CredentialFailure['code']): ErrorCode =>
  code === 'UNSUPPORTED_PLATFORM' ? 'UNSUPPORTED_COMBINATION' : 'INTERNAL_ERROR';

/** Creates the adapter the process owner passes as `credentials`. */
export const createLaunchCredentialPort = (
  options: LaunchCredentialPortOptions,
): LaunchCredentialPort => {
  const buildInjection = (): CredentialInjection =>
    options.injection ??
    createCredentialInjection({
      platform: options.platform,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
    });

  return {
    resolveLaunchEnvironment: async (
      environmentId: string,
    ): Promise<PortOutcome<Readonly<Record<string, string>>>> => {
      let request: LaunchCredentialRequest;
      try {
        request = await options.load(environmentId);
      } catch {
        return portFail('INTERNAL_ERROR', 'could not load the environment credential binding');
      }
      try {
        const launch = await buildInjection().resolveLaunchEnvironment(request);
        return portOk(launch.env);
      } catch (error) {
        if (error instanceof CredentialFailure) {
          return portFail(credentialFailureCode(error.code), error.message);
        }
        return portFail('INTERNAL_ERROR', 'credential resolution failed');
      }
    },
  };
};
