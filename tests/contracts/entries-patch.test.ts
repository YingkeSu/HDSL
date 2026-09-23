/**
 * #135 E1-T1: contract-level `entries.patch`.
 *
 * It pins the strict input union, the terminal DTO shape (a saved desired config
 * that is never an ACTIVE claim and never carries a local path), the
 * `NOT_FOUND` / `ENVIRONMENT_BUSY` mapping, and `requestId` idempotency on the
 * reference port.
 */
import {
  entryPatchResultSchema,
  type ContractResponse,
  type EntryPatchResult,
} from '@hdsl/contracts';
import {
  contractRequest,
  createReferenceRuntime,
  FIXTURE_IDS,
  FIXTURE_SEED,
  type ReferenceSeed,
} from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';

const dispatch = (input: unknown, seed: ReferenceSeed = FIXTURE_SEED) => {
  const { port, runtime } = createReferenceRuntime(seed);
  return {
    port,
    response: runtime.dispatch(contractRequest('entries.patch', input)),
  };
};

const code = (response: ContractResponse<unknown>): string => {
  if (response.ok) throw new Error('expected a failure response');
  return response.error.code;
};

const CONFIG_SEED: ReferenceSeed = {
  ...FIXTURE_SEED,
  entryPatch: {
    result: {
      environmentId: FIXTURE_IDS.environment.stopped,
      operation: 'config',
      saved: true,
      runtime: 'pending',
      runtimeVerification: 'unavailable',
      activation: 'live-reload-unverified',
      restartRequired: false,
      reloadMode: 'live',
      rows: [
        { id: 'timer', kind: 'insert', name: 'timer-pkg', nameKnown: true, disabled: null, hasConfig: true },
      ],
      diagnostics: [],
    },
  },
};

describe('entries.patch contract', () => {
  it('is a mutation with a requestId and returns the terminal result directly', () => {
    const { response } = dispatch({
      requestId: 'req-entries-1',
      environmentId: FIXTURE_IDS.environment.stopped,
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    // Direct terminal DTO, not an OperationRef.
    expect((response.value as { operationId?: string }).operationId).toBeUndefined();
    const parsed = entryPatchResultSchema(response.value, 'value', []);
    expect(parsed).toBeDefined();
    expect(parsed?.saved).toBe(true);
    expect(parsed?.runtime).toBe('pending');
    expect(parsed?.runtimeVerification).toBe('unavailable');
    // No local path may cross the bridge.
    expect(JSON.stringify(parsed)).not.toContain('cordis.patch.yml');
  });

  it('carries a config value only for the config operation', () => {
    const { response } = dispatch(
      {
        requestId: 'req-entries-2',
        environmentId: FIXTURE_IDS.environment.stopped,
        operation: { kind: 'config', rowId: 'timer', config: { interval: 1 } },
      },
      CONFIG_SEED,
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const parsed = response.value as EntryPatchResult;
    expect(parsed.activation).toBe('live-reload-unverified');
    expect(parsed.restartRequired).toBe(false);
    expect(parsed.reloadMode).toBe('live');
  });

  it.each([
    ['missing config', { kind: 'config', rowId: 'timer' }],
    ['config on a non-config kind', { kind: 'remove', rowId: 'timer', config: {} }],
    ['unknown operation field', { kind: 'disable', rowId: 'timer', path: '/etc/passwd' }],
    ['missing rowId', { kind: 'disable' }],
    ['empty rowId', { kind: 'disable', rowId: '' }],
    ['unknown kind', { kind: 'insert', rowId: 'timer' }],
  ])('rejects %s with INVALID_INPUT before any effect', (_label, operation) => {
    const { port, response } = dispatch({
      requestId: 'req-entries-bad',
      environmentId: FIXTURE_IDS.environment.stopped,
      operation,
    });
    expect(code(response)).toBe('INVALID_INPUT');
    expect(port.effects).toEqual([]);
  });

  it('maps a remove miss to NOT_FOUND and a starting/stopping environment to ENVIRONMENT_BUSY', () => {
    const notFound = dispatch(
      {
        requestId: 'req-entries-notfound',
        environmentId: FIXTURE_IDS.environment.stopped,
        operation: { kind: 'remove', rowId: 'missing' },
      },
      { ...FIXTURE_SEED, entryPatch: { failure: 'NOT_FOUND' } },
    );
    expect(code(notFound.response)).toBe('NOT_FOUND');

    const busy = dispatch(
      {
        requestId: 'req-entries-busy',
        environmentId: FIXTURE_IDS.environment.running,
        operation: { kind: 'disable', rowId: 'timer' },
      },
      { ...FIXTURE_SEED, entryPatch: { failure: 'ENVIRONMENT_BUSY' } },
    );
    expect(code(busy.response)).toBe('ENVIRONMENT_BUSY');
  });

  it('rejects an unknown environment before the port runs', () => {
    const { port, response } = dispatch({
      requestId: 'req-entries-unknown',
      environmentId: 'env-missing',
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(code(response)).toBe('NOT_FOUND');
    expect(port.effects).toEqual([]);
  });

  it('replays the same requestId without repeating the effect, and conflicts on different parameters', () => {
    const { port, runtime } = createReferenceRuntime(FIXTURE_SEED);
    const input = {
      requestId: 'req-entries-idem',
      environmentId: FIXTURE_IDS.environment.stopped,
      operation: { kind: 'disable', rowId: 'timer' },
    };
    const first = runtime.dispatch(contractRequest('entries.patch', input));
    const second = runtime.dispatch(contractRequest('entries.patch', input));
    expect(second).toEqual(first);
    expect(port.effects.filter((effect: string) => effect.startsWith('patchEntry:'))).toHaveLength(1);

    const conflict = runtime.dispatch(
      contractRequest('entries.patch', { ...input, operation: { kind: 'enable', rowId: 'timer' } }),
    );
    expect(code(conflict)).toBe('IDEMPOTENCY_CONFLICT');
    expect(port.effects.filter((effect: string) => effect.startsWith('patchEntry:'))).toHaveLength(1);
  });
});
