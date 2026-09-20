/**
 * Secret and local-path containment for contract errors (FR-007, ADR 0002).
 */
import {
  containsSecret,
  contractError,
  isLoopbackOrigin,
  openWebUIResultSchema,
  sanitizeContractMessage,
  type ValidationIssue,
} from '@hdsl/contracts';
import {
  contractRequest,
  createReferenceRuntime,
  FIXTURE_IDS,
  FIXTURE_SEED,
} from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';

const CANARY = 'canary-SECRET-9f3a';

describe('contract message sanitization', () => {
  it('redacts URL credentials, token query parameters, bearer tokens and local paths', () => {
    expect(sanitizeContractMessage('https://user:pass@example.invalid/x')).toBe(
      'https://***@example.invalid/x',
    );
    expect(sanitizeContractMessage('http://127.0.0.1:53123/?token=abc123')).toBe(
      'http://127.0.0.1:53123/?token=***',
    );
    expect(sanitizeContractMessage('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer ***',
    );
    expect(sanitizeContractMessage('failed to read /Users/alice/.dsh/config')).toBe(
      'failed to read <path>',
    );
    expect(sanitizeContractMessage('failed to read C:\\Users\\alice\\.dsh')).toBe(
      'failed to read <path>',
    );
  });

  it('sanitizes every error built through contractError', () => {
    const error = contractError(
      'INTERNAL_ERROR',
      `token=${CANARY} at /Users/alice/${CANARY}`,
    );
    expect(containsSecret(JSON.stringify(error), [CANARY])).toBe(false);
    expect(error.message).toContain('token=***');
    expect(error.message).toContain('<path>');
  });
});

describe('secrets never appear in dispatched contract responses', () => {
  it('does not echo an unknown field value', () => {
    const { runtime } = createReferenceRuntime();
    const response = runtime.dispatch(
      contractRequest('environments.create', {
        requestId: 'req-secret-field',
        name: 'Env',
        catalogCombinationId: FIXTURE_IDS.combination.verified,
        apiKey: CANARY,
      }),
    );
    expect(response.ok).toBe(false);
    expect(containsSecret(JSON.stringify(response), [CANARY])).toBe(false);
  });

  it('does not echo a path-like display name', () => {
    const { runtime } = createReferenceRuntime();
    const response = runtime.dispatch(
      contractRequest('environments.create', {
        requestId: 'req-secret-name',
        name: `a/${CANARY}`,
        catalogCombinationId: FIXTURE_IDS.combination.verified,
      }),
    );
    expect(response.ok).toBe(false);
    expect(containsSecret(JSON.stringify(response), [CANARY])).toBe(false);
  });

  it('rejects a token-bearing WebUI endpoint before it reaches the renderer', () => {
    const { runtime } = createReferenceRuntime({
      ...FIXTURE_SEED,
      webUIOriginOverride: `http://127.0.0.1:53123/?token=${CANARY}`,
    });
    const response = runtime.dispatch(
      contractRequest('environments.openWebUI', {
        requestId: 'req-secret-webui',
        environmentId: FIXTURE_IDS.environment.running,
      }),
    );

    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error('expected WEBUI_UNAVAILABLE');
    }
    expect(response.error.code).toBe('WEBUI_UNAVAILABLE');
    expect(containsSecret(JSON.stringify(response), [CANARY])).toBe(false);
  });

  it('exposes only a token-free loopback origin on success', () => {
    const { runtime } = createReferenceRuntime();
    const response = runtime.dispatch(
      contractRequest('environments.openWebUI', {
        requestId: 'req-webui-ok',
        environmentId: FIXTURE_IDS.environment.running,
      }),
    );
    if (!response.ok) {
      throw new Error(`expected ok, received ${response.error.code}`);
    }
    expect(Object.keys(response.value as object).sort()).toEqual(['loopbackOrigin']);
    expect(response.value).toEqual({ loopbackOrigin: 'http://127.0.0.1:53123' });
    expect(JSON.stringify(response.value)).not.toContain('token');

    const issues: ValidationIssue[] = [];
    expect(openWebUIResultSchema(response.value, 'value', issues)).not.toBeUndefined();
    expect(issues).toEqual([]);
  });
});

describe('loopback origin validation', () => {
  it.each([
    ['http://127.0.0.1:53123', true],
    ['https://127.0.0.1:443', true],
    ['http://[::1]:8080', true],
    ['http://127.0.0.1:1', true],
    ['http://127.0.0.1:65535', true],
    ['http://localhost:8080', false],
    ['http://0.0.0.0:8080', false],
    ['http://127.0.0.1:53123/?token=abc', false],
    ['http://127.0.0.1:53123#frag', false],
    ['http://127.0.0.1', false],
    ['http://127.0.0.1:0', false],
    ['http://127.0.0.1:65536', false],
    ['http://127.0.0.1:99999', false],
    ['http://127.0.0.1:00080', false],
  ])('%s → %s', (origin, expected) => {
    expect(isLoopbackOrigin(origin)).toBe(expected);
  });
});
