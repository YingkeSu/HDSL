/**
 * Launch-environment construction and fail-closed behavior.
 *
 * With an explicit base environment and an injected provider double (never the
 * real keychain), these tests cover: successful injection, the missing /
 * not-found / cancelled / denied failure set, configuration rejections, and
 * that no resolved secret reaches an error message, the host environment or a
 * disposed environment.
 */
import { describe, expect, it } from 'vitest';
import {
  CredentialFailure,
  createCredentialInjection,
  createOsCredentialProvider,
  type CredentialBinding,
  type SecurityCommandResult,
} from '../../packages/runtime/src/credentials/index.js';
import { createFakeProvider, makeReference } from './support/fakes.js';

const CANARY = 'sk-canary-0123456789abcdef';
const OTHER_CANARY = 'sk-canary-ffffffffffffffff';

const keychainResult = (stdout: string): SecurityCommandResult => ({
  exitCode: 0,
  stdout: `${stdout}\n`,
  stderr: '',
});

const expectFailure = async (promise: Promise<unknown>): Promise<CredentialFailure> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CredentialFailure) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the call to reject');
};

const binding = (name: string, key: string): CredentialBinding => ({
  name,
  reference: makeReference(key),
});

describe('resolveLaunchEnvironment', () => {
  it('injects resolved values into an explicit copy of the base environment', async () => {
    const provider = createFakeProvider({ values: { 'hdsl.deepseek': CANARY } });
    const injection = createCredentialInjection({ provider });

    const launch = await injection.resolveLaunchEnvironment({
      bindings: [binding('DEEPSEEK_API_KEY', 'hdsl.deepseek')],
      baseEnv: { HOME: '/tmp/home', DSH_HOME: '/tmp/home/.dsh', PATH: '/usr/bin' },
    });

    expect(launch.env).toEqual({
      HOME: '/tmp/home',
      DSH_HOME: '/tmp/home/.dsh',
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: CANARY,
    });
    expect(launch.injectedVariables).toEqual(['DEEPSEEK_API_KEY']);
    expect(provider.reads).toEqual(['hdsl.deepseek']);
  });

  it('never inherits the host process environment', async () => {
    process.env['HDSL_CREDENTIALS_TEST_SENTINEL'] = 'host-value';
    try {
      const provider = createFakeProvider({ values: { svc: CANARY } });
      const injection = createCredentialInjection({ provider });
      const launch = await injection.resolveLaunchEnvironment({
        bindings: [binding('DEEPSEEK_API_KEY', 'svc')],
        baseEnv: { DSH_HOME: '/tmp/home' },
      });
      expect(launch.env['HDSL_CREDENTIALS_TEST_SENTINEL']).toBeUndefined();
    } finally {
      delete process.env['HDSL_CREDENTIALS_TEST_SENTINEL'];
    }
  });

  it('wipes the injected values on dispose', async () => {
    const provider = createFakeProvider({ values: { svc: CANARY } });
    const injection = createCredentialInjection({ provider });
    const launch = await injection.resolveLaunchEnvironment({
      bindings: [binding('DEEPSEEK_API_KEY', 'svc')],
      baseEnv: {},
    });
    expect(launch.env['DEEPSEEK_API_KEY']).toBe(CANARY);

    launch.dispose();
    launch.dispose();
    expect(launch.env['DEEPSEEK_API_KEY']).toBe('');
  });

  it('fails closed when no reference is configured', async () => {
    const injection = createCredentialInjection({ provider: createFakeProvider() });
    const failure = await expectFailure(
      injection.resolveLaunchEnvironment({ bindings: [], baseEnv: { HOME: '/tmp/home' } }),
    );
    expect(failure.code).toBe('MISSING_REFERENCE');
  });

  it.each([
    ['a non-identifier name', binding('not-a-var', 'svc')],
    ['a reserved launcher variable', binding('PATH', 'svc')],
  ])('rejects %s as INVALID_REFERENCE', async (_label, candidate) => {
    const provider = createFakeProvider({ values: { svc: CANARY } });
    const injection = createCredentialInjection({ provider });
    const failure = await expectFailure(
      injection.resolveLaunchEnvironment({ bindings: [candidate], baseEnv: {} }),
    );
    expect(failure.code).toBe('INVALID_REFERENCE');
    expect(provider.reads).toHaveLength(0);
  });

  it('rejects a credential name that would shadow the base environment', async () => {
    const provider = createFakeProvider({ values: { svc: CANARY } });
    const injection = createCredentialInjection({ provider });
    const failure = await expectFailure(
      injection.resolveLaunchEnvironment({
        bindings: [binding('DEEPSEEK_API_KEY', 'svc')],
        baseEnv: { DEEPSEEK_API_KEY: '' },
      }),
    );
    expect(failure.code).toBe('INVALID_REFERENCE');
    expect(provider.reads).toHaveLength(0);
  });

  it('rejects duplicate names and mismatched stores before reading the store', async () => {
    const provider = createFakeProvider({ values: { svc: CANARY } });
    const injection = createCredentialInjection({ provider });

    const duplicate = await expectFailure(
      injection.resolveLaunchEnvironment({
        bindings: [binding('DEEPSEEK_API_KEY', 'svc'), binding('DEEPSEEK_API_KEY', 'other')],
        baseEnv: {},
      }),
    );
    expect(duplicate.code).toBe('INVALID_REFERENCE');

    const mismatch = await expectFailure(
      injection.resolveLaunchEnvironment({
        bindings: [
          { name: 'DEEPSEEK_API_KEY', reference: makeReference('svc', 'secret-service') },
        ],
        baseEnv: {},
      }),
    );
    expect(mismatch.code).toBe('INVALID_REFERENCE');
    expect(provider.reads).toHaveLength(0);
  });

  it('fails on a missing item and leaks neither that nor a previously resolved secret', async () => {
    const provider = createFakeProvider({
      values: { first: CANARY },
      failures: { second: new CredentialFailure('CREDENTIAL_NOT_FOUND') },
    });
    const injection = createCredentialInjection({ provider });
    const failure = await expectFailure(
      injection.resolveLaunchEnvironment({
        bindings: [binding('FIRST_API_KEY', 'first'), binding('SECOND_API_KEY', 'second')],
        baseEnv: {},
      }),
    );
    expect(failure.code).toBe('CREDENTIAL_NOT_FOUND');
    expect(failure.message).not.toContain(CANARY);
  });

  it('fails on an empty resolved value', async () => {
    const provider = createFakeProvider({ values: { svc: '' } });
    const injection = createCredentialInjection({ provider });
    const failure = await expectFailure(
      injection.resolveLaunchEnvironment({ bindings: [binding('DEEPSEEK_API_KEY', 'svc')], baseEnv: {} }),
    );
    expect(failure.code).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('propagates a cancelled authorization without leaking any value', async () => {
    const provider = createFakeProvider({
      values: { other: OTHER_CANARY },
      failures: { svc: new CredentialFailure('CREDENTIAL_ACCESS_CANCELLED') },
    });
    const injection = createCredentialInjection({ provider });
    const failure = await expectFailure(
      injection.resolveLaunchEnvironment({
        bindings: [binding('DEEPSEEK_API_KEY', 'svc')],
        baseEnv: {},
      }),
    );
    expect(failure.code).toBe('CREDENTIAL_ACCESS_CANCELLED');
    expect(failure.message).not.toContain(OTHER_CANARY);
  });

  it('wraps an unexpected provider fault without echoing its text', async () => {
    const injection = createCredentialInjection({
      provider: {
        store: 'keychain',
        read: () => Promise.reject(new Error(`provider boom ${CANARY}`)),
      },
    });
    const failure = await expectFailure(
      injection.resolveLaunchEnvironment({ bindings: [binding('DEEPSEEK_API_KEY', 'svc')], baseEnv: {} }),
    );
    expect(failure.code).toBe('CREDENTIAL_STORE_UNAVAILABLE');
    expect(failure.message).not.toContain(CANARY);
  });
});

describe('provider factory', () => {
  it.each(['win32', 'linux'] as const)('fails closed on %s instead of using a mock', (platform) => {
    let thrown: unknown;
    try {
      createOsCredentialProvider({ platform });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CredentialFailure);
    expect((thrown as CredentialFailure).code).toBe('UNSUPPORTED_PLATFORM');
    expect(() => createCredentialInjection({ platform })).toThrow(CredentialFailure);
  });

  it('builds the real macOS keychain provider by default', async () => {
    const calls: string[][] = [];
    const injection = createCredentialInjection({
      platform: 'darwin',
      runner: (args) => {
        calls.push([...args]);
        return Promise.resolve(keychainResult(CANARY));
      },
    });
    expect(injection.store).toBe('keychain');

    const launch = await injection.resolveLaunchEnvironment({
      bindings: [binding('DEEPSEEK_API_KEY', 'hdsl.deepseek')],
      baseEnv: {},
    });
    expect(launch.env['DEEPSEEK_API_KEY']).toBe(CANARY);
    expect(calls).toEqual([['find-generic-password', '-s', 'hdsl.deepseek', '-w']]);
  });
});
