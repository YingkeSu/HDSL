/**
 * `operation.updated` event channel and the per-operation sequence invariant.
 *
 * `sequence` is the operation's own monotonic counter, shared with
 * `Operation.sequence` and `OperationSnapshot.sequence` — not a per-subscription
 * counter. A multi-operation subscription therefore sees one independent
 * increasing sequence per `operationId`. `SubscriptionRegistry.publish`
 * enforces strict monotonicity, validates the event against the shared schema
 * and sanitizes/bounds the phase text, so a downstream producer cannot emit a
 * regressing sequence or a credential-bearing, over-long event.
 *
 * Subscriptions carry an optional opaque `owner` (a trusted call context such as
 * a window id). T003's dispatcher does not have a sender and passes `null`;
 * wiring the real per-window sender identity is a T006 responsibility. The
 * `owner` parameter exists so T006 can isolate callers without a contract
 * change, and no per-window isolation is claimed here.
 */
import { operationIdSchema, subscriptionIdSchema } from './ids.js';
import {
  operationPhaseSchema,
  operationStatusSchema,
  sanitizeOperationPhase,
  type SubscriptionRef,
} from './dto.js';
import {
  sInteger,
  sNumber,
  sObject,
  sOptional,
  type Infer,
  type ValidationIssue,
} from './schema.js';

export const OPERATION_UPDATED_CHANNEL = 'operation.updated' as const;

export const operationUpdatedEventSchema = sObject({
  subscriptionId: subscriptionIdSchema,
  operationId: operationIdSchema,
  sequence: sInteger({ min: 0 }),
  phase: operationPhaseSchema,
  status: operationStatusSchema,
  progress: sOptional(sNumber({ min: 0, max: 100 })),
});
export type OperationUpdatedEvent = Infer<typeof operationUpdatedEventSchema>;

interface SubscriptionEntry {
  readonly operationId: string | null;
  readonly owner: string | null;
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
  subscribe(operationId: string | null, owner: string | null = null): SubscriptionRef {
    this.#counter += 1;
    const subscriptionId = `sub-${String(this.#counter)}`;
    this.#entries.set(subscriptionId, { operationId, owner });
    return { subscriptionId };
  }

  /**
   * Re-establishes a subscription under its original id (used when a replayed
   * `operations.subscribe` refers to a subscription that was unsubscribed).
   */
  reinstate(subscriptionId: string, operationId: string | null, owner: string | null = null): SubscriptionRef {
    if (!this.#entries.has(subscriptionId)) {
      this.#entries.set(subscriptionId, { operationId, owner });
    }
    return { subscriptionId };
  }

  /** Returns false for an unknown subscription id or an owner mismatch. */
  unsubscribe(subscriptionId: string, owner: string | null = null): boolean {
    const entry = this.#entries.get(subscriptionId);
    if (entry === undefined) {
      return false;
    }
    if (entry.owner !== null && entry.owner !== owner) {
      return false;
    }
    return this.#entries.delete(subscriptionId);
  }

  /** True while the subscription can still receive events. */
  has(subscriptionId: string): boolean {
    return this.#entries.has(subscriptionId);
  }

  list(owner?: string | null): readonly SubscriptionRef[] {
    return [...this.#entries.entries()]
      .filter(([, entry]) => owner === undefined || entry.owner === owner)
      .map(([subscriptionId]) => ({ subscriptionId }));
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

  /**
   * Emits one event per matching subscription using the operation's own
   * sequence. Throws when a producer publishes a sequence that does not
   * strictly increase, or when the resulting event fails schema validation.
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
    const phase = sanitizeOperationPhase(operation.phase);
    const events: OperationUpdatedEvent[] = [];
    for (const [subscriptionId, entry] of this.#entries) {
      if (entry.operationId !== null && entry.operationId !== operation.id) {
        continue;
      }
      const event: OperationUpdatedEvent = {
        subscriptionId,
        operationId: operation.id,
        sequence: operation.sequence,
        phase,
        status: operation.status,
        ...(operation.progress === undefined ? {} : { progress: operation.progress }),
      };
      const issues: ValidationIssue[] = [];
      if (operationUpdatedEventSchema(event, 'event', issues) === undefined) {
        throw new RangeError('operation.updated event failed schema validation');
      }
      events.push(event);
    }
    for (const event of events) {
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          // A faulty listener must not drop events for the other listeners.
        }
      }
    }
    return events;
  }
}
