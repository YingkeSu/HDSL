/**
 * Contract-level rules for the 1.1 plugin discovery surface (ADR 0005 D5/D11):
 * the per-kind `OperationSnapshot.output` rule, the `retryAfterSeconds` wire
 * field and the global (environment-independent) `plugins.search` path.
 *
 * These run the dispatcher against the TEST-ONLY reference port; they prove
 * contract semantics, not the real GitHub API.
 */
import { describe, expect, it } from 'vitest';
import {
  createContractRuntime,
  portFail,
  portOk,
  type ContractPort,
  type ContractResponse,
  type OperationSnapshot,
  type PluginSearchResult,
} from '@hdsl/contracts';
import { contractRequest, FIXTURE_SEED, ReferenceContractPort } from '@hdsl/contracts/testing';

const SEARCH_RESULT: PluginSearchResult = {
  query: 'topic:dsh-plugin',
  hits: [],
  totalCount: 0,
  incompleteResults: false,
  hasMore: false,
  fetchedAt: '2026-01-02T03:04:05Z',
  fromCache: false,
};

const harness = (
  overrides: Partial<ContractPort> = {},
): {
  readonly runtime: ReturnType<typeof createContractRuntime>;
  readonly base: ReferenceContractPort;
} => {
  const base = new ReferenceContractPort(FIXTURE_SEED);
  const port = new Proxy(base, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return (overrides as Record<PropertyKey, unknown>)[property];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as ContractPort;
  return { base, runtime: createContractRuntime({ port }) };
};

const snapshot = (patch: Partial<OperationSnapshot>): OperationSnapshot => ({
  id: 'op-plugin',
  environmentId: null,
  kind: 'search',
  phase: 'finished',
  status: 'succeeded',
  sequence: 1,
  ...patch,
});

const errorCode = (response: ContractResponse<unknown>): string => {
  if (response.ok) throw new Error('expected failure');
  return response.error.code;
};

describe('OperationSnapshot.output rule (ADR 0005 D5)', () => {
  it('returns the validated payload for a succeeded search', () => {
    const { runtime } = harness({
      findOperation: () => portOk(snapshot({ output: SEARCH_RESULT })),
    });
    const response = runtime.dispatch(contractRequest('operations.get', { operationId: 'op-plugin' }));
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect((response.value as OperationSnapshot).output).toEqual(SEARCH_RESULT);
  });

  it('rejects a succeeded search without a payload', () => {
    const { runtime } = harness({ findOperation: () => portOk(snapshot({})) });
    expect(
      errorCode(runtime.dispatch(contractRequest('operations.get', { operationId: 'op-plugin' }))),
    ).toBe('INTERNAL_ERROR');
  });

  it('rejects a queued/running plugin operation that carries a payload', () => {
    const { runtime } = harness({
      findOperation: () => portOk(snapshot({ status: 'running', output: SEARCH_RESULT })),
    });
    expect(
      errorCode(runtime.dispatch(contractRequest('operations.get', { operationId: 'op-plugin' }))),
    ).toBe('INTERNAL_ERROR');
  });

  it('rejects a failed plugin operation that carries a payload', () => {
    const { runtime } = harness({
      findOperation: () =>
        portOk(
          snapshot({
            status: 'failed',
            output: SEARCH_RESULT,
            error: { code: 'NETWORK_UNAVAILABLE', message: 'x', retryable: true },
          }),
        ),
    });
    expect(
      errorCode(runtime.dispatch(contractRequest('operations.get', { operationId: 'op-plugin' }))),
    ).toBe('INTERNAL_ERROR');
  });

  it('rejects a pre-1.1 kind that carries a payload', () => {
    const { runtime } = harness({
      findOperation: () =>
        portOk(snapshot({ kind: 'start', environmentId: 'env-running', output: SEARCH_RESULT })),
    });
    expect(
      errorCode(runtime.dispatch(contractRequest('operations.get', { operationId: 'op-plugin' }))),
    ).toBe('INTERNAL_ERROR');
  });

  it('accepts real GitHub repository names containing "_"/"."', () => {
    const withUnderscore: PluginSearchResult = {
      ...SEARCH_RESULT,
      hits: [
        {
          fullName: 'octo/AI_Animation',
          owner: 'octo',
          name: 'AI_Animation',
          description: null,
          htmlUrl: 'https://github.com/octo/AI_Animation',
          stars: 1,
          topics: [],
          defaultBranch: 'main',
          updatedAt: '2026-01-02T03:04:05Z',
          archived: false,
          fork: false,
          license: null,
        },
      ],
    };
    const { runtime } = harness({
      findOperation: () => portOk(snapshot({ output: withUnderscore })),
    });
    const response = runtime.dispatch(contractRequest('operations.get', { operationId: 'op-plugin' }));
    expect(response.ok).toBe(true);
  });

  it('replaces a malformed payload with INTERNAL_ERROR instead of forwarding it', () => {
    const { runtime } = harness({
      findOperation: () => portOk(snapshot({ output: { query: 42 } })),
    });
    expect(
      errorCode(runtime.dispatch(contractRequest('operations.get', { operationId: 'op-plugin' }))),
    ).toBe('INTERNAL_ERROR');
  });
});

describe('retryAfterSeconds wire field (ADR 0005 D11)', () => {
  it('carries the machine-readable rate-limit delay into the failure envelope', () => {
    const { runtime } = harness({
      inspectPluginSource: () =>
        portFail('RATE_LIMITED', 'raw upstream text token=canary', { retryAfterSeconds: 60 }),
    });
    const response = runtime.dispatch(
      contractRequest('plugins.inspect', {
        requestId: 'req-rate',
        source: { owner: 'octo', name: 'demo' },
      }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('RATE_LIMITED');
    expect(response.error.retryable).toBe(true);
    expect(response.error.retryAfterSeconds).toBe(60);
    expect(response.error.message).not.toContain('canary');
  });
});

describe('plugins.search is global and environment-independent (ADR 0005 D5)', () => {
  it('never consults an environment and forwards the exact query', () => {
    const commands: unknown[] = [];
    const { runtime } = harness({
      // An environment lookup failure must not affect a global search.
      findEnvironment: () => portFail('NOT_FOUND', 'no environments'),
      searchPlugins: (command) => {
        commands.push(command);
        return portOk({ operationId: 'op-search' });
      },
    });
    const response = runtime.dispatch(
      contractRequest('plugins.search', {
        requestId: 'req-search',
        query: 'topic:dsh-plugin fork:false archived:false',
      }),
    );
    expect(response.ok).toBe(true);
    expect(commands).toEqual([
      { requestId: 'req-search', query: 'topic:dsh-plugin fork:false archived:false' },
    ]);
  });
});
