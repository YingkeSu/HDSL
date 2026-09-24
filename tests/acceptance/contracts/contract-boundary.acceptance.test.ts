/**
 * Contract boundary acceptance (black-box, external caller).
 *
 * Scope: the **public** `@hdsl/contracts` surface driven through
 * `createContractRuntime` with a controlled `ContractPort`, exactly as an
 * external consumer (preload/main bridge) would. This is boundary behavior
 * validation only:
 *
 * - no source review and no fix implementation;
 * - no desktop E2E, no real DSH process and no persistence are claimed —
 *   `ReferenceContractPort` is the documented TEST/FIXTURE port, so durable
 *   idempotency and T004–T006 effects are out of scope here;
 * - "not yet implemented" (DSH, UI) is not treated as a defect.
 *
 * Baseline: final candidate PR #21 head
 * `12416b1cd14e39606cee62c2e39706f1c3171782` (previously `b1904ce`,
 * frozen `0cfbdbd72d9b01939e20a39c41ade6f927ebff20`), main `5a9d295`,
 * Node `v24.21.0`, pnpm `11.7.0`, darwin/arm64.
 *
 * Run: `pnpm vitest run tests/acceptance/contracts`
 *
 * Three sections:
 * - `frozen contract behavior` — behavior the contract pins down and that
 *   already held on the frozen SHA.
 * - `contract expectations` — the 11 cases that assert the behavior the
 *   contract requires. 10 were intentionally red on `0cfbdbd`; the
 *   `operations.cancel` guard case was red on `b1904ce`. All are green on
 *   `12416b1` with unchanged expectations. The suite must never be green
 *   *because* a defect exists; do not weaken, skip or `it.fails` these.
 * - `redaction increment` — the security re-review forms (get/cancel `phase`
 *   and `.credentials.yaml`/JSON secret assignments) that `12416b1` added.
 */
import {
  createContractRuntime,
  containsSecret,
  isLoopbackOrigin,
  isRetryable,
  portFail,
  portOk,
  SubscriptionRegistry,
  type ContractPort,
  type ContractResponse,
  type EnvironmentSummary,
  type IdempotencyRecord,
  type OperationSnapshot,
  type OperationUpdatedEvent,
  type PortOutcome,
  type SubscriptionRef,
} from '@hdsl/contracts';
import {
  contractRequest,
  FIXTURE_IDS,
  FIXTURE_SEED,
  ReferenceContractPort,
} from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';

const API_SHA = '12416b1cd14e39606cee62c2e39706f1c3171782';
const PRIOR_SHA = '0cfbdbd72d9b01939e20a39c41ade6f927ebff20';

interface Harness {
  readonly base: ReferenceContractPort;
  readonly runtime: ReturnType<typeof createContractRuntime>;
}

/**
 * Builds a runtime over the documented fixture port, with optional per-method
 * overrides that simulate a faulty/controlled downstream port.
 *
 * NOTE: the TEST/FIXTURE port and its fixtures live behind the
 * `@hdsl/contracts/testing` subpath; only this import block depends on it.
 */
const harness = (
  overrides: Partial<ContractPort> = {},
  seed = FIXTURE_SEED,
): Harness => {
  const base = new ReferenceContractPort(seed);
  const port: ContractPort = {
    host: base.host,
    listCatalog: base.listCatalog.bind(base),
    listEnvironments: base.listEnvironments.bind(base),
    listGenerations: base.listGenerations.bind(base),
    listInstalledPlugins: base.listInstalledPlugins.bind(base),
    listDshVersions: base.listDshVersions.bind(base),
    describeExpectedComposition: base.describeExpectedComposition.bind(base),
    patchEntry: base.patchEntry.bind(base),
    previewChange: base.previewChange.bind(base),
    applyChange: base.applyChange.bind(base),
    restoreGeneration: base.restoreGeneration.bind(base),
    findEnvironment: base.findEnvironment.bind(base),
    findOperation: base.findOperation.bind(base),
    findCombination: base.findCombination.bind(base),
    createEnvironment: base.createEnvironment.bind(base),
    startEnvironment: base.startEnvironment.bind(base),
    stopEnvironment: base.stopEnvironment.bind(base),
    switchCombination: base.switchCombination.bind(base),
    openWebUI: base.openWebUI.bind(base),
    cancelOperation: base.cancelOperation.bind(base),
    exportDiagnostics: base.exportDiagnostics.bind(base),
    searchPlugins: base.searchPlugins.bind(base),
    inspectPluginSource: base.inspectPluginSource.bind(base),
    readIdempotency: base.readIdempotency.bind(base),
    writeIdempotency: base.writeIdempotency.bind(base),
    ...overrides,
  };
  return { base, runtime: createContractRuntime({ port }) };
};

const errorCode = (response: ContractResponse<unknown>): string => {
  if (response.ok) {
    throw new Error(`expected a failure, received ok for ${JSON.stringify(response.value)}`);
  }
  return response.error.code;
};

describe(`frozen contract behavior @ ${API_SHA}`, () => {
  describe('version and envelope ordering', () => {
    it('rejects a version mismatch before the method whitelist and before any port call', () => {
      const { base, runtime } = harness();
      const response = runtime.dispatch({
        apiVersion: '9.9',
        method: 'evil.method',
        input: {},
      });
      expect(errorCode(response)).toBe('CONTRACT_VERSION_MISMATCH');
      expect(base.effects).toEqual([]);
    });

    it.each(['2.0', '1.3', '01.0'])('rejects apiVersion %s with CONTRACT_VERSION_MISMATCH', (v) => {
      const { runtime } = harness();
      expect(
        errorCode(runtime.dispatch({ apiVersion: v, method: 'catalog.list', input: {} })),
      ).toBe('CONTRACT_VERSION_MISMATCH');
    });

    it('rejects a malformed apiVersion as INVALID_INPUT', () => {
      const { runtime } = harness();
      expect(
        errorCode(runtime.dispatch({ apiVersion: '1.0 ', method: 'catalog.list', input: {} })),
      ).toBe('INVALID_INPUT');
    });
  });

  describe('idempotency (fixture port)', () => {
    it('replays the same requestId + parameters without repeating the effect', () => {
      const { base, runtime } = harness();
      const request = contractRequest('environments.create', {
        requestId: 'acc-replay',
        name: 'Env',
        catalogCombinationId: FIXTURE_IDS.combination.verified,
      });
      const first = runtime.dispatch(request);
      const second = runtime.dispatch(request);
      expect(first.ok).toBe(true);
      expect(second).toEqual(first);
      expect(base.effects.filter((e) => e.startsWith('createEnvironment'))).toHaveLength(1);
    });

    it('returns IDEMPOTENCY_CONFLICT when the same requestId is reused on a different method', () => {
      const { runtime } = harness();
      const created = runtime.dispatch(
        contractRequest('environments.create', {
          requestId: 'acc-cross-method',
          name: 'Env',
          catalogCombinationId: FIXTURE_IDS.combination.verified,
        }),
      );
      expect(created.ok).toBe(true);
      const restarted = runtime.dispatch(
        contractRequest('environments.start', {
          requestId: 'acc-cross-method',
          environmentId: FIXTURE_IDS.environment.stopped,
          expectedRevision: 1,
        }),
      );
      expect(errorCode(restarted)).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('replays an executed failure without re-running the port', () => {
      const { base, runtime } = harness({}, { ...FIXTURE_SEED, failExport: true });
      const request = contractRequest('diagnostics.export', {
        requestId: 'acc-export-fail',
        environmentId: FIXTURE_IDS.environment.running,
      });
      const first = runtime.dispatch(request);
      const second = runtime.dispatch(request);
      expect(errorCode(first)).toBe('EXPORT_FAILED');
      expect(second).toEqual(first);
      expect(first.ok ? false : isRetryable(first.error.code)).toBe(true);
      expect(base.effects).toEqual([]);
    });
  });

  describe('untrusted input strictness', () => {
    it('rejects an own "__proto__" field and never pollutes Object.prototype', () => {
      const { runtime } = harness();
      const request = JSON.parse(
        '{"apiVersion":"1.2","method":"environments.create","input":{"requestId":"acc-proto","name":"Env","catalogCombinationId":"combo-darwin-arm64","__proto__":{"polluted":true}}}',
      );
      expect(errorCode(runtime.dispatch(request))).toBe('INVALID_INPUT');
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });

    it('does not accept a required input field supplied only through the prototype chain', () => {
      const { runtime } = harness();
      const input = Object.create({ name: 'Inherited' }) as Record<string, unknown>;
      input['requestId'] = 'acc-inherited-input';
      input['catalogCombinationId'] = FIXTURE_IDS.combination.verified;
      const response = runtime.dispatch(contractRequest('environments.create', input));
      expect(errorCode(response)).toBe('INVALID_INPUT');
    });

    it('never echoes an unknown-field value into the error', () => {
      const canary = 'canary-SECRET-9f3a';
      const { runtime } = harness();
      const response = runtime.dispatch(
        contractRequest('environments.create', {
          requestId: 'acc-unknown-value',
          name: 'Env',
          catalogCombinationId: FIXTURE_IDS.combination.verified,
          apiKey: canary,
        }),
      );
      expect(errorCode(response)).toBe('INVALID_INPUT');
      expect(containsSecret(JSON.stringify(response), [canary])).toBe(false);
    });
  });

  describe('subscription windows and per-operation sequence', () => {
    it('groups events per operationId and keeps independent monotonic sequences per window', () => {
      const registry = new SubscriptionRegistry();
      const all = registry.subscribe(null);
      const scoped = registry.subscribe('op-a');

      const b1 = registry.publish({ id: 'op-b', sequence: 1, phase: 'running', status: 'running' });
      expect(b1.map((e) => e.subscriptionId)).toEqual([all.subscriptionId]);

      const a1 = registry.publish({ id: 'op-a', sequence: 1, phase: 'running', status: 'running' });
      expect(a1.map((e) => [e.subscriptionId, e.sequence]).sort()).toEqual(
        [
          [all.subscriptionId, 1],
          [scoped.subscriptionId, 1],
        ].sort(),
      );

      const a2 = registry.publish({ id: 'op-a', sequence: 2, phase: 'finished', status: 'succeeded' });
      expect(a2.every((e) => e.sequence === 2)).toBe(true);

      registry.unsubscribe(all.subscriptionId);
      const a3 = registry.publish({ id: 'op-a', sequence: 3, phase: 'finished', status: 'succeeded' });
      expect(a3.map((e) => e.subscriptionId)).toEqual([scoped.subscriptionId]);
    });

    it('delivers a scoped subscription event through the dispatcher', () => {
      const { runtime } = harness();
      const seen: OperationUpdatedEvent[] = [];
      runtime.subscriptions.onEvent((event) => seen.push(event));
      const subscribed = runtime.dispatch(
        contractRequest('operations.subscribe', { requestId: 'acc-sub-scoped' }),
      );
      if (!subscribed.ok) {
        throw new Error(`subscribe failed: ${subscribed.error.code}`);
      }
      const subscriptionId = (subscribed.value as SubscriptionRef).subscriptionId;

      const started = runtime.dispatch(
        contractRequest('environments.start', {
          requestId: 'acc-sub-start',
          environmentId: FIXTURE_IDS.environment.stopped,
          expectedRevision: 1,
        }),
      );
      expect(started.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.subscriptionId).toBe(subscriptionId);
      expect(seen[0]?.operationId).toBe(
        started.ok ? (started.value as { operationId: string }).operationId : '',
      );
    });
  });

  describe('WebUI loopback boundary', () => {
    it.each([
      'http://localhost:8080',
      'http://0.0.0.0:8080',
      'http://127.0.0.1:53123/?token=abc',
      'http://127.0.0.1:53123#frag',
      'http://127.0.0.1:80@evil.test',
      'http://127.0.0.1:80/evil',
      'https://example.invalid',
    ])('rejects %s as a loopback origin', (origin) => {
      expect(isLoopbackOrigin(origin)).toBe(false);
    });

    it('rejects a token-bearing endpoint from the port without echoing the token', () => {
      const canary = 'canary-token';
      const { runtime } = harness({}, {
        ...FIXTURE_SEED,
        webUIOriginOverride: `http://127.0.0.1:53123/?token=${canary}`,
      });
      const response = runtime.dispatch(
        contractRequest('environments.openWebUI', {
          requestId: 'acc-webui-token',
          environmentId: FIXTURE_IDS.environment.running,
        }),
      );
      expect(errorCode(response)).toBe('WEBUI_UNAVAILABLE');
      expect(containsSecret(JSON.stringify(response), [canary])).toBe(false);
    });
  });
});

describe(`contract expectations @ ${API_SHA} (red on ${PRIOR_SHA})`, () => {
  /**
   * Every case below asserts the behavior the contract text requires. The
   * original 10 were red on `0cfbdbd`; the `[#22/cancel guard]` case was red
   * on `b1904ce`. All 11 are green on `12416b1` without changing an
   * expectation, and remain the regression guards for issues #22 #23 #24 #25
   * #26 #27 and review F3. Do not weaken, skip or `it.fails` them.
   */

  it('[#22] a guard rejection must not permanently poison the requestId on corrected parameters', () => {
    const { base, runtime } = harness();
    const requestId = 'acc-guard-retry';
    const guard = runtime.dispatch(
      contractRequest('environments.create', {
        requestId,
        name: 'Env',
        catalogCombinationId: 'combo-missing',
      }),
    );
    expect(errorCode(guard)).toBe('NOT_FOUND');
    const corrected = runtime.dispatch(
      contractRequest('environments.create', {
        requestId,
        name: 'Env',
        catalogCombinationId: FIXTURE_IDS.combination.verified,
      }),
    );
    expect(corrected.ok).toBe(true);
    expect(base.effects.filter((e) => e.startsWith('createEnvironment'))).toHaveLength(1);
  });

  it('[#22/idempotency ledger] an unpersisted outcome must not repeat the side effect', () => {
    // Simulates the crash window: the in-progress marker is persisted, the
    // completed outcome is not. A replay must not run the effect twice.
    const store = new Map<string, IdempotencyRecord>();
    const { base, runtime } = harness({
      readIdempotency: (id) => store.get(id),
      writeIdempotency: (id, record) => {
        if (record.state === 'in-progress') {
          store.set(id, record);
        }
      },
    });
    const request = contractRequest('environments.create', {
      requestId: 'acc-crash-window',
      name: 'Env',
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    });
    runtime.dispatch(request);
    runtime.dispatch(request);
    expect(base.effects.filter((e) => e.startsWith('createEnvironment'))).toHaveLength(1);
  });

  it('[#23] a throwing port must surface as a sanitized INTERNAL_ERROR envelope', () => {
    const { runtime } = harness({
      findEnvironment: () => {
        throw new Error('port exploded');
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
    expect(containsSecret(JSON.stringify(response), ['port exploded'])).toBe(false);
  });

  it('[#23] a malformed port outcome must not throw a raw TypeError', () => {
    const malformed = { ok: true } as unknown as PortOutcome<EnvironmentSummary>;
    const { runtime } = harness({ findEnvironment: () => malformed });
    const response = runtime.dispatch(
      contractRequest('environments.start', {
        requestId: 'acc-port-malformed',
        environmentId: FIXTURE_IDS.environment.stopped,
        expectedRevision: 1,
      }),
    );
    expect(errorCode(response)).toBe('INTERNAL_ERROR');
  });

  it('[#23] a reused operation sequence must not throw a raw RangeError', () => {
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
    expect(first.ok).toBe(true);
    const second = runtime.dispatch(
      contractRequest('environments.start', {
        requestId: 'acc-seq-2',
        environmentId: FIXTURE_IDS.environment.running,
        expectedRevision: 3,
      }),
    );
    expect(errorCode(second)).toBe('INTERNAL_ERROR');
  });

  it('[#24] out-of-range loopback ports must be rejected as WEBUI_UNAVAILABLE', () => {
    const { runtime } = harness({}, {
      ...FIXTURE_SEED,
      webUIOriginOverride: 'http://127.0.0.1:99999',
    });
    const response = runtime.dispatch(
      contractRequest('environments.openWebUI', {
        requestId: 'acc-webui-port-range',
        environmentId: FIXTURE_IDS.environment.running,
      }),
    );
    expect(response.ok).toBe(false);
    expect(errorCode(response)).toBe('WEBUI_UNAVAILABLE');
  });

  it('[#25] an envelope built from a prototype must not pass validation', () => {
    const { runtime } = harness();
    const request: Record<string, unknown> = Object.create({
      apiVersion: '1.0',
      method: 'catalog.list',
    });
    request['input'] = {};
    const response = runtime.dispatch(request);
    expect(response.ok).toBe(false);
    expect(errorCode(response)).toBe('INVALID_INPUT');
  });

  it('[#26] a replayed subscribe after unsubscribe must not return a dead ref', () => {
    const { runtime } = harness();
    const request = contractRequest('operations.subscribe', { requestId: 'acc-sub-replay' });
    const first = runtime.dispatch(request);
    if (!first.ok) {
      throw new Error(`subscribe failed: ${first.error.code}`);
    }
    const subscriptionId = (first.value as SubscriptionRef).subscriptionId;
    runtime.dispatch(
      contractRequest('operations.unsubscribe', {
        requestId: 'acc-sub-replay-unsub',
        subscriptionId,
      }),
    );
    const replay = runtime.dispatch(request);
    const live = runtime.subscriptions.list().some((ref) => ref.subscriptionId === subscriptionId);
    expect(replay.ok && live).toBe(true);
  });

  it('[#27] nested port error messages must not leak secrets or local paths', () => {
    const canary = 'canary-SECRET-9f3a';
    const leaky: OperationSnapshot = {
      id: 'op-leaky',
      environmentId: FIXTURE_IDS.environment.running,
      kind: 'start',
      phase: 'failed',
      status: 'failed',
      sequence: 9,
      error: {
        code: 'INTERNAL_ERROR',
        message: `token=${canary} at /Users/alice/.dsh`,
        retryable: false,
      },
    };
    const { runtime } = harness({}, {
      ...FIXTURE_SEED,
      operations: [...FIXTURE_SEED.operations, leaky],
    });
    const response = runtime.dispatch(contractRequest('operations.get', { operationId: 'op-leaky' }));
    expect(response.ok).toBe(true);
    expect(containsSecret(JSON.stringify(response), [canary, '/Users/alice/.dsh'])).toBe(false);
  });

  it('[catalog.list / review F3] the list must not return unverified combinations', () => {
    const { runtime } = harness();
    const response = runtime.dispatch(contractRequest('catalog.list', {}));
    expect(response.ok).toBe(true);
    if (!response.ok) {
      return;
    }
    const combinations = response.value as readonly { compatibility: { status: string } }[];
    expect(combinations.filter((c) => c.compatibility.status !== 'verified')).toEqual([]);
  });

  it('[#22/cancel guard] an unknown-operationId rejection must not be recorded as a result', () => {
    // hdsl-5 found at b1904ce that operations.cancel calls the port without a
    // preceding findOperation guard, so a port-declared NOT_FOUND is cached as
    // `completed` and a corrected retry with the same requestId can never run.
    let exists = false;
    const snapshot: OperationSnapshot = {
      id: FIXTURE_IDS.operation.running,
      environmentId: FIXTURE_IDS.environment.running,
      kind: 'start',
      phase: 'finished',
      status: 'cancelled',
      sequence: 3,
    };
    const { runtime } = harness({
      findOperation: () =>
        exists ? portOk(snapshot) : portFail('NOT_FOUND', 'operation was not found'),
      cancelOperation: () =>
        exists ? portOk(snapshot) : portFail('NOT_FOUND', 'operation was not found'),
    });
    const request = contractRequest('operations.cancel', {
      requestId: 'acc-cancel-guard',
      operationId: FIXTURE_IDS.operation.running,
    });
    const first = runtime.dispatch(request);
    expect(errorCode(first)).toBe('NOT_FOUND');
    exists = true;
    const second = runtime.dispatch(request);
    expect(second.ok).toBe(true);
  });
});

describe(`redaction increment @ ${API_SHA} (get/cancel phase + credential forms)`, () => {
  const CANARY = 'canary-SECRET-9f3a';

  const snapshotWith = (phase: string, message?: string): OperationSnapshot => ({
    id: 'op-leaky',
    environmentId: FIXTURE_IDS.environment.running,
    kind: 'start',
    phase,
    status: 'failed',
    sequence: 9,
    ...(message === undefined
      ? {}
      : { error: { code: 'INTERNAL_ERROR' as const, message, retryable: false } }),
  });

  const leakyRuntime = (snapshot: OperationSnapshot): Harness =>
    harness({
      findOperation: () => portOk(snapshot),
      cancelOperation: () => portOk(snapshot),
    });

  // Security re-review forms: `.credentials.yaml` uses `secret: <value>`, JSON
  // carries quoted keys, and DSH cookies use `dsh-auth-<hash>=<value>`.
  const CREDENTIAL_FORMS = [
    `secret: ${CANARY}`,
    `"secret":"${CANARY}"`,
    `/Users/alice/.config/.credentials.yaml secret: ${CANARY}`,
    `{"password":"${CANARY}"}`,
    `dsh-auth-abcd=${CANARY}`,
  ];

  it.each(CREDENTIAL_FORMS)('operations.get does not echo a leaky phase: %s', (phase) => {
    const { runtime } = leakyRuntime(snapshotWith(phase));
    const response = runtime.dispatch(
      contractRequest('operations.get', { operationId: 'op-leaky' }),
    );
    const text = JSON.stringify(response);
    expect(typeof response.ok).toBe('boolean');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('/Users/alice');
  });

  it.each(CREDENTIAL_FORMS)('operations.cancel does not echo a leaky phase: %s', (phase) => {
    const { runtime } = leakyRuntime(snapshotWith(phase));
    const response = runtime.dispatch(
      contractRequest('operations.cancel', {
        requestId: 'acc-redact-cancel',
        operationId: 'op-leaky',
      }),
    );
    const text = JSON.stringify(response);
    expect(typeof response.ok).toBe('boolean');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('/Users/alice');
  });

  it.each(CREDENTIAL_FORMS)('nested error messages do not echo a credential: %s', (message) => {
    const { runtime } = leakyRuntime(snapshotWith('finished', message));
    const response = runtime.dispatch(
      contractRequest('operations.get', { operationId: 'op-leaky' }),
    );
    const text = JSON.stringify(response);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('/Users/alice');
  });

  it('operation.updated events carry the sanitized phase', () => {
    const { runtime } = leakyRuntime(snapshotWith(`secret: ${CANARY}`));
    const events: OperationUpdatedEvent[] = [];
    runtime.subscriptions.onEvent((event) => events.push(event));
    const subscribed = runtime.dispatch(
      contractRequest('operations.subscribe', { requestId: 'acc-redact-sub' }),
    );
    expect(subscribed.ok).toBe(true);
    const cancelled = runtime.dispatch(
      contractRequest('operations.cancel', {
        requestId: 'acc-redact-cancel-event',
        operationId: 'op-leaky',
      }),
    );
    expect(cancelled.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });
});
