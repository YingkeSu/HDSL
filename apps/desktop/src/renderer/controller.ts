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
 * Concurrency rules (review P2-1/P2-2/P3):
 * - one **tracking epoch** owns the current operation. Starting a new track,
 *   cancelling tracking and `dispose` all bump the epoch, and every async
 *   continuation re-checks it after each `await` before touching state or
 *   creating/releasing subscriptions (no stale cross-operation result can
 *   overwrite a newer track, and a subscription created after invalidation is
 *   released immediately);
 * - user commands expose a `commandPending` flag for UI button disabling. It is
 *   intentionally not a hard lock: a repeated click still issues its own call
 *   with a fresh `requestId` (independent QA acceptance), and the tracking epoch
 *   keeps the later call authoritative;
 * - polling failures retry with bounded backoff and then pause with a visible
 *   retry action instead of freezing silently.
 *
 * The developer demo and unit tests inject an explicit client; the production
 * entry never creates one and never falls back to a mock.
 */
import {
  API_VERSION,
  contractErrorForCode,
  contractErrorSchema,
  DEFAULT_PLUGIN_QUERY,
  environmentSummaryListSchema,
  exportResultSchema,
  isLoopbackOrigin,
  isPlainRecord,
  openWebUIResultSchema,
  operationRefSchema,
  operationSnapshotSchema,
  pluginInspectionSchema,
  changePlanSchema,
  changeApplicationSchema,
  dshVersionListingSchema,
  expectedCompositionViewSchema,
  generationSummaryListSchema,
  generationSummarySchema,
  installedPluginsViewSchema,
  pluginSearchResultSchema,
  REQUEST_ID_PATTERN,
  runtimeCombinationListSchema,
  subscriptionRefSchema,
  type ContractError,
  type ContractMethod,
  type EnvironmentSummary,
  type OperationSnapshot,
  type OperationUpdatedEvent,
  type Schema,
  type ValidationIssue,
} from '@hdsl/contracts';
import type { RendererContractClient } from './contract.js';
import {
  INITIAL_STATE,
  installSourceSelector,
  isOperationTerminal,
  selectedEnvironment,
  selectedInstalledPlugin,
  selectedPluginHit,
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
  /**
   * Optional projection of an environment state change that was **not** caused
   * by a renderer-issued operation (a managed process exiting on its own,
   * FR-005). When provided, the controller merges the authoritative summary
   * immediately, so the UI converges without a manual refresh or polling. When
   * absent the controller behaves exactly as before (no environment push).
   */
  subscribeEnvironment?(listener: (environment: EnvironmentSummary) => void): () => void;
}

export interface RendererControllerOptions {
  readonly client: RendererContractClient;
  /** True only when an explicit mock/demo client was injected. */
  readonly demo?: boolean | undefined;
  readonly events?: RendererEventSource | undefined;
  /** Polling interval in milliseconds; injectable for tests. */
  readonly pollIntervalMs?: number | undefined;
  /** Bounded poll retries after a transient `operations.get` failure. */
  readonly maxPollRetries?: number | undefined;
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
  output: snapshot.output ?? null,
});

const PLUGIN_OPERATION_KINDS: ReadonlySet<string> = new Set(['search', 'inspect']);

const DEFAULT_POLL_INTERVAL_MS = 400;
const DEFAULT_MAX_POLL_RETRIES = 3;

export class RendererController implements RendererActions {
  readonly #client: RendererContractClient;
  readonly #events: RendererEventSource | null;
  readonly #pollIntervalMs: number;
  readonly #maxPollRetries: number;
  readonly #createRequestId: ((() => string) | undefined);
  readonly #listeners = new Set<() => void>();
  readonly #subscriptions = new Map<string, string>();
  #state: RendererState;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #detachEvents: (() => void) | null = null;
  #detachEnvironment: (() => void) | null = null;
  #requestCounter = 0;
  #disposed = false;
  /** Bumped whenever the tracked operation or disposal changes. */
  #trackingEpoch = 0;
  #pollFailures = 0;
  #pendingCommands = 0;

  constructor(options: RendererControllerOptions) {
    if (options.client === undefined || options.client === null) {
      throw new Error(
        'RendererController requires an explicit RendererContractClient; production must not fall back to a mock client.',
      );
    }
    this.#client = options.client;
    this.#events = options.events ?? null;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxPollRetries = Math.max(1, options.maxPollRetries ?? DEFAULT_MAX_POLL_RETRIES);
    this.#createRequestId = options.createRequestId;
    this.#state = { ...INITIAL_STATE, demo: options.demo ?? false };
    const source = this.#events;
    if (source !== null) {
      this.#detachEvents = source.subscribe((event) => {
        this.#handleEvent(event);
      });
      this.#detachEnvironment =
        source.subscribeEnvironment?.((environment) => {
          this.#handleEnvironmentProjection(environment);
        }) ?? null;
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
    await this.#runCommand(async () => {
      await this.load();
    });
  }

  setCreateName(name: string): void {
    this.#update({ createName: name, createError: null });
  }

  setCreateCombinationId(combinationId: string): void {
    this.#update({ createCombinationId: combinationId, createError: null });
  }

  async createEnvironment(): Promise<void> {
    await this.#runCommand(async () => {
      const { createName: name, createCombinationId } = this.#state;
      if (createCombinationId === null) {
        this.#update({ createError: '请选择一个已核验的运行时组合', actionError: null });
        return;
      }
      // Name validity (1-80 chars, no path separators) is enforced by the frozen
      // `environments.create` schema in main; the renderer dispatches and shows
      // the contract's sanitized `INVALID_INPUT` instead of duplicating the rule.
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
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      this.#update({ createName: '' });
      await this.#trackOperation(result.value.operationId);
      await this.#refreshEnvironments();
    });
  }

  selectEnvironment(environmentId: string): void {
    this.#update({
      selectedEnvironmentId: environmentId,
      actionError: null,
      webUIOrigin: null,
      exportResult: null,
      installedPlugins: null,
      selectedInstalledPluginId: null,
      // Expected composition is environment-scoped: a previously loaded dump
      // must never be shown for a newly selected environment.
      expectedComposition: null,
    });
  }

  async startSelected(): Promise<void> {
    await this.#runCommand(async () => {
      await this.#revisionCommand('environments.start');
    });
  }

  async stopSelected(): Promise<void> {
    await this.#runCommand(async () => {
      await this.#revisionCommand('environments.stop');
    });
  }

  async openWebUI(): Promise<void> {
    await this.#runCommand(async () => {
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
      if (this.#disposed) {
        return;
      }
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
    });
  }

  async exportDiagnostics(): Promise<void> {
    await this.#runCommand(async () => {
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
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      this.#update({
        exportResult: result.value,
        notice: '诊断导出完成（已脱敏；结果不含本地路径）。',
      });
    });
  }

  setPluginQuery(query: string): void {
    this.#update({ pluginQuery: query, actionError: null, pluginInspection: null });
  }

  resetPluginQuery(): void {
    this.#update({
      pluginQuery: DEFAULT_PLUGIN_QUERY,
      actionError: null,
      pluginInspection: null,
    });
  }

  async runPluginSearch(): Promise<void> {
    await this.#runCommand(async () => {
      this.#update({
        actionError: null,
        notice: null,
        pluginSearch: null,
        pluginInspection: null,
        selectedPluginFullName: null,
      });
      const result = await this.#call(
        'plugins.search',
        { requestId: this.#newRequestId(), query: this.#state.pluginQuery },
        operationRefSchema,
      );
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      await this.#trackOperation(result.value.operationId);
    });
  }

  /** Fetches authoritative repository detail for the selected hit. */
  async inspectSelectedPlugin(): Promise<void> {
    await this.#runCommand(async () => {
      const hit = selectedPluginHit(this.#state);
      if (hit === null) {
        this.#update({ actionError: contractErrorForCode('INVALID_INPUT') });
        return;
      }
      this.#update({ actionError: null, notice: null, pluginInspection: null });
      const result = await this.#call(
        'plugins.inspect',
        {
          requestId: this.#newRequestId(),
          source: { owner: hit.owner, name: hit.name },
        },
        operationRefSchema,
      );
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      await this.#trackOperation(result.value.operationId);
    });
  }

  selectPlugin(fullName: string | null): void {
    this.#update({ selectedPluginFullName: fullName, pluginInspection: null });
  }

  /**
   * Cancels only an in-flight plugin discovery operation. Cancellation is a
   * terminal state with no side effect (ADR 0005 D10); a finished search keeps
   * its result and cannot be cancelled.
   */
  async cancelPluginSearch(): Promise<void> {
    const tracked = this.#state.trackedOperation;
    if (
      tracked === null ||
      !PLUGIN_OPERATION_KINDS.has(tracked.kind ?? '') ||
      isOperationTerminal(tracked.status)
    ) {
      return;
    }
    await this.cancelTrackedOperation();
  }

  /**
   * Starts the read-only `versions.dsh` upstream DSH version listing (A1/#113).
   * Global and environment-independent; the terminal listing is re-validated in
   * `#applyPluginOutput` before it can reach the UI.
   */
  async loadDshVersions(): Promise<void> {
    await this.#runCommand(async () => {
      this.#update({ actionError: null, notice: null, dshVersions: null });
      const result = await this.#call(
        'versions.dsh',
        { requestId: this.#newRequestId() },
        operationRefSchema,
      );
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      await this.#trackOperation(result.value.operationId);
    });
  }

  /**
   * Starts the read-only `compositions.expected` dump for the selected
   * environment (#118). It runs the managed `--dump-config` offline; the terminal
   * view is re-validated in `#applyPluginOutput` and is always labelled the
   * desired/expected composition, never the runtime ACTIVE plugin set.
   */
  async loadExpectedComposition(): Promise<void> {
    await this.#runCommand(async () => {
      const environment = selectedEnvironment(this.#state);
      if (environment === null) {
        this.#update({ actionError: contractErrorForCode('NOT_FOUND') });
        return;
      }
      this.#update({ actionError: null, notice: null, expectedComposition: null });
      const result = await this.#call(
        'compositions.expected',
        { requestId: this.#newRequestId(), environmentId: environment.id },
        operationRefSchema,
      );
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      await this.#trackOperation(result.value.operationId);
    });
  }

  setInstallSource(field: 'owner' | 'name' | 'ref', value: string): void {
    this.#update({
      installSource: { ...this.#state.installSource, [field]: value },
      changePlan: null,
      buildAuthorizationConfirmed: false,
      changeApplication: null,
      actionError: null,
    });
  }

  /**
   * Records the explicit acknowledgement of install-time code execution (S4).
   * It never sends anything by itself: `applyPluginChange` still requires a live
   * plan and derives the authorization from that plan's exact commit + script
   * set, so an acknowledgement can never outlive its preview.
   */
  setBuildAuthorizationConfirmed(confirmed: boolean): void {
    this.#update({ buildAuthorizationConfirmed: confirmed });
  }

  /** Starts `changes.preview` for the selected environment and direct source. */
  async previewPluginChange(): Promise<void> {
    await this.#runCommand(async () => {
      const environment = selectedEnvironment(this.#state);
      const source = installSourceSelector(this.#state);
      if (environment === null || source === null) {
        this.#update({ actionError: contractErrorForCode('INVALID_INPUT') });
        return;
      }
      this.#update({ actionError: null, notice: null, changePlan: null, changeApplication: null, buildAuthorizationConfirmed: false });
      const result = await this.#call(
        'changes.preview',
        {
          requestId: this.#newRequestId(),
          environmentId: environment.id,
          expectedRevision: environment.revision,
          action: { kind: 'install', source },
        },
        operationRefSchema,
      );
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      await this.#trackOperation(result.value.operationId);
    });
  }

  /** Starts `changes.apply` for the current plan. Revision/TTL guards are server-side. */
  async applyPluginChange(): Promise<void> {
    await this.#runCommand(async () => {
      const plan = this.#state.changePlan;
      if (plan === null) {
        this.#update({ actionError: contractErrorForCode('INVALID_INPUT') });
        return;
      }
      this.#update({ actionError: null, notice: null, changeApplication: null });
      // S4: the authorization is constructed ONLY from the confirmed plan's own
      // exact commit and enumerated script set. The UI cannot widen it, and a
      // drifted plan is rejected by core/runtime with the frozen error codes.
      const buildAuthorization =
        plan.requiresBuildAuthorization && this.#state.buildAuthorizationConfirmed && plan.sourceLock !== null
          ? { commitSha: plan.sourceLock.commitSha, scripts: [...plan.scripts] }
          : null;
      const result = await this.#call(
        'changes.apply',
        {
          requestId: this.#newRequestId(),
          environmentId: plan.environmentId,
          expectedRevision: plan.baseRevision,
          planId: plan.planId,
          ...(buildAuthorization === null ? {} : { buildAuthorization }),
        },
        operationRefSchema,
      );
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      await this.#trackOperation(result.value.operationId);
    });
  }

  /** Loads the generation list for the selected environment (read-only). */
  async loadGenerations(): Promise<void> {
    await this.#runCommand(async () => {
      const environment = selectedEnvironment(this.#state);
      if (environment === null) {
        this.#update({ actionError: contractErrorForCode('INVALID_INPUT') });
        return;
      }
      const result = await this.#call('generations.list', { environmentId: environment.id }, generationSummaryListSchema);
      if (this.#disposed) return;
      if (!result.ok) { this.#update({ actionError: result.error }); return; }
      this.#update({ actionError: null, generations: result.value });
    });
  }

  /** Restores a previous generation (pointer-only transaction). */
  async restoreGeneration(generationId: string): Promise<void> {
    await this.#runCommand(async () => {
      const environment = selectedEnvironment(this.#state);
      if (environment === null) { this.#update({ actionError: contractErrorForCode('INVALID_INPUT') }); return; }
      this.#update({ actionError: null, notice: null });
      const result = await this.#call('generations.restore', {
        requestId: this.#newRequestId(),
        environmentId: environment.id,
        expectedRevision: environment.revision,
        targetGenerationId: generationId,
      }, operationRefSchema);
      if (this.#disposed) return;
      if (!result.ok) { this.#update({ actionError: result.error }); return; }
      await this.#trackOperation(result.value.operationId);
    });
  }

  selectInstalledPlugin(pluginId: string | null): void {
    this.#update({ selectedInstalledPluginId: pluginId, changePlan: null, actionError: null });
  }

  loadInstalledPlugins(): void {
    void this.#runCommand(async () => {
      await this.#readInstalledPlugins();
    });
  }

  /** Read-only `plugins.installed` read, shared by the button and post-apply refresh. */
  async #readInstalledPlugins(epoch?: number): Promise<void> {
    const environment = selectedEnvironment(this.#state);
    if (environment === null) {
      this.#update({ installedPlugins: null, selectedInstalledPluginId: null });
      return;
    }
    const result = await this.#call(
      'plugins.installed',
      { environmentId: environment.id },
      installedPluginsViewSchema,
    );
    if (this.#disposed) {
      return;
    }
    if (epoch !== undefined && !this.#isCurrent(epoch)) {
      return;
    }
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    const keep = this.#state.selectedInstalledPluginId;
    const stillPresent = keep !== null && result.value.plugins.some((plugin) => plugin.id === keep);
    this.#update({
      installedPlugins: result.value,
      selectedInstalledPluginId: stillPresent ? keep : null,
    });
  }

  /** Starts a remove preview for the SELECTED installed plugin (precise target). */
  async previewPluginRemoval(): Promise<void> {
    await this.#runCommand(async () => {
      const environment = selectedEnvironment(this.#state);
      const plugin = selectedInstalledPlugin(this.#state);
      if (environment === null || plugin === null) {
        this.#update({ actionError: contractErrorForCode('INVALID_INPUT') });
        return;
      }
      this.#update({ actionError: null, notice: null, changePlan: null, changeApplication: null, buildAuthorizationConfirmed: false });
      const result = await this.#call(
        'changes.preview',
        {
          requestId: this.#newRequestId(),
          environmentId: environment.id,
          expectedRevision: environment.revision,
          action: { kind: 'remove', pluginId: plugin.id },
        },
        operationRefSchema,
      );
      if (this.#disposed) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      await this.#trackOperation(result.value.operationId);
    });
  }

  async cancelInstallOperation(): Promise<void> {
    const tracked = this.#state.trackedOperation;
    if (
      tracked === null ||
      (tracked.kind !== 'preview' && tracked.kind !== 'apply') ||
      isOperationTerminal(tracked.status)
    ) {
      return;
    }
    await this.cancelTrackedOperation();
  }

  async cancelTrackedOperation(): Promise<void> {
    await this.#runCommand(async () => {
      const tracked = this.#state.trackedOperation;
      if (tracked === null || isOperationTerminal(tracked.status)) {
        return;
      }
      const epoch = this.#trackingEpoch;
      const result = await this.#call(
        'operations.cancel',
        { requestId: this.#newRequestId(), operationId: tracked.operationId },
        operationSnapshotSchema,
      );
      if (!this.#isCurrent(epoch)) {
        return;
      }
      if (!result.ok) {
        this.#update({ actionError: result.error });
        return;
      }
      this.#applySnapshot(result.value, epoch);
    });
  }

  /**
   * Explicit recovery entry shown after polling exhausted its bounded retries,
   * or after the **first** `operations.get` failed and no snapshot exists yet.
   * It only resumes observing the same operation (read + subscribe); it never
   * re-issues the original create/start command or its side effect.
   */
  retryTracking(): void {
    const tracked = this.#state.trackedOperation;
    if (tracked !== null) {
      if (isOperationTerminal(tracked.status)) {
        return;
      }
      this.#pollFailures = 0;
      this.#update({ trackingError: null, trackingPaused: false });
      this.#schedulePoll(this.#trackingEpoch);
      return;
    }
    const pendingOperationId = this.#state.pendingOperationId;
    if (pendingOperationId === null || this.#state.trackingError === null) {
      return;
    }
    // No snapshot: re-run only the first read/subscribe for the same real
    // operationId. `#trackOperation` bumps the epoch, so a concurrent newer
    // track or a dispose still wins over this late retry.
    void this.#trackOperation(pendingOperationId);
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
    this.#invalidateTracking();
    this.#clearPollTimer();
    this.#detachEvents?.();
    this.#detachEvents = null;
    this.#detachEnvironment?.();
    this.#detachEnvironment = null;
    await this.#releaseAllSubscriptions();
  }

  // --- command serialization ----------------------------------------------

  /**
   * Marks a user command as in flight so the UI can disable its buttons. It is
   * deliberately **not** a hard lock: the accepted behavior is that a repeated
   * click still issues its own call with a fresh `requestId` (QA acceptance
   * "repeated start clicks issue distinct requestIds"), and the tracking epoch
   * keeps the later call authoritative.
   */
  async #runCommand(action: () => Promise<void>): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#pendingCommands += 1;
    this.#update({ commandPending: true });
    try {
      await action();
    } finally {
      this.#pendingCommands = Math.max(0, this.#pendingCommands - 1);
      if (!this.#disposed) {
        this.#update({ commandPending: this.#pendingCommands > 0 });
      }
    }
  }

  // --- operation tracking --------------------------------------------------

  #invalidateTracking(): number {
    this.#trackingEpoch += 1;
    return this.#trackingEpoch;
  }

  #isCurrent(epoch: number): boolean {
    return !this.#disposed && this.#trackingEpoch === epoch;
  }

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
    if (this.#disposed) {
      return;
    }
    if (!result.ok) {
      this.#update({ actionError: result.error });
      return;
    }
    await this.#trackOperation(result.value.operationId);
    await this.#refreshEnvironments();
  }

  async #trackOperation(operationId: string): Promise<void> {
    // A new track supersedes any previous one: bump the epoch, then release the
    // previous timer/subscriptions so a late response cannot resurrect it.
    const epoch = this.#invalidateTracking();
    this.#clearPollTimer();
    this.#pollFailures = 0;
    this.#update({
      trackedOperation: null,
      // The real operationId stays visible even before a snapshot arrives, so a
      // failed first `operations.get` is not silently lost.
      pendingOperationId: operationId,
      trackingError: null,
      trackingPaused: false,
    });
    await this.#releaseAllSubscriptions();
    if (!this.#isCurrent(epoch)) {
      return;
    }
    await this.#fetchInitialSnapshot(operationId, epoch);
  }

  /**
   * First observation of a freshly dispatched operation.
   *
   * On failure it keeps `pendingOperationId` and records `trackingError`
   * instead of fabricating a snapshot; `retryTracking` can then re-observe the
   * same operation. Success clears the pending id and starts normal tracking.
   */
  async #fetchInitialSnapshot(operationId: string, epoch: number): Promise<void> {
    const snapshot = await this.#call('operations.get', { operationId }, operationSnapshotSchema);
    if (!this.#isCurrent(epoch)) {
      return;
    }
    if (!snapshot.ok) {
      this.#update({ trackingError: snapshot.error });
      return;
    }
    this.#update({
      trackedOperation: toTrackedOperation(snapshot.value),
      pendingOperationId: null,
      trackingError: null,
      trackingPaused: false,
    });

    await this.#subscribeTo(operationId, epoch);
    if (!this.#isCurrent(epoch)) {
      return;
    }

    if (isOperationTerminal(snapshot.value.status)) {
      await this.#completeTracking(epoch);
    } else {
      this.#schedulePoll(epoch);
    }
  }

  async #subscribeTo(operationId: string, epoch: number): Promise<void> {
    const result = await this.#call(
      'operations.subscribe',
      { requestId: this.#newRequestId(), operationId },
      subscriptionRefSchema,
    );
    if (!this.#isCurrent(epoch)) {
      // The subscription was created after the track was superseded or after
      // dispose. Release it immediately so it cannot leak in the main session.
      if (result.ok) {
        await this.#unsubscribe(result.value.subscriptionId);
      }
      return;
    }
    if (!result.ok) {
      this.#update({ trackingError: result.error });
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

  async #releaseAllSubscriptions(): Promise<void> {
    const subscriptionIds = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    for (const subscriptionId of subscriptionIds) {
      await this.#unsubscribe(subscriptionId);
    }
  }

  #schedulePoll(epoch: number, delayMs: number = this.#pollIntervalMs): void {
    if (!this.#isCurrent(epoch) || this.#pollTimer !== null) {
      return;
    }
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.#poll(epoch);
    }, delayMs);
  }

  async #poll(epoch: number): Promise<void> {
    if (!this.#isCurrent(epoch)) {
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
    if (!this.#isCurrent(epoch)) {
      return;
    }
    if (!result.ok) {
      this.#pollFailures += 1;
      const exhausted = this.#pollFailures >= this.#maxPollRetries;
      this.#update({ trackingError: result.error, trackingPaused: exhausted });
      if (!exhausted) {
        this.#schedulePoll(epoch, this.#pollIntervalMs * this.#pollFailures);
      }
      return;
    }
    this.#pollFailures = 0;
    this.#update({ trackingError: null, trackingPaused: false });
    this.#applySnapshot(result.value, epoch);
    const current = this.#state.trackedOperation;
    if (this.#isCurrent(epoch) && current !== null && !isOperationTerminal(current.status)) {
      this.#schedulePoll(epoch);
    }
  }

  #applySnapshot(snapshot: OperationSnapshot, epoch: number): void {
    if (!this.#isCurrent(epoch)) {
      return;
    }
    const current = this.#state.trackedOperation;
    // Ignore results for any other operation (cross-operation stale response)
    // and any regressing sequence for the tracked operation.
    if (current === null || snapshot.id !== current.operationId) {
      return;
    }
    if (snapshot.sequence < current.sequence) {
      return;
    }
    this.#update({ trackedOperation: toTrackedOperation(snapshot) });
    if (isOperationTerminal(snapshot.status)) {
      void this.#completeTracking(epoch);
    }
  }

  async #completeTracking(epoch: number): Promise<void> {
    if (!this.#isCurrent(epoch)) {
      return;
    }
    this.#clearPollTimer();
    const tracked = this.#state.trackedOperation;
    if (tracked === null || !isOperationTerminal(tracked.status)) {
      return;
    }
    const subscriptionId = this.#subscriptions.get(tracked.operationId);
    if (subscriptionId !== undefined) {
      this.#subscriptions.delete(tracked.operationId);
      await this.#unsubscribe(subscriptionId);
      if (!this.#isCurrent(epoch)) {
        return;
      }
    }
    if (tracked.status === 'succeeded') {
      this.#applyPluginOutput(tracked);
      await this.#refreshEnvironments(epoch);
      if (!this.#isCurrent(epoch)) {
        return;
      }
      // A committed apply changed the active generation: the installed list must
      // be re-read from the NEW composition, never left stale in the UI.
      if (tracked.kind === 'apply') {
        await this.#readInstalledPlugins(epoch);
      }
      return;
    }
    // A terminal non-success MUST surface here. Previously only `succeeded` was
    // handled, so a failed (or cancelled) preview/apply left the S2 panel showing
    // "解析来源并生成计划…" with no error (QA33 real desktop chain).
    if (tracked.status === 'cancelled') {
      this.#update({ notice: '操作已取消，环境组成未改变。', actionError: null });
      return;
    }
    this.#update({
      actionError: tracked.error ?? contractErrorForCode('INTERNAL_ERROR'),
      notice: null,
    });
  }

  /**
   * Re-validates a terminal plugin payload before it can reach the UI. The
   * dispatcher already enforces the per-kind schema; this is defence in depth
   * so a malformed value is an explicit `INTERNAL_ERROR`, never a partial list.
   */
  #applyPluginOutput(tracked: TrackedOperation): void {
    if (tracked.kind === 'search') {
      const issues: ValidationIssue[] = [];
      const parsed = pluginSearchResultSchema(tracked.output, 'output', issues);
      if (parsed === undefined) {
        this.#update({ pluginSearch: null, actionError: contractErrorForCode('INTERNAL_ERROR') });
        return;
      }
      this.#update({
        pluginSearch: parsed,
        selectedPluginFullName: parsed.hits[0]?.fullName ?? null,
      });
      return;
    }
    if (tracked.kind === 'preview') {
      const issues: ValidationIssue[] = [];
      const parsed = changePlanSchema(tracked.output, 'output', issues);
      if (parsed === undefined) {
        this.#update({ changePlan: null, actionError: contractErrorForCode('INTERNAL_ERROR') });
        return;
      }
      this.#update({ changePlan: parsed });
      return;
    }
    if (tracked.kind === 'restore') {
      const issues: ValidationIssue[] = [];
      const parsed = generationSummarySchema(tracked.output, 'output', issues);
      if (parsed === undefined) {
        this.#update({ actionError: contractErrorForCode('INTERNAL_ERROR') });
        return;
      }
      this.#update({ notice: `已恢复到代际 ${parsed.generationId}；重启环境后生效。` });
      return;
    }
    if (tracked.kind === 'apply') {
      const issues: ValidationIssue[] = [];
      const parsed = changeApplicationSchema(tracked.output, 'output', issues);
      if (parsed === undefined) {
        this.#update({ actionError: contractErrorForCode('INTERNAL_ERROR') });
        return;
      }
      const actionKind = this.#state.changePlan?.action.kind ?? null;
      this.#update({ changeApplication: parsed, changePlan: null, buildAuthorizationConfirmed: false, lastChangeAction: actionKind });
      return;
    }
    if (tracked.kind === 'inspect') {
      const issues: ValidationIssue[] = [];
      const parsed = pluginInspectionSchema(tracked.output, 'output', issues);
      if (parsed === undefined) {
        this.#update({ pluginInspection: null, actionError: contractErrorForCode('INTERNAL_ERROR') });
        return;
      }
      this.#update({ pluginInspection: parsed });
      return;
    }
    if (tracked.kind === 'versions') {
      const issues: ValidationIssue[] = [];
      const parsed = dshVersionListingSchema(tracked.output, 'output', issues);
      if (parsed === undefined) {
        this.#update({ dshVersions: null, actionError: contractErrorForCode('INTERNAL_ERROR') });
        return;
      }
      this.#update({ dshVersions: parsed });
      return;
    }
    if (tracked.kind === 'composition') {
      const issues: ValidationIssue[] = [];
      const parsed = expectedCompositionViewSchema(tracked.output, 'output', issues);
      if (parsed === undefined) {
        this.#update({ expectedComposition: null, actionError: contractErrorForCode('INTERNAL_ERROR') });
        return;
      }
      // A dump loaded for environment A must not land while the user has since
      // selected environment B (the tracking epoch is not bumped by a plain
      // selection change).
      if (parsed.environmentId !== this.#state.selectedEnvironmentId) {
        return;
      }
      this.#update({ expectedComposition: parsed });
    }
  }

  async #refreshEnvironments(epoch?: number): Promise<void> {
    const result = await this.#call('environments.list', {}, environmentSummaryListSchema);
    if (this.#disposed) {
      return;
    }
    if (epoch !== undefined && !this.#isCurrent(epoch)) {
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

  /**
   * Merges a main-pushed environment projection (a managed process exiting on
   * its own) into the environment list. `environments.list` stays the authority;
   * this channel only closes the push gap, and the monotonic `stateVersion`
   * means a late event can never regress a newer list read.
   *
   * An unknown environment is ignored rather than appended: the projection can
   * only describe an environment this window already loaded.
   */
  #handleEnvironmentProjection(environment: EnvironmentSummary): void {
    if (this.#disposed) {
      return;
    }
    const current = this.#state.environments;
    const index = current.findIndex((entry) => entry.id === environment.id);
    if (index === -1) {
      return;
    }
    const existing = current[index];
    if (existing !== undefined && environment.stateVersion < existing.stateVersion) {
      return;
    }
    const next = [...current];
    next[index] = environment;
    this.#update({ environments: next });
  }

  #handleEvent(event: OperationUpdatedEvent): void {
    if (this.#disposed) {
      return;
    }
    const current = this.#state.trackedOperation;
    if (current === null || current.operationId !== event.operationId) {
      return;
    }
    // Only the subscription currently owning this operation may drive it, so a
    // late event from a released subscription cannot affect a newer track.
    const subscriptionId = this.#subscriptions.get(event.operationId);
    if (subscriptionId === undefined || subscriptionId !== event.subscriptionId) {
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
      void this.#completeTracking(this.#trackingEpoch);
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
    if (this.#disposed) {
      return;
    }
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
  ): Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: ContractError }
  > {
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
