/**
 * Subscription and event semantics: per-operation sequence, grouping, the
 * unsubscribe cutoff and the strict monotonicity guard.
 */
import {
  environmentUpdatedEventSchema,
  operationUpdatedEventSchema,
  SubscriptionRegistry,
  type EnvironmentSummary,
  type OperationUpdatedEvent,
  type SubscriptionRef,
  type ValidationIssue,
} from '@hdsl/contracts';
import { contractRequest, createReferenceRuntime, FIXTURE_IDS } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';

describe('environment.updated projection', () => {
  const environment: EnvironmentSummary = {
    id: 'env-1',
    name: 'Env 1',
    revision: 1,
    stateVersion: 2,
    state: 'stopped',
    activeGenerationId: 'gen-1',
    compositionDigest: 'a'.repeat(64),
  };

  it('accepts a bounded EnvironmentSummary projection', () => {
    const issues: ValidationIssue[] = [];
    const parsed = environmentUpdatedEventSchema({ environment }, 'event', issues);
    expect(parsed).toEqual({ environment });
    expect(issues).toEqual([]);
  });

  it('rejects a projection with an invalid or unknown field', () => {
    const issues: ValidationIssue[] = [];
    const parsed = environmentUpdatedEventSchema(
      { environment: { ...environment, id: 'bad id', secret: 'canary' } },
      'event',
      issues,
    );
    expect(parsed).toBeUndefined();
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('subscription registry', () => {
  it('keeps one sequence domain per operation for a multi-operation subscription', () => {
    const registry = new SubscriptionRegistry();
    const seen: Array<[string, number]> = [];
    registry.onEvent((event) => seen.push([event.operationId, event.sequence]));
    registry.subscribe(null);

    registry.publish({ id: 'op-a', sequence: 1, phase: 'running', status: 'running' });
    registry.publish({ id: 'op-b', sequence: 1, phase: 'running', status: 'running' });
    registry.publish({ id: 'op-a', sequence: 2, phase: 'finished', status: 'succeeded' });

    expect(seen).toEqual([
      ['op-a', 1],
      ['op-b', 1],
      ['op-a', 2],
    ]);
  });

  it('scopes an operation subscription and stops after unsubscribe', () => {
    const registry = new SubscriptionRegistry();
    const scoped = registry.subscribe('op-a');

    const forA = registry.publish({ id: 'op-a', sequence: 1, phase: 'running', status: 'running' });
    expect(forA.map((event) => event.subscriptionId)).toEqual([scoped.subscriptionId]);

    expect(registry.unsubscribe(scoped.subscriptionId)).toBe(true);
    expect(registry.unsubscribe(scoped.subscriptionId)).toBe(false);
    expect(
      registry.publish({ id: 'op-a', sequence: 2, phase: 'finished', status: 'succeeded' }),
    ).toEqual([]);
  });

  it('rejects a non-increasing sequence for the same operation', () => {
    const registry = new SubscriptionRegistry();
    registry.publish({ id: 'op-a', sequence: 2, phase: 'running', status: 'running' });
    expect(() =>
      registry.publish({ id: 'op-a', sequence: 2, phase: 'running', status: 'running' }),
    ).toThrow(RangeError);
    expect(() =>
      registry.publish({ id: 'op-a', sequence: 1, phase: 'running', status: 'running' }),
    ).toThrow(RangeError);
  });
});

describe('operations.subscribe through the dispatcher', () => {
  it('emits schema-valid events for a subscribed operation and stops on unsubscribe', () => {
    const { runtime } = createReferenceRuntime();
    const received: OperationUpdatedEvent[] = [];
    runtime.subscriptions.onEvent((event) => received.push(event));

    const subscribed = runtime.dispatch(
      contractRequest('operations.subscribe', { requestId: 'req-sub' }),
    );
    if (!subscribed.ok) {
      throw new Error(`subscribe failed: ${subscribed.error.code}`);
    }
    const subscriptionId = (subscribed.value as SubscriptionRef).subscriptionId;

    const started = runtime.dispatch(
      contractRequest('environments.start', {
        requestId: 'req-start-event',
        environmentId: FIXTURE_IDS.environment.stopped,
        expectedRevision: 1,
      }),
    );
    expect(started.ok).toBe(true);
    expect(received).toHaveLength(1);

    const event = received[0];
    if (event === undefined) {
      throw new Error('expected one event');
    }
    const issues: ValidationIssue[] = [];
    expect(operationUpdatedEventSchema(event, 'event', issues)).not.toBeUndefined();
    expect(issues).toEqual([]);
    expect(event.subscriptionId).toBe(subscriptionId);
    expect(event.sequence).toBe(1);

    runtime.dispatch(
      contractRequest('operations.unsubscribe', {
        requestId: 'req-unsub-event',
        subscriptionId,
      }),
    );
    runtime.dispatch(
      contractRequest('environments.stop', {
        requestId: 'req-stop-event',
        environmentId: FIXTURE_IDS.environment.stopped,
        expectedRevision: 1,
      }),
    );

    expect(received).toHaveLength(1);
  });

  it('re-establishes a subscription when a replayed subscribe was unsubscribed', () => {
    const { runtime } = createReferenceRuntime();
    const received: OperationUpdatedEvent[] = [];
    runtime.subscriptions.onEvent((event) => received.push(event));

    const request = contractRequest('operations.subscribe', { requestId: 'req-sub-replay' });
    const first = runtime.dispatch(request);
    if (!first.ok) {
      throw new Error(`subscribe failed: ${first.error.code}`);
    }
    const firstId = (first.value as SubscriptionRef).subscriptionId;

    runtime.dispatch(
      contractRequest('operations.unsubscribe', {
        requestId: 'req-unsub-replay',
        subscriptionId: firstId,
      }),
    );
    expect(runtime.subscriptions.list()).toEqual([]);

    const replay = runtime.dispatch(request);
    if (!replay.ok) {
      throw new Error(`replay failed: ${replay.error.code}`);
    }
    const replayId = (replay.value as SubscriptionRef).subscriptionId;
    expect(replayId).toBe(firstId);
    expect(runtime.subscriptions.has(replayId)).toBe(true);

    runtime.subscriptions.publish({
      id: 'op-replay',
      sequence: 1,
      phase: 'running',
      status: 'running',
    });
    expect(received.at(-1)?.subscriptionId).toBe(replayId);
  });
});
