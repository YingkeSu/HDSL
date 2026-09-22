/**
 * Renderer-only view model (T006a).
 *
 * These types are the UI projection of the frozen contract DTOs. They are
 * deliberately framework-free so the state machine can be unit-tested without a
 * DOM, and the React components in this directory stay thin renderers.
 *
 * Nothing here redefines a contract DTO: environments, operations, catalog
 * entries, errors and export summaries are always the shared `@hdsl/contracts`
 * types. The renderer never uses Node, the filesystem or an arbitrary IPC
 * channel; every effect goes through {@link RendererActions} and the injected
 * restricted client.
 */
import {
  DEFAULT_PLUGIN_QUERY,
  type ChangeApplication,
  type ChangePlan,
  type GenerationSummary,
  type ContractError,
  type EnvironmentSummary,
  type ExportResult,
  type OperationKind,
  type OperationStatus,
  type PluginInspection,
  type PluginSearchResult,
  type PluginSourceSelector,
  type RuntimeCombination,
} from '@hdsl/contracts';

/** Direct repository input for the S2 install flow. */
export interface InstallSourceInput {
  readonly owner: string;
  readonly name: string;
  readonly ref: string;
}

/** Where the initial catalog/environment load is. */
export type LoadPhase = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Renderer-side view of one tracked operation.
 *
 * `progress: null` means "unknown"; the UI must not invent a percentage
 * (contracts/local-api.md: 百分比未知时不给假进度).
 */
export interface TrackedOperation {
  readonly operationId: string;
  readonly kind: OperationKind | null;
  readonly phase: string;
  readonly status: OperationStatus;
  readonly sequence: number;
  readonly progress: number | null;
  readonly environmentId: string | null;
  readonly error: ContractError | null;
  /** Terminal payload for `search`/`inspect`; `null` while absent. */
  readonly output: unknown;
}

/** Immutable renderer state; the controller replaces it wholesale on change. */
export interface RendererState {
  readonly phase: LoadPhase;
  /** True only for the explicitly injected demo/test client. */
  readonly demo: boolean;
  readonly catalog: readonly RuntimeCombination[];
  readonly environments: readonly EnvironmentSummary[];
  readonly selectedEnvironmentId: string | null;
  readonly createName: string;
  readonly createCombinationId: string | null;
  readonly createError: string | null;
  readonly loadError: ContractError | null;
  readonly actionError: ContractError | null;
  readonly trackedOperation: TrackedOperation | null;
  /**
   * The operation id the controller is observing but has no snapshot for yet.
   *
   * It is set as soon as a `create`/`start` returns an `operationId` and is
   * cleared on the first successful `operations.get` snapshot. Keeping it while
   * `trackedOperation === null` lets the UI show a failed first fetch and offer
   * an explicit retry without inventing a phase/status/progress.
   */
  readonly pendingOperationId: string | null;
  /** Error from observing `operations.get`, kept separate from command errors. */
  readonly trackingError: ContractError | null;
  /** True after polling exhausted its bounded retries and stopped. */
  readonly trackingPaused: boolean;
  /** True while a user command is in flight (serializes mutations). */
  readonly commandPending: boolean;
  readonly exportResult: ExportResult | null;
  /** Set only after `openWebUI` returns a verified loopback origin. */
  readonly webUIOrigin: string | null;
  readonly notice: string | null;
  /** Current plugin discovery input; defaults to the fixed `#75` query. */
  readonly pluginQuery: string;
  /** Last succeeded `plugins.search` payload, or null. */
  readonly pluginSearch: PluginSearchResult | null;
  /** Last succeeded `plugins.inspect` payload for the selected hit, or null. */
  readonly pluginInspection: PluginInspection | null;
  /** Selected repository in the discovery detail panel, by `fullName`. */
  readonly selectedPluginFullName: string | null;
  /** Direct repository input for preview/apply. */
  readonly installSource: InstallSourceInput;
  /** Terminal `changes.preview` plan, or null. */
  readonly changePlan: ChangePlan | null;
  /** Terminal `changes.apply` result, or null. */
  readonly changeApplication: ChangeApplication | null;
  /** Read-only `generations.list` result for the selected environment. */
  readonly generations: readonly GenerationSummary[];
}

/**
 * The complete set of user intents the UI may raise. The production entry
 * supplies a controller implementing this interface; no component talks to a
 * client directly.
 */
export interface RendererActions {
  load(): void;
  refresh(): void;
  setCreateName(name: string): void;
  setCreateCombinationId(combinationId: string): void;
  createEnvironment(): void;
  selectEnvironment(environmentId: string): void;
  startSelected(): void;
  stopSelected(): void;
  openWebUI(): void;
  exportDiagnostics(): void;
  cancelTrackedOperation(): void;
  /** Explicit recovery after polling paused on repeated transient failures. */
  retryTracking?(): void;
  setPluginQuery(query: string): void;
  resetPluginQuery(): void;
  runPluginSearch(): void;
  /** Fetches authoritative repository detail via `plugins.inspect`. */
  inspectSelectedPlugin(): void;
  selectPlugin(fullName: string | null): void;
  cancelPluginSearch(): void;
  setInstallSource(field: keyof InstallSourceInput, value: string): void;
  /** Starts `changes.preview` for the selected environment. */
  previewPluginChange(): void;
  /** Starts `changes.apply` for the current plan. */
  applyPluginChange(): void;
  /** Cancels an in-flight preview/apply/restore; terminal operations are untouched. */
  cancelInstallOperation(): void;
  /** Loads `generations.list` for the selected environment. */
  loadGenerations(): void;
  /** Restores a previous generation as active (`generations.restore`). */
  restoreGeneration(generationId: string): void;
}

export const INITIAL_STATE: RendererState = {
  phase: 'idle',
  demo: false,
  catalog: [],
  environments: [],
  selectedEnvironmentId: null,
  createName: '',
  createCombinationId: null,
  createError: null,
  loadError: null,
  actionError: null,
  trackedOperation: null,
  pendingOperationId: null,
  trackingError: null,
  trackingPaused: false,
  commandPending: false,
  exportResult: null,
  webUIOrigin: null,
  notice: null,
  pluginQuery: DEFAULT_PLUGIN_QUERY,
  pluginSearch: null,
  pluginInspection: null,
  selectedPluginFullName: null,
  installSource: { owner: '', name: '', ref: '' },
  changePlan: null,
  changeApplication: null,
  generations: [],
};

/** The repository currently shown in the discovery detail panel, or null. */
export const selectedPluginHit = (state: RendererState) =>
  state.pluginSearch?.hits.find((hit) => hit.fullName === state.selectedPluginFullName) ?? null;

/**
 * The install source selector, or null when the owner/name input is incomplete.
 * A `ref` is optional; the server resolves it to an exact commit.
 */
export const installSourceSelector = (state: RendererState): PluginSourceSelector | null => {
  const owner = state.installSource.owner.trim();
  const name = state.installSource.name.trim();
  if (owner === '' || name === '') {
    return null;
  }
  const ref = state.installSource.ref.trim();
  return { owner, name, ...(ref === '' ? {} : { ref }) };
};

export const selectedEnvironment = (state: RendererState): EnvironmentSummary | null =>
  state.environments.find((environment) => environment.id === state.selectedEnvironmentId) ?? null;

export const isOperationTerminal = (status: OperationStatus): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';

/** A stopped or failed environment may be started; a running one may not. */
export const canStart = (environment: EnvironmentSummary): boolean =>
  environment.state === 'stopped' || environment.state === 'error';

export const canStop = (environment: EnvironmentSummary): boolean =>
  environment.state === 'running' || environment.state === 'starting';

/** Keep mutations from replacing an operation whose initial snapshot is missing. */
export const isBusy = (state: RendererState): boolean =>
  state.commandPending || state.pendingOperationId !== null ||
  (state.trackedOperation !== null && !isOperationTerminal(state.trackedOperation.status));
