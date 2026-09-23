/**
 * Narrow IPC host for the frozen contract (T006 / issue #6).
 *
 * One preload-exposed channel carries the versioned request envelope; a second
 * one-way channel reports the renderer's current environment selection so the
 * native credential menu can target a **validated** environment. There is no
 * generic `invoke`/`send`/`on` surface and no channel is derived from renderer
 * input.
 *
 * Responsibilities:
 * - sender identity: only a main frame whose URL is this build's renderer page
 *   may call, and only for a window this process created;
 * - per-window subscription scope: every window has its own
 *   `SubscriptionRegistry`, so a subscription id from another window is
 *   `NOT_FOUND` and an event is never delivered to the wrong window;
 * - a bounded per-window subscription quota;
 * - release of every subscription and listener when the window is destroyed;
 * - the selection channel stores only an environment id that resolves in the
 *   current environment list (a stale or unknown id is dropped).
 *
 * The host never sees a token URL: `operations.openWebUI` returns only a
 * loopback origin and the token is not part of this contract.
 */
import {
  API_VERSION,
  contractErrorForCode,
  contractFail,
  createContractRuntime,
  environmentSummarySchema,
  isPlainRecord,
  SubscriptionRegistry,
  type ContractPort,
  type ContractResponse,
  type ContractRuntime,
  type EnvironmentSummary,
  type EnvironmentUpdatedEvent,
  type ValidationIssue,
} from '@hdsl/contracts';
import {
  HDSL_CONTRACT_CHANNEL,
  HDSL_ENVIRONMENT_UPDATED_CHANNEL,
  HDSL_OPERATION_UPDATED_CHANNEL,
  HDSL_SELECTION_CHANNEL,
} from '../ipc-channels.js';
import { isTrustedDocumentUrl, type TrustedUrlPolicy } from './trusted-url.js';

export {
  HDSL_CONTRACT_CHANNEL,
  HDSL_ENVIRONMENT_UPDATED_CHANNEL,
  HDSL_OPERATION_UPDATED_CHANNEL,
  HDSL_SELECTION_CHANNEL,
};

/**
 * The only push channels this host may deliver on. The Electron entry's `send`
 * callback receives the channel explicitly, so operation progress and the
 * environment-state projection can never be sent on each other's channel by a
 * hardcoded literal. Both are fixed here and never derived from renderer input.
 */
export type HdslPushChannel =
  | typeof HDSL_OPERATION_UPDATED_CHANNEL
  | typeof HDSL_ENVIRONMENT_UPDATED_CHANNEL;

export const DEFAULT_MAX_SUBSCRIPTIONS_PER_WINDOW = 8;

/** Identity of an IPC caller, derived from the Electron event by the entry glue. */
export interface SenderIdentity {
  readonly webContentsId: number;
  readonly isMainFrame: boolean;
  readonly frameUrl: string;
}

export interface SenderPolicy extends TrustedUrlPolicy {}

/** Exact normalized document-URL match; prefix/suffix/traversal/encoding are rejected. */
export const isAuthorizedSender = (identity: SenderIdentity, policy: SenderPolicy): boolean =>
  identity.isMainFrame && isTrustedDocumentUrl(identity.frameUrl, policy);

export interface OpenedWindow {
  readonly webContentsId: number;
}

interface WindowSession {
  readonly webContentsId: number;
  readonly runtime: ContractRuntime;
  readonly registry: SubscriptionRegistry;
  readonly maxSubscriptions: number;
  /** Fixed-channel sender captured by the Electron entry for this window. */
  readonly send: (channel: HdslPushChannel, event: unknown) => void;
  selection: string | null;
}

const unavailable = (): ContractResponse<never> =>
  contractFail(API_VERSION, contractErrorForCode('INTERNAL_ERROR'));

export interface BeforeDispatchContext {
  readonly method: string;
  readonly input: unknown;
  /** Validated environment id when the method carries one, else null. */
  readonly environmentId: string | null;
}

/**
 * Async pre-dispatch hook used by the entry glue for side effects that must be
 * bound to their real result before success is reported (authenticated WebUI
 * open) and for native prompts (missing credential reference). Returning a
 * response short-circuits dispatch; `undefined` proceeds.
 */
export type BeforeDispatch = (
  context: BeforeDispatchContext,
) => Promise<ContractResponse<unknown> | undefined>;

/**
 * Owns the per-window sessions. The Electron entry calls `openWindow` when it
 * creates a `BrowserWindow`, `closeWindow` on `closed`, and `handle` for every
 * request. Tests drive the same object with a fake `send` and no Electron.
 */
export class DesktopIpcHost {
  readonly #port: ContractPort;
  readonly #policy: SenderPolicy;
  readonly #defaultMaxSubscriptions: number;
  readonly #beforeDispatch: BeforeDispatch | undefined;
  readonly #sessions = new Map<number, WindowSession>();
  readonly #detachers = new Map<number, () => void>();

  constructor(options: {
    readonly port: ContractPort;
    readonly policy: SenderPolicy;
    readonly maxSubscriptionsPerWindow?: number;
    readonly beforeDispatch?: BeforeDispatch;
  }) {
    this.#port = options.port;
    this.#policy = options.policy;
    this.#defaultMaxSubscriptions =
      options.maxSubscriptionsPerWindow ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_WINDOW;
    this.#beforeDispatch = options.beforeDispatch;
  }

  /** Registers a window and starts forwarding its operation events to `send`. */
  openWindow(options: {
    readonly webContentsId: number;
    readonly send: (channel: HdslPushChannel, event: unknown) => void;
    readonly maxSubscriptions?: number;
  }): OpenedWindow {
    this.closeWindow(options.webContentsId);
    const registry = new SubscriptionRegistry();
    const detach = registry.onEvent((event) => {
      options.send(HDSL_OPERATION_UPDATED_CHANNEL, event);
    });
    const session: WindowSession = {
      webContentsId: options.webContentsId,
      runtime: createContractRuntime({ port: this.#port, subscriptions: registry }),
      registry,
      maxSubscriptions: options.maxSubscriptions ?? this.#defaultMaxSubscriptions,
      send: options.send,
      selection: null,
    };
    // `detach` is stored on the registry closure via the map value below.
    this.#detachers.set(options.webContentsId, detach);
    this.#sessions.set(options.webContentsId, session);
    return { webContentsId: options.webContentsId };
  }

  /**
   * Releases every subscription, listener and selection for one window. Safe to
   * call more than once; the Electron `closed` handler and tests both rely on
   * that.
   */
  closeWindow(webContentsId: number): void {
    const session = this.#sessions.get(webContentsId);
    if (session !== undefined) {
      for (const reference of session.registry.list()) {
        session.registry.unsubscribe(reference.subscriptionId);
      }
      this.#sessions.delete(webContentsId);
    }
    const detach = this.#detachers.get(webContentsId);
    if (detach !== undefined) {
      detach();
      this.#detachers.delete(webContentsId);
    }
  }

  hasWindow(webContentsId: number): boolean {
    return this.#sessions.has(webContentsId);
  }

  /**
   * Projects one environment state change to every open window on the fixed
   * `environment.updated` channel. This is how a managed process exiting outside
   * any renderer-issued operation reaches the UI without polling.
   *
   * The summary is re-validated against the shared `EnvironmentSummary` schema
   * before it crosses the bridge; an invalid projection is dropped (returns 0)
   * rather than forwarded. The channel is fixed here and is never derived from
   * renderer input, and a destroyed window cannot abort delivery to the others.
   * Returns the number of windows that received the event.
   */
  broadcastEnvironmentUpdate(environment: EnvironmentSummary): number {
    const issues: ValidationIssue[] = [];
    const parsed = environmentSummarySchema(environment, 'environment', issues);
    if (parsed === undefined) {
      return 0;
    }
    const event: EnvironmentUpdatedEvent = { environment: parsed };
    let delivered = 0;
    for (const session of this.#sessions.values()) {
      try {
        session.send(HDSL_ENVIRONMENT_UPDATED_CHANNEL, event);
        delivered += 1;
      } catch {
        // A window that has gone away must not break delivery to the rest.
      }
    }
    return delivered;
  }

  /** Number of live subscriptions for a window; used by tests and quota checks. */
  subscriptionCount(webContentsId: number): number {
    return this.#sessions.get(webContentsId)?.registry.list().length ?? 0;
  }

  /**
   * Stores an environment selection only when it resolves in the current
   * environment list. A stale id from a previous render is therefore dropped
   * instead of being remembered.
   */
  selectEnvironment(webContentsId: number, environmentId: unknown): boolean {
    const session = this.#sessions.get(webContentsId);
    if (session === undefined || typeof environmentId !== 'string') {
      return false;
    }
    const found = this.#port.findEnvironment(environmentId);
    if (!found.ok) {
      session.selection = null;
      return false;
    }
    session.selection = found.value.id;
    return true;
  }

  /** Last validated selection for a window, or null. */
  selectionFor(webContentsId: number): string | null {
    return this.#sessions.get(webContentsId)?.selection ?? null;
  }

  /**
   * Handles one request. Unauthorized senders and unknown windows fail closed
   * with a controlled envelope; the frozen dispatcher performs every other
   * validation.
   */
  async handle(identity: SenderIdentity, payload: unknown): Promise<ContractResponse<unknown>> {
    if (!isAuthorizedSender(identity, this.#policy)) {
      return unavailable();
    }
    const session = this.#sessions.get(identity.webContentsId);
    if (session === undefined) {
      return unavailable();
    }
    const method = isPlainRecord(payload) ? payload['method'] : undefined;
    if (method === 'operations.subscribe' && session.registry.list().length >= session.maxSubscriptions) {
      // Resource guard, not a contract method: reject before the registry grows.
      return contractFail(API_VERSION, contractErrorForCode('ENVIRONMENT_BUSY'));
    }
    if (typeof method === 'string' && this.#beforeDispatch !== undefined) {
      const input = isPlainRecord(payload) ? payload['input'] : undefined;
      const environmentId = isPlainRecord(input) && typeof input['environmentId'] === 'string'
        ? input['environmentId']
        : null;
      const shortCircuit = await this.#beforeDispatch({ method, input, environmentId });
      if (shortCircuit !== undefined) {
        return shortCircuit;
      }
    }
    return session.runtime.dispatch(payload);
  }
}
