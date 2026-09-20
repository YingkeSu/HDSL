/**
 * Environment-scoped adapter used by the process owner.
 *
 * `load` stands in for the process module's environment-store lookup, so these
 * tests prove the mapping without depending on `@hdsl/core`: success returns the
 * explicit merged env, every failure is a contract `PortOutcome` failure with a
 * value-free message, and an unsupported platform is `UNSUPPORTED_COMBINATION`.
 */
import { describe, expect, it } from 'vitest';
import {
  CredentialFailure,
  credentialFailureCode,
  createCredentialInjection,
  createLaunchCredentialPort,
  type LaunchCredentialRequest,
} from '../../packages/runtime/src/credentials/index.js';
import { createFakeProvider, makeReference } from './support/fakes.js';

const CANARY = 'sk-canary-0123456789abcdef';

const request = (key: string): LaunchCredentialRequest => ({
  bindings: [{ name: 'DEEPSEEK_API_KEY', reference: makeReference(key) }],
  baseEnv: { HOME: '/tmp/home', DSH_HOME: '/tmp/home/.dsh', PATH: '/usr/bin' },
});

describe('createLaunchCredentialPort', () => {
  it('returns an explicit merged launch handle with an idempotent dispose', async () => {
    const provider = createFakeProvider({ values: { 'hdsl.deepseek': CANARY } });
    const port = createLaunchCredentialPort({
      load: () => Promise.resolve(request('hdsl.deepseek')),
      injection: createCredentialInjection({ provider }),
    });
    const outcome = await port.resolveLaunchEnvironment('env-1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('expected a successful outcome');
    }
    expect(outcome.value.env).toEqual({
      HOME: '/tmp/home',
      DSH_HOME: '/tmp/home/.dsh',
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: CANARY,
    });

    // The process owner can wipe the secret through the returned handle; the
    // handle carries no audit-only fields from the mechanism layer.
    expect(Object.keys(outcome.value).sort()).toEqual(['dispose', 'env']);
    outcome.value.dispose();
    outcome.value.dispose();
    expect(outcome.value.env['DEEPSEEK_API_KEY']).toBe('');
  });

  it('fails as INTERNAL_ERROR when no reference is configured', async () => {
    const port = createLaunchCredentialPort({
      load: () => Promise.resolve({ bindings: [], baseEnv: { HOME: '/tmp/home' } }),
      injection: { store: 'keychain', resolveLaunchEnvironment: () => Promise.reject(new CredentialFailure('MISSING_REFERENCE')) },
    });
    const outcome = await port.resolveLaunchEnvironment('env-1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
      expect(outcome.message).not.toContain(CANARY);
    }
  });

  it('fails without leaking a value when the item is missing', async () => {
    const provider = createFakeProvider({});
    const port = createLaunchCredentialPort({
      load: () => Promise.resolve(request('missing')),
      injection: createCredentialInjection({ provider }),
    });
    const outcome = await port.resolveLaunchEnvironment('env-1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
      expect(outcome.message).not.toContain(CANARY);
    }
  });

  it('maps an unsupported platform to UNSUPPORTED_COMBINATION', async () => {
    const port = createLaunchCredentialPort({
      load: () => Promise.resolve(request('hdsl.deepseek')),
      platform: 'win32',
    });
    const outcome = await port.resolveLaunchEnvironment('env-1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('UNSUPPORTED_COMBINATION');
      expect(outcome.message).not.toContain(CANARY);
    }
  });

  it('fails as INTERNAL_ERROR when the environment lookup throws', async () => {
    const port = createLaunchCredentialPort({
      load: () => Promise.reject(new Error('store unavailable')),
      platform: 'darwin',
    });
    const outcome = await port.resolveLaunchEnvironment('env-1');
    expect(outcome).toEqual({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'could not load the environment credential binding',
    });
  });
});

describe('credentialFailureCode', () => {
  it('maps only unsupported platforms to UNSUPPORTED_COMBINATION', () => {
    expect(credentialFailureCode('UNSUPPORTED_PLATFORM')).toBe('UNSUPPORTED_COMBINATION');
    expect(credentialFailureCode('MISSING_REFERENCE')).toBe('INTERNAL_ERROR');
    expect(credentialFailureCode('CREDENTIAL_NOT_FOUND')).toBe('INTERNAL_ERROR');
    expect(credentialFailureCode('CREDENTIAL_ACCESS_CANCELLED')).toBe('INTERNAL_ERROR');
    expect(credentialFailureCode('RESOLUTION_TIMEOUT')).toBe('INTERNAL_ERROR');
  });
});
