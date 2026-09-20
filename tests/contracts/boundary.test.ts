/**
 * Boundary regression tests for the PR #21 review/QA findings:
 * F1 (idempotency window), F2/P1-2 (port exceptions), F3 (catalog filter),
 * F4 (retry semantics), P1-1 (outbound DTO/event validation),
 * P2-1 (bounded error text), P2-2 (owner interface), P2-3 (redaction),
 * and F5 (testing surface is not on the production entry).
 *
 * These use a controlled `ContractPort` on top of the TEST-ONLY reference port.
 */
import {
  containsSecret,
  createContractRuntime,
  isRetryable,
  portFail,
  portOk,
  sanitizeContractMessage,
  SubscriptionRegistry,
  type ContractPort,
  type ContractResponse,
  type ExportResult,
  type OpenWebUIResult,
  type OperationSnapshot,
  type RuntimeCombination,
} from '@hdsl/contracts';
import * as productionContracts from '@hdsl/contracts';
import {
  contractRequest,
  FIXTURE_IDS,
  FIXTURE_SEED,
  ReferenceContractPort,
  type ReferenceSeed,
} from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';

const harness = (
  overrides: Partial<ContractPort> = {},
  seed: ReferenceSeed = FIXTURE_SEED,
): { readonly base: ReferenceContractPort; readonly runtime: ReturnType<typeof createContractRuntime> } => {
  const base = new ReferenceContractPort(seed);
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

const errorCode = (response: ContractResponse<unknown>): string => {
  if (response.ok) {
    throw new Error(`expected a failure, received ok: ${JSON.stringify(response.value)}`);
  }
  return response.error.code;
};

const CANARY = 'canary-SECRET-9f3a';

describe('F1 idempotency window', () => {
  it('does not re-run an effect whose outcome was never written (in-progress stays in-progress)', () => {
    let createCalls = 0;
    const { runtime } = harness({
      createEnvironment: () => {
        createCalls += 1;
        throw new Error(`install exploded token=${CANARY} at /Users/alice/.dsh`);
      },
    });
    const request = contractRequest('environments.create', {
      requestId: 'req-in-progress',
      name: 'Env',
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    });

    const first = runtime.dispatch(request);
    const second = runtime.dispatch(request);

    expect(errorCode(first)).toBe('INTERNAL_ERROR');
    expect(errorCode(second)).toBe('ENVIRONMENT_BUSY');
    expect(createCalls).toBe(1);
    expect(containsSecret(JSON.stringify(first), [CANARY, '/Users/alice'])).toBe(false);
  });
});

describe('F2 / P1-2 port and event exceptions map to a sanitized envelope', () => {
  it('maps a throwing port to INTERNAL_ERROR without leaking the original text', () => {
    const { runtime } = harness({
      findEnvironment: () => {
        throw new Error(`port exploded token=${CANARY} https://user:pass@host at /Users/alice/.dsh`);
      },
    });
    const response = runtime.dispatch(
      contractRequest('environments.start', {
        requestId: 'acc-port-throw',
        environmentId: FIXTURE_IDS.environment.stopped,
        expectedRevision: 1,
      }),
    );
    expect(errorCode(response)).toBe('INTERNAL_ERROR');
    expect(containsSecret(JSON.stringify(response), [CANARY, 'user:pass', '/Users/alice'])).toBe(false);
  });

  it('maps a malformed port outcome to INTERNAL_ERROR instead of a TypeError', () => {
    const { runtime } = harness({
      findEnvironment: () => ({ ok: true }) as never,
    });
    const response = runtime.dispatch(
      contractRequest('environments.start', {
        requestId: 'acc-port-malformed',
        environmentId: FIXTURE_IDS.environment.stopped,
        expectedRevision: 1,
      }),
    );
    expect(errorCode(response)).toBe('INTERNAL_ERROR');
  });

  it('maps a reused operation sequence to INTERNAL_ERROR instead of a RangeError', () => {
    const snapshot: OperationSnapshot = {
      id: FIXTURE_IDS.operation.running,
      environmentId: FIXTURE_IDS.environment.running,
      kind: 'start',
      phase: 'running',
      status: 'running',
      sequence: 2,
    };
    const { runtime } = harness({
      findOperation: () => portOk(snapshot),
      startEnvironment: () => portOk({ operationId: snapshot.id }),
    });
    const first = runtime.dispatch(
      contractRequest('environments.start', {
        requestId: 'acc-seq-1',
        environmentId: FIXTURE_IDS.environment.running,
        expectedRevision: 3,
      }),
    );
    const second = runtime.dispatch(
      contractRequest('environments.start', {
        requestId: 'acc-seq-2',
        environmentId: FIXTURE_IDS.environment.running,
        expectedRevision: 3,
      }),
    );
    expect(first.ok).toBe(true);
    expect(errorCode(second)).toBe('INTERNAL_ERROR');
  });
});

describe('F3 catalog.list only returns verified combinations', () => {
  it('filters unverified entries out of the list', () => {
    const { runtime } = harness();
    const response = runtime.dispatch(contractRequest('catalog.list', {}));
    if (!response.ok) {
      throw new Error(`catalog.list failed: ${response.error.code}`);
    }
    const ids = (response.value as readonly RuntimeCombination[]).map((entry) => entry.id);
    expect(ids).toContain(FIXTURE_IDS.combination.verified);
    expect(ids).not.toContain(FIXTURE_IDS.combination.unverified);
  });
});

describe('F4 retry semantics: same requestId replays, a new requestId retries', () => {
  it('replays a retryable failure for the same requestId and only succeeds with a new requestId', () => {
    let exportCalls = 0;
    const { runtime } = harness({
      exportDiagnostics: () => {
        exportCalls += 1;
        return exportCalls === 1
          ? portFail('EXPORT_FAILED', 'first attempt fails')
          : portOk({ exportId: 'export-1', exported: true, redacted: true });
      },
    });

    const retryable = runtime.dispatch(
      contractRequest('diagnostics.export', {
        requestId: 'acc-export-retry',
        environmentId: FIXTURE_IDS.environment.running,
      }),
    );
    expect(errorCode(retryable)).toBe('EXPORT_FAILED');
    if (!retryable.ok) {
      expect(isRetryable(retryable.error.code)).toBe(true);
    }

    const replay = runtime.dispatch(
      contractRequest('diagnostics.export', {
        requestId: 'acc-export-retry',
        environmentId: FIXTURE_IDS.environment.running,
      }),
    );
    expect(errorCode(replay)).toBe('EXPORT_FAILED');
    expect(exportCalls).toBe(1);

    const fresh = runtime.dispatch(
      contractRequest('diagnostics.export', {
        requestId: 'acc-export-fresh',
        environmentId: FIXTURE_IDS.environment.running,
      }),
    );
    expect(fresh.ok).toBe(true);
    expect(exportCalls).toBe(2);
  });
});

describe('P1-1 outbound values and events are validated and sanitized', () => {
  it('rejects an openWebUI result with extra token/cookie fields', () => {
    const { runtime } = harness({
      openWebUI: () =>
        portOk({
          loopbackOrigin: 'http://127.0.0.1:53123',
          tokenUrl: `http://127.0.0.1:53123/?token=${CANARY}`,
          cookie: `dsh-auth=${CANARY}`,
        } as unknown as OpenWebUIResult),
    });
    const response = runtime.dispatch(
      contractRequest('environments.openWebUI', {
        requestId: 'acc-webui-extra',
        environmentId: FIXTURE_IDS.environment.running,
      }),
    );
    expect(errorCode(response)).toBe('INTERNAL_ERROR');
    expect(containsSecret(JSON.stringify(response), [CANARY])).toBe(false);
  });

  it('rejects an export result carrying a local path', () => {
    const { runtime } = harness({
      exportDiagnostics: () =>
        portOk({
          exportId: 'export-1',
          exported: true,
          redacted: true,
          path: '/Users/alice/.dsh/logs/x.log',
        } as unknown as ExportResult),
    });
    const response = runtime.dispatch(
      contractRequest('diagnostics.export', {
        requestId: 'acc-export-path',
        environmentId: FIXTURE_IDS.environment.running,
      }),
    );
    expect(errorCode(response)).toBe('INTERNAL_ERROR');
    expect(containsSecret(JSON.stringify(response), ['/Users/alice'])).toBe(false);
  });

  it('rejects an invalid operationId returned by the port', () => {
    const { runtime } = harness({
      createEnvironment: () => portOk({ operationId: '../../etc/passwd' }),
    });
    const response = runtime.dispatch(
      contractRequest('environments.create', {
        requestId: 'acc-illegal-opid',
        name: 'Env',
        catalogCombinationId: FIXTURE_IDS.combination.verified,
      }),
    );
    expect(errorCode(response)).toBe('INTERNAL_ERROR');
  });

  it('rejects an out-of-range progress in a port snapshot', () => {
    const snapshot = {
      id: FIXTURE_IDS.operation.running,
      environmentId: FIXTURE_IDS.environment.running,
      kind: 'start',
      phase: 'running',
      status: 'running',
      sequence: 9,
      progress: 500,
    } as unknown as OperationSnapshot;
    const { runtime } = harness({ findOperation: () => portOk(snapshot) });
    const response = runtime.dispatch(
      contractRequest('operations.get', { operationId: FIXTURE_IDS.operation.running }),
    );
    expect(errorCode(response)).toBe('INTERNAL_ERROR');
  });

  it('replaces nested port error text with a controlled message', () => {
    const leaky: OperationSnapshot = {
      id: 'op-leaky',
      environmentId: FIXTURE_IDS.environment.running,
      kind: 'start',
      phase: 'failed',
      status: 'failed',
      sequence: 9,
      error: { code: 'INTERNAL_ERROR', message: `token=${CANARY} at /Users/alice/.dsh`, retryable: false },
    };
    const { runtime } = harness({}, { ...FIXTURE_SEED, operations: [...FIXTURE_SEED.operations, leaky] });
    const response = runtime.dispatch(contractRequest('operations.get', { operationId: 'op-leaky' }));
    expect(response.ok).toBe(true);
    expect(containsSecret(JSON.stringify(response), [CANARY, '/Users/alice'])).toBe(false);
  });

  it('rejects an out-of-range progress event at the registry', () => {
    const registry = new SubscriptionRegistry();
    registry.subscribe(null);
    expect(() =>
      registry.publish({ id: 'op-x', sequence: 1, phase: 'running', status: 'running', progress: 500 }),
    ).toThrow(RangeError);
  });

  it('sanitizes credential text in the published event phase', () => {
    const registry = new SubscriptionRegistry();
    const seen: string[] = [];
    registry.onEvent((event) => seen.push(JSON.stringify(event)));
    registry.subscribe(null);
    registry.publish({ id: 'op-x', sequence: 1, phase: `running token=${CANARY}`, status: 'running' });
    expect(containsSecret(seen.join(' '), [CANARY])).toBe(false);
  });
});

describe('P2-1 error text is bounded', () => {
  it('caps the failure message for thousands of unknown fields', () => {
    const input: Record<string, unknown> = {};
    for (let index = 0; index < 3000; index += 1) {
      input[`field${String(index)}`.padEnd(200, 'x')] = index;
    }
    const { runtime } = harness();
    const response = runtime.dispatch(contractRequest('catalog.list', input));
    expect(errorCode(response)).toBe('INVALID_INPUT');
    if (!response.ok) {
      expect(response.error.message.length).toBeLessThanOrEqual(512);
    }
  });
});

describe('P2-2 subscription owner interface', () => {
  it('does not let another owner unsubscribe a scoped subscription', () => {
    const registry = new SubscriptionRegistry();
    const scoped = registry.subscribe('op-a', 'window-a');
    registry.subscribe(null, 'window-b');

    expect(registry.unsubscribe(scoped.subscriptionId, 'window-b')).toBe(false);
    expect(registry.has(scoped.subscriptionId)).toBe(true);
    expect(registry.list('window-a').map((entry) => entry.subscriptionId)).toEqual([
      scoped.subscriptionId,
    ]);
    expect(registry.unsubscribe(scoped.subscriptionId, 'window-a')).toBe(true);
  });
});

describe('P2-3 redaction covers DSH credential forms', () => {
  it.each([
    'secret: AAAAsecretVALUE',
    'client_secret=CANARY123',
    'set-cookie: dsh-auth-abc=COOKIEVALUE; Path=/',
    'cannot read /etc/shadow',
    'cannot read /root/.dsh/settings',
    'cannot read /Volumes/Ext/dsh-home',
    'cannot read ~/Library/dsh',
  ])('redacts %s', (message) => {
    const sanitized = sanitizeContractMessage(message);
    for (const secret of ['AAAAsecretVALUE', 'CANARY123', 'COOKIEVALUE', '/etc/shadow', '/root/.dsh', '/Volumes/Ext', '~/Library']) {
      expect(sanitized).not.toContain(secret);
    }
  });
});

describe('F5 testing surface is not on the production entry', () => {
  it('does not export the reference port or fixture table from @hdsl/contracts', () => {
    const surface = productionContracts as unknown as Record<string, unknown>;
    expect(surface['ReferenceContractPort']).toBeUndefined();
    expect(surface['createReferenceRuntime']).toBeUndefined();
    expect(surface['ALL_CONTRACT_FIXTURES']).toBeUndefined();
  });
});
