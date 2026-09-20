/**
 * Opt-in real macOS keychain canary evidence.
 *
 * Runs only on macOS and only when `HDSL_KEYCHAIN_CANARY=1`, because it touches
 * the real login keychain. It creates **one** dedicated random canary item,
 * exercises the production `security` path (no injected runner), injects it into
 * an explicit child process environment, proves the missing/cancelled failure
 * modes are value-free, and deletes the canary in a `finally`.
 *
 * Safety: the canary service name is random and prefixed, so a user item can
 * never match; the test never lists, searches or reads any other keychain item,
 * never passes the canary value as a command-line argument (the password is
 * written to `security`'s stdin), and never prints the value. If the OS raises
 * an authorization UI the provider's timeout turns it into a failure instead of
 * interacting with the dialog.
 *
 * Run:
 *   HDSL_KEYCHAIN_CANARY=1 pnpm exec vitest run tests/credentials/keychain-canary.evidence.test.ts --reporter=verbose
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  CredentialFailure,
  DEFAULT_MODEL_API_KEY_VARIABLE,
  createCredentialInjection,
  keychainKey,
} from '../../packages/runtime/src/credentials/index.js';

const enabled = process.platform === 'darwin' && process.env['HDSL_KEYCHAIN_CANARY'] === '1';
const SECURITY = '/usr/bin/security';
const CANARY_TIMEOUT_MS = 5_000;

interface SecurityRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runSecurity = (args: readonly string[], input?: string): Promise<SecurityRun> =>
  new Promise<SecurityRun>((resolve, reject) => {
    const child = spawn(SECURITY, [...args], {
      env: { HOME: homedir(), PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('security CLI did not answer; a modal authorization UI may be waiting'));
    }, CANARY_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });

const CHILD_SCRIPT = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const expected = input.endsWith('\\n') ? input.slice(0, -1) : input;
  process.stdout.write(JSON.stringify({
    injected: process.env['${DEFAULT_MODEL_API_KEY_VARIABLE}'] === expected,
    hostLeak: process.env['HDSL_HOST_SENTINEL'] !== undefined,
    base: process.env['HDSL_CANARY_BASE'] ?? null,
  }));
});
`;

interface ChildProbe {
  readonly injected: boolean;
  readonly hostLeak: boolean;
  readonly base: string | null;
}

const runChildWithEnv = (
  env: Readonly<Record<string, string>>,
  expected: string,
): Promise<ChildProbe> =>
  new Promise<ChildProbe>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout) as ChildProbe);
      } catch (error) {
        reject(new Error(`child probe failed: ${String(error)}\nstderr: ${stderr}`));
      }
    });
    child.stdin.end(`${expected}\n`);
  });

const failureOf = async (promise: Promise<unknown>): Promise<CredentialFailure> => {
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

describe.skipIf(!enabled)('macOS keychain canary evidence (opt-in)', () => {
  it('resolves a real canary item, injects an explicit child env, fails closed and cleans up', async () => {
    const suffix = randomBytes(6).toString('hex');
    const service = `hdsl.canary.credentials.${suffix}`;
    const account = `canary-${randomBytes(4).toString('hex')}`;
    const canary = `canary-${randomBytes(16).toString('hex')}`;
    let created = false;
    process.env['HDSL_HOST_SENTINEL'] = 'must-not-reach-the-child';

    try {
      // Precondition: never reuse or overwrite anything. A fresh random name must be absent.
      const before = await runSecurity(['find-generic-password', '-a', account, '-s', service, '-w']);
      expect(before.exitCode).toBe(44);

      // The canary password goes through stdin, never argv.
      const add = await runSecurity(
        ['add-generic-password', '-a', account, '-s', service, '-w'],
        `${canary}\n${canary}\n`,
      );
      expect(add.exitCode, `security add failed: ${add.stderr}`).toBe(0);
      created = true;

      const injection = createCredentialInjection({ platform: 'darwin', timeoutMs: CANARY_TIMEOUT_MS });
      const launch = await injection.resolveLaunchEnvironment({
        bindings: [
          {
            name: DEFAULT_MODEL_API_KEY_VARIABLE,
            reference: { id: `canary-${suffix}`, store: 'keychain', key: keychainKey({ service, account }) },
          },
        ],
        baseEnv: { HDSL_CANARY_BASE: 'base', PATH: '/usr/bin:/bin' },
      });

      expect(launch.injectedVariables).toEqual([DEFAULT_MODEL_API_KEY_VARIABLE]);
      expect(launch.env[DEFAULT_MODEL_API_KEY_VARIABLE]).toBe(canary);

      const probe = await runChildWithEnv(launch.env, canary);
      expect(probe).toEqual({ injected: true, hostLeak: false, base: 'base' });
      launch.dispose();
      expect(launch.env[DEFAULT_MODEL_API_KEY_VARIABLE]).toBe('');

      // A missing reference fails without revealing the canary that was injected.
      const missing = await failureOf(
        injection.resolveLaunchEnvironment({
          bindings: [
            {
              name: DEFAULT_MODEL_API_KEY_VARIABLE,
              reference: {
                id: `missing-${suffix}`,
                store: 'keychain',
                key: keychainKey({ service: `${service}.missing` }),
              },
            },
          ],
          baseEnv: {},
        }),
      );
      expect(missing.code).toBe('CREDENTIAL_NOT_FOUND');
      expect(missing.message).not.toContain(canary);

      // No configured reference is a launch-time failure, not an empty environment.
      const absent = await failureOf(
        injection.resolveLaunchEnvironment({ bindings: [], baseEnv: {} }),
      );
      expect(absent.code).toBe('MISSING_REFERENCE');

      console.log(
        `HDSL_KEYCHAIN_CANARY_EVIDENCE ${JSON.stringify({
          platform: process.platform,
          service,
          resolvedRealKeychain: true,
          injectedExplicitChildEnv: probe.injected,
          hostEnvironmentNotInherited: !probe.hostLeak,
          missingReferenceCode: missing.code,
          absentReferenceCode: absent.code,
        })}`,
      );
    } finally {
      delete process.env['HDSL_HOST_SENTINEL'];
      if (created) {
        const deleted = await runSecurity(['delete-generic-password', '-a', account, '-s', service]);
        expect(deleted.exitCode, `canary cleanup failed: ${deleted.stderr}`).toBe(0);
      }
      const after = await runSecurity(['find-generic-password', '-a', account, '-s', service, '-w']);
      expect(after.exitCode, 'canary item still exists after cleanup').toBe(44);
    }
  }, 60_000);
});
