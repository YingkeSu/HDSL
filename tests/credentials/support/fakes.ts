/**
 * Test doubles for the credential boundary.
 *
 * These are **test-only** substitutes; production code gets the real OS
 * provider from `createCredentialInjection`/`createOsCredentialProvider`. The
 * fake provider records which references were read so a test can assert that no
 * value ever left the launch environment.
 */
import type {
  CredentialReference,
  OsCredentialProvider,
  OsCredentialStore,
} from '../../../packages/runtime/src/credentials/index.js';
import {
  CredentialFailure,
} from '../../../packages/runtime/src/credentials/index.js';

export interface FakeProviderOptions {
  readonly store?: OsCredentialStore;
  /** Values keyed by `reference.key`. */
  readonly values?: Readonly<Record<string, string>>;
  /** Failures keyed by `reference.key`; thrown instead of returning a value. */
  readonly failures?: Readonly<Record<string, CredentialFailure>>;
}

export interface FakeProvider extends OsCredentialProvider {
  /** `reference.key` of every read, in order. */
  readonly reads: string[];
}

export const createFakeProvider = (options: FakeProviderOptions = {}): FakeProvider => {
  const store = options.store ?? 'keychain';
  const values = options.values ?? {};
  const failures = options.failures ?? {};
  const reads: string[] = [];
  return {
    store,
    reads,
    read: (reference: CredentialReference): Promise<string> => {
      reads.push(reference.key);
      const failure = failures[reference.key];
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const value = values[reference.key];
      if (value === undefined) {
        return Promise.reject(new CredentialFailure('CREDENTIAL_NOT_FOUND'));
      }
      return Promise.resolve(value);
    },
  };
};

export const makeReference = (
  key: string,
  store: OsCredentialStore = 'keychain',
  id = 'cred-test',
): CredentialReference => ({ id, store, key });
