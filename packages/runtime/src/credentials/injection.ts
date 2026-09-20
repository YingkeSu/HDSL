/**
 * Credential injection: resolve references into an explicit child environment.
 *
 * This is the narrow interface the process owner (T005a/T005) uses. It fails
 * closed: an empty binding list, a malformed or reserved variable name, a
 * variable that would shadow the managed base environment, a store mismatch, a
 * missing OS item, an empty value, a cancelled authorization or a timeout all
 * reject with a value-free {@link CredentialFailure}; no partial environment is
 * ever returned.
 *
 * Production never substitutes a test provider: {@link createCredentialInjection}
 * builds the real OS provider for the current platform unless a provider is
 * passed explicitly, and {@link createOsCredentialProvider} throws
 * `UNSUPPORTED_PLATFORM` instead of degrading to a mock.
 */
import { CredentialFailure } from './errors.js';
import { createMacOsKeychainProvider, type SecurityRunner } from './keychain.js';
import { CREDENTIAL_NAME_PATTERN, RESERVED_ENVIRONMENT_NAMES } from './reference.js';
import type {
  CredentialBinding,
  CredentialInjection,
  LaunchEnvironment,
  LaunchEnvironmentRequest,
  OsCredentialProvider,
} from './types.js';

export interface OsCredentialProviderOptions {
  /** Defaults to `process.platform`; overridable so unsupported platforms are testable. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Test-only `security` runner override for the macOS provider. */
  readonly runner?: SecurityRunner | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Builds the real provider for a platform. Only macOS keychain is implemented;
 * Windows and every other platform fail closed (see `docs/development/credentials.md`).
 */
export const createOsCredentialProvider = (
  options: OsCredentialProviderOptions = {},
): OsCredentialProvider => {
  const platform = options.platform ?? process.platform;
  switch (platform) {
    case 'darwin':
      return createMacOsKeychainProvider({ runner: options.runner, timeoutMs: options.timeoutMs });
    case 'win32':
      throw new CredentialFailure(
        'UNSUPPORTED_PLATFORM',
        'Windows Credential Manager resolution is not implemented or tested in this slice',
      );
    default:
      throw new CredentialFailure(
        'UNSUPPORTED_PLATFORM',
        `no OS credential store provider is implemented for platform "${platform}"`,
      );
  }
};

export interface CredentialInjectionOptions extends OsCredentialProviderOptions {
  /** Explicit provider (tests). When omitted, the real platform provider is built. */
  readonly provider?: OsCredentialProvider | undefined;
}

const validateBinding = (
  binding: CredentialBinding,
  baseEnv: Readonly<Record<string, string>>,
  seen: Set<string>,
  providerStore: string,
): void => {
  const name = binding.name;
  if (!CREDENTIAL_NAME_PATTERN.test(name)) {
    throw new CredentialFailure('INVALID_REFERENCE', `"${name}" is not a usable environment-variable name`);
  }
  if (RESERVED_ENVIRONMENT_NAMES.has(name)) {
    throw new CredentialFailure('INVALID_REFERENCE', `"${name}" is reserved by the launcher`);
  }
  if (Object.prototype.hasOwnProperty.call(baseEnv, name)) {
    throw new CredentialFailure('INVALID_REFERENCE', `"${name}" would shadow the managed base environment`);
  }
  if (seen.has(name)) {
    throw new CredentialFailure('INVALID_REFERENCE', `"${name}" is bound more than once`);
  }
  seen.add(name);
  if (binding.reference.store !== providerStore) {
    throw new CredentialFailure(
      'INVALID_REFERENCE',
      `reference store "${binding.reference.store}" does not match the "${providerStore}" provider`,
    );
  }
};

/**
 * Resolves every binding through `provider` and merges the values into a copy
 * of `baseEnv`. Reads run sequentially so at most one store prompt can exist.
 */
const resolveLaunchEnvironment = async (
  provider: OsCredentialProvider,
  request: LaunchEnvironmentRequest,
): Promise<LaunchEnvironment> => {
  if (request.bindings.length === 0) {
    throw new CredentialFailure('MISSING_REFERENCE');
  }

  const seen = new Set<string>();
  for (const binding of request.bindings) {
    validateBinding(binding, request.baseEnv, seen, provider.store);
  }

  const resolved: Array<{ name: string; value: string }> = [];
  try {
    for (const binding of request.bindings) {
      const value = await provider.read(binding.reference);
      if (value.length === 0) {
        throw new CredentialFailure(
          'CREDENTIAL_NOT_FOUND',
          `the reference for "${binding.name}" resolved to an empty value`,
        );
      }
      resolved.push({ name: binding.name, value });
    }
  } catch (error) {
    for (const entry of resolved) {
      entry.value = '';
    }
    resolved.length = 0;
    throw error instanceof CredentialFailure
      ? error
      : new CredentialFailure('CREDENTIAL_STORE_UNAVAILABLE', 'credential resolution failed');
  }

  const env: Record<string, string> = { ...request.baseEnv };
  const injectedVariables: string[] = [];
  for (const entry of resolved) {
    env[entry.name] = entry.value;
    injectedVariables.push(entry.name);
  }
  for (const entry of resolved) {
    entry.value = '';
  }
  resolved.length = 0;

  let disposed = false;
  return {
    env,
    injectedVariables,
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const name of injectedVariables) {
        env[name] = '';
      }
    },
  };
};

/** Creates the injection port used by the process owner. */
export const createCredentialInjection = (
  options: CredentialInjectionOptions = {},
): CredentialInjection => {
  const provider =
    options.provider ??
    createOsCredentialProvider({
      platform: options.platform,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
    });
  return {
    store: provider.store,
    resolveLaunchEnvironment: (request: LaunchEnvironmentRequest) =>
      resolveLaunchEnvironment(provider, request),
  };
};
