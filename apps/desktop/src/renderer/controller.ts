/**
 * Renderer environment controller (T006a).
 *
 * Framework-free state machine over the **frozen** contract. It receives one
 * restricted {@link RendererContractClient} by explicit injection and calls only
 * the whitelisted methods; there is no Node, filesystem, arbitrary IPC or token
 * URL handling in this module.
 *
 * Contract rules honored here:
 * - every mutating call carries a freshly generated opaque `requestId`
 *   (`REQUEST_ID_PATTERN`); read-only calls carry none;
 * - `expectedRevision` is the selected environment's **composition revision**
 *   (`revision`), never `stateVersion`;
 * - tracking an operation establishes `operations.subscribe` and unsubscribe is
 *   always called on terminal or `dispose` (no leaked subscription);
 * - outbound values are re-validated against the shared DTO schemas, so a
 *   malformed or extra-field value (for example a token-bearing WebUI URL) is
 *   rejected as `INTERNAL_ERROR`/`WEBUI_UNAVAILABLE` instead of being shown;
 * - `openWebUI` only displays a verified loopback origin and never forwards the
 *   token URL that main keeps private.
 *
 * The developer demo and unit tests inject an explicit client; the production
 * entry never creates one and never falls back to a mock.
 */
import {
  API_VERSION,
  contractErrorForCode,
  contractErrorSchema,
  environmentSummaryListSchema,
  exportResultSchema,
  formatValidationIssues,
  isLoopbackOrigin,
  isPlainRecord,
  nameSchema,
  openWebUIResultSchema,
  operationRefSchema,
  operationSnapshotSchema,
  REQUEST_ID_PATTERN,
  runtimeCombinationListSchema,
  subscriptionRefSchema,
  type ContractError,
  type ContractMethod,
  type OperationSnapshot,
  type OperationUpdatedEvent,
  type Schema,
  type ValidationIssue,
} from '@hdsl/contracts';
import type { RendererContractClient } from './contract.js';
import {
  INITIAL_STATE,
  isOperationTerminal,
  selectedEnvironment,
  type RendererActions,
  type RendererState,
  type TrackedOperation,
} from './view-model.js';

/**
 * Renderer-side mirror of the frozen `operation.updated` push channel.
 *
 * T006a only defines the injection point; wiring the preload transport that
 * forwards **validated** `operation.updated` events is T006b and is therefore
 * reported as 未接入. When no source is provided the controller falls back to
 * bounded `operations.get` polling so progress is still observable.
 */
export interface RendererEventSource {
  subscribe(listener: (event: OperationUpdatedEvent) => void): () => void;
}

export interface RendererControllerOptions {
  readonly client: RendererContractClient;
  /** True only when an explicit mock/demo client was injected. */
  readonly demo?: boolean | undefined;
  readonly events?: RendererEventSource | undefined;
  /** Polling interval in milliseconds; injectable for tests. */
  readonly pollIntervalMs?: number | undefined;
  /** Request id factory; injectable for deterministic tests. */
  readonly createRequestId?: (() => string) | undefined;
}

type CallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractError };

const nullOnlySchema: Schema<null> = (value, path, issues) => {
  if (value === null) {
    return null;
  }
  issues.push({ path, message: 'must be null' });
  return undefined;
};

const toTrackedOperation = (snapshot: OperationSnapshot): TrackedOperation => ({
  operationId: snapshot.id,
  kind: snapshot.kind,
  phase: snapshot.phase,
  status: snapshot.status,
  sequence: snapshot.sequence,
  progress: snapshot.progress ?? null,
  environmentId: snapshot.environmentId,
  error: snapshot.error ?? null,
});

const DEFAULT_POLL_INTERVAL_MS = 400;

export class RendererController implements RendererActions {
  readonly #client: RendererContractClient;
  readonly #events: RendererEventSource | null;
  readonly #pollIntervalMs: number;
  readonly #createRequestId: ((() => string) | undefined);
  readonly #listeners = new Set<() => void>();
  readonly #subscriptions = new Map<string, string>();
  #state: RendererState;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #detachEvents: (() => void) | null = null;
  #requestCounter = 0;
  #disposed = false;

  constructor(options: RendererControllerOptions) {
    this.#client = options.client;
    this.#events = options.events ?? null;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#createRequestId = options.createRequestId;
    this.#state = { ...INITIAL_STATE, demo: options.demo ?? false };
    if (this.#events !== null) {
      this.#detachEvents = this.#events.subscribe((event) => {
        this.#handleEvent(event);
      });
    }
  }

  /** Stable store read for `useSyncExternalStore`. */
  readonly getState = (): RendererState => this.#state;

  /** Stable store subscription for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // --- actions -------------------------------------------------------------

  async load(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#update({ phase: 'loading', loadError: null, actionError: null });
    const [catalog, environments] = await Promise.all([
      this.#call('catalog.list', {}, runtimeCombinationListSchema),
      this.#call('environments.list', {}, environmentSummaryListSchema),
    ]);
    if (this.#disposed) {
      return;
    }
    if (!catalog.ok) {
      this.#update({ phase: 'failed', loadError: catalog.error });
      return;
    }
    if (!environments.ok) {
      this.#update({ phase: 'failed', loadError: environments.error });
      return;
    }
    const environmentsList = environments.value;
    const selected = this.#state.selectedEnvironmentId;
    const selectionStillExists =
      selected !== null && environmentsList.some((environment) => environment.id === selected);
    const combination = this.#state.createCombinationId;
    const combinationStillExists =
      combination !== null && catalog.value.some((entry) => entry.id === combination);
    this.#update({
      phase: 'ready',
      catalog: catalog.value,
      environments: environmentsList,
      selectedEnvironmentId: selectionStillExists
        ? selected
        : (environmentsList[0]?.id ?? null),
      createCombinationId: combinationStillExists
        ? combination
        : (catalog.value[0]?.id ?? null),
    });
  }

  async refresh(): Promise<void> {
    await this.load();
  }

  setCreateName(name: string): void {
    this.#update({ createName: name, createError: null });
  }

  setCreateCombinationId(combinationId: string): void {
    this.#update({ createCombinationId: combinationId, createError: null });
  }

  async createEnvironment(): Promise<void> {
    const { createName: name, createCombinationId } = this.#state;
    const issues: ValidationIssue[] = [];
    if (nameSchema(name, 'name', issues) === undefined) {
      this.#update({ createError: formatValidationIssues(issues), actionError: null });
      return;
    }
    if (createCombinationId === null) {
      this.#update({ createError: '请选择一个已核验的运行时组合', actionError: null });
      return;
    }
    this.#update({
      createError: null,
      actionError: null,
      notice: null,
      exportResult: null,
      webUIOrigin: null,
    });
    const result = await this.#call(
      'environments.create',
      { requestId: this.#newRequestId(), name, catalogCombinationId: createCombinationId },
      operationRefSchema,
    );
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    this.#update({ createName: '' });
    await this.#trackOperation(result.value.operationId);
    await this.#refreshEnvironments();
  }

  selectEnvironment(environmentId: string): void {
    this.#update({
      selectedEnvironmentId: environmentId,
      actionError: null,
      webUIOrigin: null,
      exportResult: null,
    });
  }

  async startSelected(): Promise<void> {
    await this.#revisionCommand('environments.start');
  }

  async stopSelected(): Promise<void> {
    await this.#revisionCommand('environments.stop');
  }

  async openWebUI(): Promise<void> {
    const environment = selectedEnvironment(this.#state);
    if (environment === null) {
      this.#update({ actionError: contractErrorForCode('INVALID_INPUT') });
      return;
    }
    this.#update({ actionError: null, notice: null, webUIOrigin: null });
    const result = await this.#call(
      'environments.openWebUI',
      { requestId: this.#newRequestId(), environmentId: environment.id },
      openWebUIResultSchema,
    );
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    // Defence in depth: even though the dispatcher already rejects non-loopback
    // origins, the renderer refuses to display anything else. The token URL
    // never reaches this layer.
    if (!isLoopbackOrigin(result.value.loopbackOrigin)) {
      this.#update({ actionError: contractErrorForCode('WEBUI_UNAVAILABLE') });
      return;
    }
    this.#update({
      webUIOrigin: result.value.loopbackOrigin,
      notice: 'WebUI 已由主进程打开；此处只显示已验证的 loopback 地址。',
    });
  }

  async exportDiagnostics(): Promise<void> {
    const environment = selectedEnvironment(this.#state);
    if (environment === null) {
      this.#update({ actionError: contractErrorForCode('INVALID_INPUT') });
      return;
    }
    this.#update({ actionError: null, notice: null, exportResult: null });
    const result = await this.#call(
      'diagnostics.export',
      { requestId: this.#newRequestId(), environmentId: environment.id },
      exportResultSchema,
    );
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    this.#update({
      exportResult: result.value,
      notice: '诊断导出完成（已脱敏；结果不含本地路径）。',
    });
  }

  async cancelTrackedOperation(): Promise<void> {
    const tracked = this.#state.trackedOperation;
    if (tracked === null || isOperationTerminal(tracked.status)) {
      return;
    }
    const result = await this.#call(
      'operations.cancel',
      { requestId: this.#newRequestId(), operationId: tracked.operationId },
      operationSnapshotSchema,
    );
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    this.#applySnapshot(result.value);
  }

  /**
   * Releases every subscription and timer. Returns after the unsubscribe calls
   * are dispatched, so tests can assert cleanup deterministically.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#clearPollTimer();
    this.#detachEvents?.();
    this.#detachEvents = null;
    const subscriptionIds = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const subscriptionId of subscriptionIds) {
      await this.#unsubscribe(subscriptionId);
    }
  }

  // --- operation tracking --------------------------------------------------

  async #revisionCommand(method: 'environments.start' | 'environments.stop'): Promise<void> {
    const environment = selectedEnvironment(this.#state);
    if (environment === null) {
      this.#update({ actionError: contractErrorForCode('INVALID_INPUT') });
      return;
    }
    this.#update({ actionError: null, notice: null, webUIOrigin: null });
    // `expectedRevision` is the composition revision, not the state version.
    const result = await this.#call(
      method,
      {
        requestId: this.#newRequestId(),
        environmentId: environment.id,
        expectedRevision: environment.revision,
      },
      operationRefSchema,
    );
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    await this.#trackOperation(result.value.operationId);
    await this.#refreshEnvironments();
  }

  async #trackOperation(operationId: string): Promise<void> {
    await this.#stopTracking();
    const snapshot = await this.#call('operations.get', { operationId }, operationSnapshotSchema);
    if (!snapshot.ok) {
      this.#update({ actionError: snapshot.error });
      return;
    }
    this.#update({ trackedOperation: toTrackedOperation(snapshot.value) });
    await this.#subscribeTo(operationId);
    if (isOperationTerminal(snapshot.value.status)) {
      await this.#completeTracking();
    } else {
      this.#schedulePoll();
    }
  }

  async #subscribeTo(operationId: string): Promise<void> {
    const result = await this.#call(
      'operations.subscribe',
      { requestId: this.#newRequestId(), operationId },
      subscriptionRefSchema,
    );
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    this.#subscriptions.set(operationId, result.value.subscriptionId);
  }

  async #unsubscribe(subscriptionId: string): Promise<void> {
    await this.#call(
      'operations.unsubscribe',
      { requestId: this.#newRequestId(), subscriptionId },
      nullOnlySchema,
    );
  }

  #schedulePoll(): void {
    if (this.#disposed || this.#pollTimer !== null) {
      return;
    }
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.#poll();
    }, this.#pollIntervalMs);
  }

  async #poll(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const tracked = this.#state.trackedOperation;
    if (tracked === null || isOperationTerminal(tracked.status)) {
      return;
    }
    const result = await this.#call(
      'operations.get',
      { operationId: tracked.operationId },
      operationSnapshotSchema,
    );
    if (this.#disposed) {
      return;
    }
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    this.#applySnapshot(result.value);
    const current = this.#state.trackedOperation;
    if (current !== null && !isOperationTerminal(current.status)) {
      this.#schedulePoll();
    }
  }

  #applySnapshot(snapshot: OperationSnapshot): void {
    const current = this.#state.trackedOperation;
    if (
      current !== null &&
      snapshot.id === current.operationId &&
      snapshot.sequence < current.sequence
    ) {
      // Stale snapshot/event: never move the view backwards.
      return;
    }
    this.#update({ trackedOperation: toTrackedOperation(snapshot) });
    if (isOperationTerminal(snapshot.status)) {
      void this.#completeTracking();
    }
  }

  async #completeTracking(): Promise<void> {
    this.#clearPollTimer();
    const tracked = this.#state.trackedOperation;
    if (tracked === null) {
      return;
    }
    const subscriptionId = this.#subscriptions.get(tracked.operationId);
    if (subscriptionId !== undefined) {
      this.#subscriptions.delete(tracked.operationId);
      await this.#unsubscribe(subscriptionId);
    }
    if (tracked.status === 'succeeded') {
      await this.#refreshEnvironments();
    }
  }

  async #stopTracking(): Promise<void> {
    this.#clearPollTimer();
    const subscriptionIds = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const subscriptionId of subscriptionIds) {
      await this.#unsubscribe(subscriptionId);
    }
    this.#update({ trackedOperation: null });
  }

  async #refreshEnvironments(): Promise<void> {
    const result = await this.#call('environments.list', {}, environmentSummaryListSchema);
    if (this.#disposed) {
      return;
    }
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    const environments = result.value;
    const selected = this.#state.selectedEnvironmentId;
    const selectionStillExists =
      selected !== null && environments.some((environment) => environment.id === selected);
    this.#update({
      environments,
      selectedEnvironmentId: selectionStillExists
        ? selected
        : (environments[0]?.id ?? null),
    });
  }

  #handleEvent(event: OperationUpdatedEvent): void {
    if (this.#disposed) {
      return;
    }
    const current = this.#state.trackedOperation;
    if (current === null || current.operationId !== event.operationId) {
      return;
    }
    if (event.sequence <= current.sequence) {
      return;
    }
    this.#update({
      trackedOperation: {
        ...current,
        phase: event.phase,
        status: event.status,
        sequence: event.sequence,
        progress: event.progress ?? current.progress,
      },
    });
    if (isOperationTerminal(event.status)) {
      void this.#completeTracking();
    }
  }

  #clearPollTimer(): void {
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  #newRequestId(): string {
    const factory = this.#createRequestId;
    if (factory !== undefined) {
      const candidate = factory();
      if (REQUEST_ID_PATTERN.test(candidate)) {
        return candidate;
      }
    }
    for (;;) {
      this.#requestCounter += 1;
      const candidate = `req-${this.#requestCounter.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      if (REQUEST_ID_PATTERN.test(candidate)) {
        return candidate;
      }
    }
  }

  #update(patch: Partial<RendererState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A faulty subscriber must not break the state machine.
      }
    }
  }

  // --- transport -----------------------------------------------------------

  #parseEnvelope(
    response: unknown,
  ): { readonly value: unknown } | { readonly error: ContractError } {
    if (!isPlainRecord(response)) {
      return { error: contractErrorForCode('INTERNAL_ERROR') };
    }
    if (response['apiVersion'] !== API_VERSION) {
      return { error: contractErrorForCode('CONTRACT_VERSION_MISMATCH') };
    }
    if (response['ok'] !== true) {
      const issues: ValidationIssue[] = [];
      return {
        error:
          contractErrorSchema(response['error'], 'error', issues) ??
          contractErrorForCode('INTERNAL_ERROR'),
      };
    }
    return { value: response['value'] };
  }

  async #invoke(
    method: ContractMethod,
    input: unknown,
  ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ContractError }> {
    let response: unknown;
    try {
      response = await this.#client.call(method, input);
    } catch {
      return { ok: false, error: contractErrorForCode('INTERNAL_ERROR') };
    }
    const parsed = this.#parseEnvelope(response);
    return 'error' in parsed
      ? { ok: false, error: parsed.error }
      : { ok: true, value: parsed.value };
  }

  async #call<T>(method: ContractMethod, input: unknown, schema: Schema<T>): Promise<CallResult<T>> {
    const result = await this.#invoke(method, input);
    if (!result.ok) {
      return result;
    }
    const issues: ValidationIssue[] = [];
    const value = schema(result.value, 'value', issues);
    if (value === undefined) {
      return { ok: false, error: contractErrorForCode('INTERNAL_ERROR') };
    }
    return { ok: true, value };
  }
}
