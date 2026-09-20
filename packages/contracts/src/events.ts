/**
 * `operation.updated` event channel and the per-operation sequence invariant.
 *
 * `sequence` is the operation's own monotonic counter, shared with
 * `Operation.sequence` and `OperationSnapshot.sequence` — not a per-subscription
 * counter. A multi-operation subscription therefore sees one independent
 * increasing sequence per `operationId`. `SubscriptionRegistry.publish`
 * enforces strict monotonicity so a downstream producer cannot emit a
 * regressing or duplicated sequence.
 */
import { operationIdSchema, subscriptionIdSchema } from './ids.js';
import { operationStatusSchema, type SubscriptionRef } from './dto.js';
import { sInteger, sNumber, sObject, sOptional, sString, type Infer } from './schema.js';

export const OPERATION_UPDATED_CHANNEL = 'operation.updated' as const;

export const operationUpdatedEventSchema = sObject({
  subscriptionId: subscriptionIdSchema,
  operationId: operationIdSchema,
  sequence: sInteger({ min: 0 }),
  phase: sString({ minLength: 1, maxLength: 64 }),
  status: operationStatusSchema,
  progress: sOptional(sNumber({ min: 0, max: 100 })),
});
export type OperationUpdatedEvent = Infer<typeof operationUpdatedEventSchema>;

interface SubscriptionEntry {
  readonly operationId: string | null;
}

/**
 * In-memory subscription registry. Subscriptions are session-scoped, so the
 * contract owns the registry and downstream sessions reuse this instance
 * instead of re-implementing the sequence rule.
 */
export class SubscriptionRegistry {
  readonly #entries = new Map<string, SubscriptionEntry>();
  readonly #lastSequence = new Map<string, number>();
  readonly #listeners = new Set<(event: OperationUpdatedEvent) => void>();
  #counter = 0;

  /** `null` subscribes to every operation; a concrete id scopes to one. */
  subscribe(operationId: string | null): SubscriptionRef {
    this.#counter += 1;
    const subscriptionId = `sub-${this.#counter}`;
    this.#entries.set(subscriptionId, { operationId });
    return { subscriptionId };
  }

  /**
   * Registers a sink (main forwards events to the subscribed renderer). Returns
   * an unsubscribe function for the listener; it is separate from protocol
   * `operations.unsubscribe`.
   */
  onEvent(listener: (event: OperationUpdatedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Returns false for an unknown subscription id (dispatcher maps it to NOT_FOUND). */
  unsubscribe(subscriptionId: string): boolean {
    return this.#entries.delete(subscriptionId);
  }

  list(): readonly SubscriptionRef[] {
    return [...this.#entries.keys()].map((subscriptionId) => ({ subscriptionId }));
  }

  /**
   * Emits one event per matching subscription using the operation's own
   * sequence. Throws when a producer publishes a sequence that does not
   * strictly increase for that operation.
   */
  publish(operation: {
    readonly id: string;
    readonly sequence: number;
    readonly phase: string;
    readonly status: OperationUpdatedEvent['status'];
    readonly progress?: number | undefined;
  }): readonly OperationUpdatedEvent[] {
    const previous = this.#lastSequence.get(operation.id);
    if (previous !== undefined && operation.sequence <= previous) {
      throw new RangeError(
        `operation ${operation.id} sequence must strictly increase (received ${operation.sequence} after ${previous})`,
      );
    }
    this.#lastSequence.set(operation.id, operation.sequence);
    const events: OperationUpdatedEvent[] = [];
    for (const [subscriptionId, entry] of this.#entries) {
      if (entry.operationId !== null && entry.operationId !== operation.id) {
        continue;
      }
      const event: OperationUpdatedEvent = {
        subscriptionId,
        operationId: operation.id,
        sequence: operation.sequence,
        phase: operation.phase,
        status: operation.status,
        ...(operation.progress === undefined ? {} : { progress: operation.progress }),
      };
      events.push(event);
    }
    for (const event of events) {
      for (const listener of this.#listeners) {
        listener(event);
      }
    }
    return events;
  }
}
