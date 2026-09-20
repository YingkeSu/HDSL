/**
 * Idempotency semantics.
 *
 * The ledger lives in the TEST-ONLY reference port, so these tests prove the
 * contract's replay/conflict rules and the "no repeated side effect" property.
 * Durable idempotency across restarts stays a T004 operation-journal
 * responsibility and is explicitly not claimed here.
 */
import {
  contractRequest,
  createReferenceRuntime,
  FIXTURE_IDS,
  type ContractResponse,
} from '@hdsl/contracts';
import { describe, expect, it } from 'vitest';

const expectOk = <T>(response: ContractResponse<T>): T => {
  if (!response.ok) {
    throw new Error(`expected ok, received ${response.error.code}`);
  }
  return response.value;
};
const createInput = (requestId: string, name: string): Record<string, unknown> => ({
  requestId,
  name,
  catalogCombinationId: FIXTURE_IDS.combination.verified,
});

describe('idempotency', () => {
  it('replays the original ExportResult without repeating the export side effect', () => {
    const { port, runtime } = createReferenceRuntime();
    const request = contractRequest('diagnostics.export', {
      requestId: 'req-export-replay',
      environmentId: FIXTURE_IDS.environment.running,
    });

    const first = runtime.dispatch(request);
    const second = runtime.dispatch(request);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(expectOk(first)).toMatchObject({ exported: true, redacted: true });
    expect(port.effects.filter((entry) => entry.startsWith('exportDiagnostics'))).toHaveLength(1);
  });

  it('replays a mutation result without creating a second environment', () => {
    const { port, runtime } = createReferenceRuntime();
    const request = contractRequest('environments.create', createInput('req-create-replay', 'Env'));

    runtime.dispatch(request);
    runtime.dispatch(request);

    expect(port.effects.filter((entry) => entry.startsWith('createEnvironment'))).toHaveLength(1);
    const environments = port.listEnvironments();
    if (!environments.ok) {
      throw new Error(`listEnvironments failed: ${environments.code}`);
    }
    expect(environments.value).toHaveLength(3);
  });

  it('returns IDEMPOTENCY_CONFLICT for the same requestId with different parameters', () => {
    const { runtime } = createReferenceRuntime();
    runtime.dispatch(contractRequest('environments.create', createInput('req-conflict', 'First')));

    const conflict = runtime.dispatch(
      contractRequest('environments.create', createInput('req-conflict', 'Second')),
    );

    expect(conflict.ok).toBe(false);
    if (conflict.ok) {
      throw new Error('expected a conflict');
    }
    expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('treats parameter key order as the same request', () => {
    const { port, runtime } = createReferenceRuntime();
    runtime.dispatch(
      contractRequest('environments.create', {
        requestId: 'req-order',
        name: 'Env',
        catalogCombinationId: FIXTURE_IDS.combination.verified,
      }),
    );
    const reordered = runtime.dispatch(
      contractRequest('environments.create', {
        catalogCombinationId: FIXTURE_IDS.combination.verified,
        name: 'Env',
        requestId: 'req-order',
      }),
    );

    expect(reordered.ok).toBe(true);
    expect(port.effects.filter((entry) => entry.startsWith('createEnvironment'))).toHaveLength(1);
  });

  it('does not cache a guard rejection, so a corrected retry can succeed', () => {
    const { runtime } = createReferenceRuntime();
    const unsubscribe = contractRequest('operations.unsubscribe', {
      requestId: 'req-unsub-guard',
      subscriptionId: 'sub-1',
    });

    const first = runtime.dispatch(unsubscribe);
    expect(first.ok).toBe(false);

    runtime.dispatch(contractRequest('operations.subscribe', { requestId: 'req-sub-guard' }));
    const retry = runtime.dispatch(unsubscribe);
    expect(retry.ok).toBe(true);
  });
});
