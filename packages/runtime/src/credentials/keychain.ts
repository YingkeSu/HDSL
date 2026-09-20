/**
 * macOS OS credential store provider (`security` keychain CLI).
 *
 * `security find-generic-password -w` prints the secret on stdout; HDSL never
 * passes a secret as a command-line argument and never writes the captured
 * stdout anywhere except the transient {@link LaunchEnvironment}. The CLI is
 * run with an explicit, minimal environment and a hard timeout so a modal
 * authorization dialog can never block the launcher indefinitely; a timeout is
 * reported as an error without interacting with the dialog.
 *
 * Windows (`credential-manager`) and Linux (`secret-service`) are **not**
 * implemented or tested in this slice and fail closed with
 * `UNSUPPORTED_PLATFORM`; the factory never falls back to a test provider.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { CredentialFailure } from './errors.js';
import { parseKeychainKey } from './reference.js';
import type { CredentialReference, OsCredentialProvider } from './types.js';

/** The `security` CLI path on macOS; absolute so the child needs no PATH lookup. */
export const SECURITY_EXECUTABLE = '/usr/bin/security';

/** `errSecItemNotFound`, the exit code `security` returns for a missing item. */
export const SECURITY_ITEM_NOT_FOUND = 44;

const DEFAULT_TIMEOUT_MS = 10_000;

/** Hard cap on captured `security` output; exceeding it fails closed. */
export const MAX_CAPTURED_BYTES = 64 * 1024;

/** Result of appending one captured chunk under the byte cap. */
export interface BoundedAppend {
  readonly text: string;
  readonly captured: number;
  readonly overflow: boolean;
}

/**
 * Appends one chunk under a hard byte cap. On overflow it drops the accumulated
 * text and reports `overflow`, so the caller fails closed instead of returning a
 * truncated value that could be a partial secret.
 */
export const appendBounded = (
  current: string,
  chunk: Buffer,
  captured: number,
  limit: number = MAX_CAPTURED_BYTES,
): BoundedAppend =>
  captured + chunk.byteLength > limit
    ? { text: '', captured: 0, overflow: true }
    : { text: current + chunk.toString('utf8'), captured: captured + chunk.byteLength, overflow: false };

/** Captured result of one `security` invocation. */
export interface SecurityCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `security` with the given argument vector. Injected in tests so the
 * exit-code mapping is exercised without touching the real keychain.
 */
export type SecurityRunner = (args: readonly string[]) => Promise<SecurityCommandResult>;

export interface MacOsKeychainProviderOptions {
  readonly runner?: SecurityRunner | undefined;
  readonly timeoutMs?: number | undefined;
}

const createDefaultRunner = (timeoutMs: number): SecurityRunner => (args) =>
  new Promise<SecurityCommandResult>((resolve, reject) => {
    const child = spawn(SECURITY_EXECUTABLE, [...args], {
      // Explicit, minimal environment: the tool locates the login keychain from
      // HOME and inherits no host secret material.
      env: { HOME: homedir(), PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let captured = 0;
    let overflowed = false;
    let settled = false;

    const onData =
      (channel: 'stdout' | 'stderr') =>
      (chunk: Buffer): void => {
        if (overflowed) {
          return;
        }
        const next = appendBounded(channel === 'stdout' ? stdout : stderr, chunk, captured);
        if (next.overflow) {
          overflowed = true;
          stdout = '';
          stderr = '';
          child.kill('SIGKILL');
          return;
        }
        captured = next.captured;
        if (channel === 'stdout') {
          stdout = next.text;
        } else {
          stderr = next.text;
        }
      };

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
      reject(new CredentialFailure('RESOLUTION_TIMEOUT', `security did not answer within ${String(timeoutMs)}ms`));
    }, timeoutMs);

    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));
    child.on('error', () => {
      finish();
      reject(new CredentialFailure('CREDENTIAL_STORE_UNAVAILABLE', 'could not start the security CLI'));
    });
    child.on('close', (code, signal) => {
      finish();
      if (overflowed) {
        reject(new CredentialFailure('CREDENTIAL_STORE_UNAVAILABLE', 'security output exceeded the capture limit'));
        return;
      }
      resolve({
        exitCode: code ?? (signal === null ? -1 : 128),
        stdout,
        stderr,
      });
    });
  });

/** Removes exactly one trailing line ending that `security -w` appends. */
const stripTrailingLineEnding = (text: string): string =>
  text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;

const mapsToNotFound = (result: SecurityCommandResult): boolean =>
  result.exitCode === SECURITY_ITEM_NOT_FOUND || /could not be found/i.test(result.stderr);

const mapsToCancelled = (result: SecurityCommandResult): boolean =>
  /user cancel/i.test(result.stderr) || /usercanceled/i.test(result.stderr);

/**
 * Creates the macOS keychain provider. `runner` defaults to the real `security`
 * CLI; tests pass a double explicitly.
 */
export const createMacOsKeychainProvider = (
  options: MacOsKeychainProviderOptions = {},
): OsCredentialProvider => {
  const runner = options.runner ?? createDefaultRunner(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    store: 'keychain',
    read: async (reference: CredentialReference): Promise<string> => {
      if (reference.store !== 'keychain') {
        throw new CredentialFailure(
          'INVALID_REFERENCE',
          `reference store "${reference.store}" is not the macOS keychain`,
        );
      }
      const locator = parseKeychainKey(reference.key);
      const args = ['find-generic-password', '-s', locator.service];
      if (locator.account !== undefined) {
        args.push('-a', locator.account);
      }
      args.push('-w');

      let result: SecurityCommandResult;
      try {
        result = await runner(args);
      } catch (error) {
        if (error instanceof CredentialFailure) {
          throw error;
        }
        // Never interpolate an unknown error's text: it could carry store output.
        throw new CredentialFailure('CREDENTIAL_STORE_UNAVAILABLE', 'security invocation failed');
      }

      if (Buffer.byteLength(result.stdout, 'utf8') > MAX_CAPTURED_BYTES || Buffer.byteLength(result.stderr, 'utf8') > MAX_CAPTURED_BYTES) {
        throw new CredentialFailure('CREDENTIAL_STORE_UNAVAILABLE', 'security output exceeded the capture limit');
      }
      if (result.exitCode === 0) {
        const value = stripTrailingLineEnding(result.stdout);
        if (value.length === 0) {
          throw new CredentialFailure('CREDENTIAL_NOT_FOUND', 'the configured reference resolved to an empty value');
        }
        return value;
      }
      if (mapsToNotFound(result)) {
        throw new CredentialFailure('CREDENTIAL_NOT_FOUND');
      }
      if (mapsToCancelled(result)) {
        throw new CredentialFailure('CREDENTIAL_ACCESS_CANCELLED');
      }
      // The store tool's stderr can contain arbitrary text (a bare secret is
      // not impossible), so the outbound message carries only the exit code.
      throw new CredentialFailure(
        'CREDENTIAL_ACCESS_DENIED',
        `security exited with code ${String(result.exitCode)}`,
      );
    },
  };
};
