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
  API_VERSION,
  containsSecret,
  createContractRuntime,
  isRetryable,
  OPERATION_PHASE_MAX_LENGTH,
  operationPhaseSchema,
  operationUpdatedEventSchema,
  portFail,
  portOk,
  sanitizeBoundedMessage,
  sanitizeContractMessage,
  SubscriptionRegistry,
  type ContractPort,
  type ContractResponse,
  type ExportResult,
  type OpenWebUIResult,
  type OperationSnapshot,
  type OperationUpdatedEvent,
  type RuntimeCombination,
  type ValidationIssue,
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

describe('F1-cancel guard rejection does not write the ledger', () => {
  it('lets the same requestId retry cancel with a corrected operationId', () => {
    const { base, runtime } = harness();
    const unknown = runtime.dispatch(
      contractRequest('operations.cancel', {
        requestId: 'acc-cancel-retry',
        operationId: 'op-missing',
      }),
    );
    expect(errorCode(unknown)).toBe('NOT_FOUND');

    const corrected = runtime.dispatch(
      contractRequest('operations.cancel', {
        requestId: 'acc-cancel-retry',
        operationId: FIXTURE_IDS.operation.running,
      }),
    );
    expect(corrected.ok).toBe(true);
    expect(base.effects.filter((entry) => entry.startsWith('cancelOperation'))).toHaveLength(1);
  });
});

describe('#25 envelope plain-object and own-field rules', () => {
  it('rejects a prototype-inherited envelope', () => {
    const { runtime } = harness();
    const request: Record<string, unknown> = Object.create({
      apiVersion: API_VERSION,
      method: 'catalog.list',
    });
    request['input'] = {};
    expect(errorCode(runtime.dispatch(request))).toBe('INVALID_INPUT');
  });

  it('rejects an inherited input field', () => {
    const { runtime } = harness();
    const input: Record<string, unknown> = Object.create({ name: 'Inherited' });
    input['requestId'] = 'acc-inherited-input';
    input['catalogCombinationId'] = FIXTURE_IDS.combination.verified;
    expect(errorCode(runtime.dispatch(contractRequest('environments.create', input)))).toBe(
      'INVALID_INPUT',
    );
  });

  it('rejects an own "__proto__" key without polluting Object.prototype', () => {
    const { runtime } = harness();
    const request = JSON.parse(
      `{"apiVersion":"${API_VERSION}","method":"environments.create","input":{"requestId":"acc-proto","name":"Env","catalogCombinationId":"combo-darwin-arm64","__proto__":{"polluted":true}}}`,
    );
    expect(errorCode(runtime.dispatch(request))).toBe('INVALID_INPUT');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('accepts a null-prototype envelope and input', () => {
    const { runtime } = harness();
    const request = Object.create(null) as Record<string, unknown>;
    request['apiVersion'] = API_VERSION;
    request['method'] = 'catalog.list';
    request['input'] = Object.create(null) as Record<string, unknown>;
    expect(runtime.dispatch(request).ok).toBe(true);
  });
});

describe('P2-3 redaction residuals', () => {
  it.each([
    'read $DSH_HOME/.credentials.yaml: secret: AAAAsecretVALUE',
    '{"secret":"AAAAsecretVALUE"}',
  ])('redacts %s', (message) => {
    expect(sanitizeContractMessage(message)).not.toContain('AAAAsecretVALUE');
  });
});

describe('response phase is sanitized like the event channel', () => {
  it('does not leak a credential in OperationSnapshot.phase from operations.get', () => {
    const snapshot: OperationSnapshot = {
      id: FIXTURE_IDS.operation.running,
      environmentId: FIXTURE_IDS.environment.running,
      kind: 'start',
      phase: `running token=${CANARY}`,
      status: 'running',
      sequence: 9,
    };
    const { runtime } = harness({ findOperation: () => portOk(snapshot) });
    const response = runtime.dispatch(
      contractRequest('operations.get', { operationId: FIXTURE_IDS.operation.running }),
    );
    expect(response.ok).toBe(true);
    expect(containsSecret(JSON.stringify(response), [CANARY])).toBe(false);
  });
});

const codePointLength = (value: string): number => [...value].length;

const expectLegalPhase = (phase: string): void => {
  const issues: ValidationIssue[] = [];
  expect(operationPhaseSchema(phase, 'phase', issues)).toBe(phase);
  expect(issues).toEqual([]);
  expect(codePointLength(phase)).toBeLessThanOrEqual(OPERATION_PHASE_MAX_LENGTH);
};

const phaseFromSnapshotResponse = (response: ContractResponse<unknown>): string => {
  if (!response.ok) {
    throw new Error(`expected ok, received ${response.error.code}`);
  }
  return (response.value as OperationSnapshot).phase;
};

const snapshotWithPhase = (phase: string): OperationSnapshot => ({
  id: FIXTURE_IDS.operation.running,
  environmentId: FIXTURE_IDS.environment.running,
  kind: 'start',
  phase,
  status: 'running',
  sequence: 9,
});

describe('#29 a redaction-expanded OperationSnapshot.phase still satisfies operationPhaseSchema', () => {
  it('bounds an assignment redaction that grows a legal 64-character phase (repro 1)', () => {
    // 56 + ' token=a' = 64 code points (legal) → ' token=***' makes 66.
    const snapshot = snapshotWithPhase(`${'a'.repeat(56)} token=a`);
    expect(codePointLength(snapshot.phase)).toBe(64);
    const { runtime } = harness({ findOperation: () => portOk(snapshot) });
    const response = runtime.dispatch(contractRequest('operations.get', { operationId: snapshot.id }));
    const phase = phaseFromSnapshotResponse(response);

    expectLegalPhase(phase);
    expect(containsSecret(phase, [' token=a', 'token=a'])).toBe(false);
    expect(phase).toContain('token=');
    expect(phase.endsWith('a')).toBe(false);
  });

  it('bounds a path redaction that grows a legal 64-character phase (repro 2)', () => {
    // 61 + '~/x' = 64 code points (legal) → '<path>' makes 67.
    const snapshot = snapshotWithPhase(`${'a'.repeat(61)}~/x`);
    expect(codePointLength(snapshot.phase)).toBe(64);
    const { runtime } = harness({ findOperation: () => portOk(snapshot) });
    const response = runtime.dispatch(contractRequest('operations.get', { operationId: snapshot.id }));
    const phase = phaseFromSnapshotResponse(response);

    expectLegalPhase(phase);
    expect(phase).not.toContain('~/x');
  });

  it('bounds by code points, not UTF-16 units, across a multi-byte boundary', () => {
    // 55 astral code points (110 UTF-16 units) + ' token=a' = 63 code points
    // (legal) → ' token=***' makes 65 code points, over the bound by one.
    const snapshot = snapshotWithPhase(`${'🦄'.repeat(55)} token=a`);
    expect(codePointLength(snapshot.phase)).toBe(63);
    expect(snapshot.phase.length).toBeGreaterThan(64);
    const { runtime } = harness({ findOperation: () => portOk(snapshot) });
    const response = runtime.dispatch(contractRequest('operations.get', { operationId: snapshot.id }));
    const phase = phaseFromSnapshotResponse(response);

    expectLegalPhase(phase);
    // The bound is in code points, so the UTF-16 length may exceed 64 while the
    // value stays valid, and truncation never leaves a lone surrogate.
    expect(() => encodeURIComponent(phase)).not.toThrow();
    expect(containsSecret(phase, ['token=a'])).toBe(false);
  });

  it('keeps operations.get, operations.cancel and the event on one postcondition', () => {
    const snapshot = snapshotWithPhase(`${'a'.repeat(56)} token=a`);
    const cancelled: OperationSnapshot = { ...snapshot, status: 'cancelled', sequence: 10 };
    const { runtime } = harness({
      findOperation: () => portOk(snapshot),
      cancelOperation: () => portOk(cancelled),
    });
    const received: OperationUpdatedEvent[] = [];
    runtime.subscriptions.onEvent((event) => received.push(event));
    runtime.subscriptions.subscribe(null);

    const getPhase = phaseFromSnapshotResponse(
      runtime.dispatch(contractRequest('operations.get', { operationId: snapshot.id })),
    );
    const cancelPhase = phaseFromSnapshotResponse(
      runtime.dispatch(
        contractRequest('operations.cancel', { requestId: 'req-29', operationId: snapshot.id }),
      ),
    );

    expectLegalPhase(getPhase);
    expectLegalPhase(cancelPhase);
    expect(cancelPhase).toBe(getPhase);

    const event = received.at(-1);
    if (event === undefined) {
      throw new Error('expected a published operation.updated event');
    }
    const issues: ValidationIssue[] = [];
    expect(operationUpdatedEventSchema(event, 'event', issues)).not.toBeUndefined();
    expect(issues).toEqual([]);
    expectLegalPhase(event.phase);
    expect(event.phase).toBe(getPhase);
  });

  it('publishes a bounded event instead of fail-closing on an over-long raw phase', () => {
    const registry = new SubscriptionRegistry();
    const received: OperationUpdatedEvent[] = [];
    registry.onEvent((event) => received.push(event));
    registry.subscribe(null);

    expect(() =>
      registry.publish({
        id: 'op-29',
        sequence: 1,
        phase: `${'a'.repeat(56)} token=a`,
        status: 'running',
      }),
    ).not.toThrow();

    const event = received.at(-1);
    if (event === undefined) {
      throw new Error('expected a published operation.updated event');
    }
    expectLegalPhase(event.phase);
    expect(containsSecret(event.phase, ['token=a'])).toBe(false);
  });

  it('leaves an ordinary short phase unchanged in both channels', () => {
    const phase = 'waiting for the managed runtime';
    const snapshot = snapshotWithPhase(phase);
    const { runtime } = harness({
      findOperation: () => portOk(snapshot),
      cancelOperation: () => portOk({ ...snapshot, status: 'cancelled', sequence: 10 }),
    });
    const response = runtime.dispatch(contractRequest('operations.get', { operationId: snapshot.id }));
    expect(phaseFromSnapshotResponse(response)).toBe(phase);
  });

  it('is idempotent and secret-free as a shared boundary', () => {
    const raws = [
      `${'a'.repeat(56)} token=a`,
      // `sanitizeContractMessage` is itself not idempotent when an assignment
      // value swallows the following text; the fixed point must be stable so
      // the response and event channels cannot diverge.
      `*U/..h_dsh-auth-='eao=n🦄'_t<éCCe"🦄asC~*t`,
    ];
    for (const raw of raws) {
      const once = sanitizeBoundedMessage(raw, OPERATION_PHASE_MAX_LENGTH);
      expect(sanitizeBoundedMessage(once, OPERATION_PHASE_MAX_LENGTH)).toBe(once);
      expect(codePointLength(once)).toBeLessThanOrEqual(OPERATION_PHASE_MAX_LENGTH);
      expect(once).not.toContain('eao=n');
    }
  });
});
