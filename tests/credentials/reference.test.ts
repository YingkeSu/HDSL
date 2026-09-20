/**
 * Reference grammar and keychain locator encoding.
 *
 * The macOS keychain key is the frozen contract's single opaque `key` string
 * (`service` or `service#account`), so the encoding has to round-trip exactly
 * and reject anything that could smuggle control characters into the
 * `security` argument vector.
 */
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_NAME_PATTERN,
  CredentialFailure,
  keychainKey,
  parseKeychainKey,
} from '../../packages/runtime/src/credentials/index.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CredentialFailure) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
};

describe('credential environment-variable names', () => {
  it.each(['DEEPSEEK_API_KEY', '_private', 'A1', 'OPENAI_API_KEY'])(
    'accepts the shell identifier %s',
    (name) => {
      expect(CREDENTIAL_NAME_PATTERN.test(name)).toBe(true);
    },
  );

  it.each(['', '1KEY', 'has-dash', 'has space', 'KEY=VALUE', 'KEY\n'])(
    'rejects the non-identifier %j',
    (name) => {
      expect(CREDENTIAL_NAME_PATTERN.test(name)).toBe(false);
    },
  );
});

describe('keychain key encoding', () => {
  it('round-trips a service-only locator', () => {
    expect(keychainKey({ service: 'hdsl.deepseek' })).toBe('hdsl.deepseek');
    expect(parseKeychainKey('hdsl.deepseek')).toEqual({ service: 'hdsl.deepseek' });
  });

  it('round-trips a service#account locator', () => {
    const key = keychainKey({ service: 'hdsl.deepseek', account: 'user@example.com' });
    expect(key).toBe('hdsl.deepseek#user@example.com');
    expect(parseKeychainKey(key)).toEqual({
      service: 'hdsl.deepseek',
      account: 'user@example.com',
    });
  });

  it.each([
    ['empty service', { service: '' }],
    ['separator in service', { service: 'a#b' }],
    ['empty account', { service: 'a', account: '' }],
    ['control character', { service: 'a\u0000b' }],
  ])('rejects %s when encoding', (_label, locator) => {
    expect(codeOf(() => keychainKey(locator))).toBe('INVALID_REFERENCE');
  });

  it.each(['', 'svc#', '#acct', 'a#b#c', 'line\nbreak'])(
    'rejects the malformed key %j when decoding',
    (key) => {
      expect(codeOf(() => parseKeychainKey(key))).toBe('INVALID_REFERENCE');
    },
  );

  it('rejects a key longer than the frozen DTO bound', () => {
    expect(codeOf(() => parseKeychainKey('s'.repeat(257)))).toBe('INVALID_REFERENCE');
  });
});
