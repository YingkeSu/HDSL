/**
 * Reference grammar and macOS keychain locator encoding.
 *
 * Upstream `0.1.5-rc.2` defines a credential reference as a POSIX shell
 * identifier naming an environment variable (`credentialRef` in
 * `@deepseek-ai/dsh-credentials`, and `DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY"`
 * in `@deepseek-ai/dsh-llm-deepseek`). The frozen contract DTO carries the OS
 * store locator as one opaque `key` string, so this module owns the macOS
 * encoding: `service` or `service#account`.
 */
import { CredentialFailure } from './errors.js';

/** Grammar DSH accepts for a credential reference name (POSIX shell identifier). */
export const CREDENTIAL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Verified upstream `0.1.5-rc.2` default variable for the model API key
 * (`DEFAULT_API_KEY_ENV` in `@deepseek-ai/dsh-llm-deepseek`). Shared with the
 * process owner so both sides agree on the injected name instead of hard-coding
 * it twice. The environment's own binding list still decides the names; this is
 * only the upstream default for the model credential slot.
 */
export const DEFAULT_MODEL_API_KEY_VARIABLE = 'DEEPSEEK_API_KEY';

/** Separates the keychain service from the optional keychain account. */
export const KEYCHAIN_KEY_SEPARATOR = '#';

/** Keychain key maximum length; matches the frozen DTO `key` bound. */
const KEY_MAX_LENGTH = 256;

/**
 * Names a credential binding must never claim: they configure the managed
 * process itself, so letting a secret shadow them would change launcher
 * behavior (or inject code) instead of supplying a model credential.
 */
export const RESERVED_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'DSH_HOME',
  'DSH_AGENTS_HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

export interface KeychainLocator {
  readonly service: string;
  readonly account?: string;
}

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
};

/**
 * Encode a keychain service/account pair into the frozen DTO `key` string.
 * Throws a value-free {@link CredentialFailure} on malformed input.
 */
export const keychainKey = (locator: KeychainLocator): string => {
  const service = locator.service;
  const account = locator.account;
  if (service.length === 0 || hasControlCharacter(service) || service.includes(KEYCHAIN_KEY_SEPARATOR)) {
    throw new CredentialFailure('INVALID_REFERENCE', 'keychain service is empty or contains control characters');
  }
  if (account !== undefined && (account.length === 0 || hasControlCharacter(account))) {
    throw new CredentialFailure('INVALID_REFERENCE', 'keychain account is empty or contains control characters');
  }
  const key = account === undefined ? service : `${service}${KEYCHAIN_KEY_SEPARATOR}${account}`;
  if (key.length > KEY_MAX_LENGTH) {
    throw new CredentialFailure('INVALID_REFERENCE', 'keychain reference is longer than the allowed maximum');
  }
  return key;
};

/** Decode the frozen DTO `key` string into a keychain service/account pair. */
export const parseKeychainKey = (key: string): KeychainLocator => {
  if (key.length === 0 || key.length > KEY_MAX_LENGTH || hasControlCharacter(key)) {
    throw new CredentialFailure('INVALID_REFERENCE', 'keychain reference is empty, over-long or contains control characters');
  }
  const separator = key.indexOf(KEYCHAIN_KEY_SEPARATOR);
  if (separator === -1) {
    return { service: key };
  }
  const service = key.slice(0, separator);
  const account = key.slice(separator + 1);
  if (service.length === 0 || account.length === 0 || account.includes(KEYCHAIN_KEY_SEPARATOR)) {
    throw new CredentialFailure('INVALID_REFERENCE', 'keychain reference must be "service" or "service#account"');
  }
  return { service, account };
};
