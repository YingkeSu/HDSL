/**
 * macOS `security` exit-code mapping, with an injected runner.
 *
 * The runner records the argument vector so the tests can prove HDSL never puts
 * a secret on a command line; the secret only ever arrives on stdout and is
 * returned to the caller. Every failure mode (missing item, cancelled
 * authorization, denied access, timeout, crash) maps to a value-free code.
 */
import { describe, expect, it } from 'vitest';
import {
  CredentialFailure,
  createMacOsKeychainProvider,
  type SecurityCommandResult,
  type SecurityRunner,
} from '../../packages/runtime/src/credentials/index.js';
import { makeReference } from './support/fakes.js';

const CANARY = 'sk-canary-0123456789abcdef';

interface RecordingRunner {
  readonly runner: SecurityRunner;
  readonly calls: readonly (readonly string[])[];
}

const recording = (
  respond: (args: readonly string[]) => SecurityCommandResult | Promise<SecurityCommandResult>,
): RecordingRunner => {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args) => {
      calls.push([...args]);
      return respond(args);
    },
  };
};

const result = (exitCode: number, stdout = '', stderr = ''): SecurityCommandResult => ({
  exitCode,
  stdout,
  stderr,
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

describe('macOS keychain provider', () => {
  it('returns the stdout value and asks for the item by service and account', async () => {
    const recorder = recording(() => result(0, `${CANARY}\n`));
    const provider = createMacOsKeychainProvider({ runner: recorder.runner });

    await expect(provider.read(makeReference('hdsl.deepseek#user@example.com'))).resolves.toBe(CANARY);
    expect(recorder.calls).toEqual([
      ['find-generic-password', '-s', 'hdsl.deepseek', '-a', 'user@example.com', '-w'],
    ]);
    expect(recorder.calls.flat()).not.toContain(CANARY);
  });

  it('omits the account flag for a service-only reference', async () => {
    const recorder = recording(() => result(0, `${CANARY}\n`));
    const provider = createMacOsKeychainProvider({ runner: recorder.runner });

    await provider.read(makeReference('hdsl.deepseek'));
    expect(recorder.calls).toEqual([['find-generic-password', '-s', 'hdsl.deepseek', '-w']]);
  });

  it('strips exactly one trailing line ending and preserves inner content', async () => {
    const recorder = recording(() => result(0, 'line1\nline2\n'));
    const provider = createMacOsKeychainProvider({ runner: recorder.runner });
    await expect(provider.read(makeReference('svc'))).resolves.toBe('line1\nline2');
  });

  it('reports an empty value as not found', async () => {
    const provider = createMacOsKeychainProvider({ runner: recording(() => result(0, '\n')).runner });
    expect((await expectFailure(provider.read(makeReference('svc')))).code).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('maps errSecItemNotFound (44) to CREDENTIAL_NOT_FOUND', async () => {
    const provider = createMacOsKeychainProvider({
      runner: recording(() =>
        result(44, '', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'),
      ).runner,
    });
    expect((await expectFailure(provider.read(makeReference('svc')))).code).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('maps a "could not be found" stderr with a non-44 exit to CREDENTIAL_NOT_FOUND', async () => {
    const provider = createMacOsKeychainProvider({
      runner: recording(() => result(1, '', 'The specified item could not be found in the keychain.')).runner,
    });
    expect((await expectFailure(provider.read(makeReference('svc')))).code).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('maps a cancelled authorization prompt to CREDENTIAL_ACCESS_CANCELLED', async () => {
    const provider = createMacOsKeychainProvider({
      runner: recording(() => result(128, '', 'SecKeychainSearchCopyNext: User canceled the operation.')).runner,
    });
    const failure = await expectFailure(provider.read(makeReference('svc')));
    expect(failure.code).toBe('CREDENTIAL_ACCESS_CANCELLED');
    expect(failure.message).not.toContain(CANARY);
  });

  it('maps other denials to CREDENTIAL_ACCESS_DENIED without the secret', async () => {
    const provider = createMacOsKeychainProvider({
      runner: recording(() => result(1, '', 'security: SecKeychainSearchCopyNext: The user name or passphrase you entered is not correct.')).runner,
    });
    const failure = await expectFailure(provider.read(makeReference('svc')));
    expect(failure.code).toBe('CREDENTIAL_ACCESS_DENIED');
    expect(failure.message).not.toContain(CANARY);
  });

  it('propagates an injected timeout', async () => {
    const runner: SecurityRunner = () => Promise.reject(new CredentialFailure('RESOLUTION_TIMEOUT'));
    const provider = createMacOsKeychainProvider({ runner });
    expect((await expectFailure(provider.read(makeReference('svc')))).code).toBe('RESOLUTION_TIMEOUT');
  });

  it('wraps an unknown runner failure without echoing its text', async () => {
    const runner: SecurityRunner = () => Promise.reject(new Error(`boom ${CANARY}`));
    const provider = createMacOsKeychainProvider({ runner });
    const failure = await expectFailure(provider.read(makeReference('svc')));
    expect(failure.code).toBe('CREDENTIAL_STORE_UNAVAILABLE');
    expect(failure.message).not.toContain(CANARY);
  });

  it('rejects a reference whose store is not the macOS keychain', async () => {
    const provider = createMacOsKeychainProvider({ runner: recording(() => result(0, 'x')).runner });
    const failure = await expectFailure(provider.read(makeReference('svc', 'secret-service')));
    expect(failure.code).toBe('INVALID_REFERENCE');
  });

  it('rejects a malformed key before invoking the store', async () => {
    const recorder = recording(() => result(0, CANARY));
    const provider = createMacOsKeychainProvider({ runner: recorder.runner });
    expect((await expectFailure(provider.read(makeReference('svc#')))).code).toBe('INVALID_REFERENCE');
    expect(recorder.calls).toHaveLength(0);
  });
});
