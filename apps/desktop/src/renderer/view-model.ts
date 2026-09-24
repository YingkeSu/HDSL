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
  type DshVersionListing,
  type EntryPatchOperationKind,
  type EntryPatchResult,
  type ExpectedCompositionView,
  type GenerationSummary,
  type ContractError,
  type EnvironmentSummary,
  type ExportResult,
  type InstalledPluginsView,
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
  /**
   * Dialog-scoped create error. It is deliberately separate from
   * {@link RendererState.actionError} so closing the create dialog can clear
   * this failure without wiping an unrelated operation error (#146).
   */
  readonly createError: ContractError | null;
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
  /**
   * True only after the user explicitly acknowledged that the install will run
   * package code on this machine outside any HDSL/DSH sandbox. Reset on every
   * new preview; it is the ONLY source of the `buildAuthorization` sent with
   * `changes.apply` (S4, issue #78).
   */
  readonly buildAuthorizationConfirmed: boolean;
  /** Terminal `changes.apply` result, or null. */
  readonly changeApplication: ChangeApplication | null;
  /** Action kind of the last committed apply, so each panel reports only its own flow. */
  readonly lastChangeAction: 'install' | 'remove' | null;
  /** Read-only `generations.list` result for the selected environment. */
  readonly generations: readonly GenerationSummary[];
  /** Read-only `plugins.installed` view of the selected environment's active generation. */
  readonly installedPlugins: InstalledPluginsView | null;
  /** Selected plugin id in the removal panel. */
  readonly selectedInstalledPluginId: string | null;
  /** Last succeeded `versions.dsh` upstream DSH version listing, or null. */
  readonly dshVersions: DshVersionListing | null;
  /** Last succeeded `compositions.expected` desired-composition view, or null. */
  readonly expectedComposition: ExpectedCompositionView | null;
  /** Row id input for the desired-config home patch edit (`entries.patch`, #135). */
  readonly entryPatchRowId: string;
  /** Config JSON text used only by the `config` operation; the whole row config is replaced. */
  readonly entryPatchConfigText: string;
  /**
   * Last succeeded `entries.patch` result, or null. It is always the DESIRED
   * config save (`saved: true`, `runtime: 'pending'`) and never the runtime
   * ACTIVE set.
   */
  readonly entryPatchResult: EntryPatchResult | null;
  /**
   * The exact `environments.stop` operation the user asked to be followed by a
   * restart, or null. Binding to the operation id (instead of a boolean) means a
   * failed, cancelled, unrelated or superseded stop can never trigger an
   * unintended start.
   */
  readonly restartAfterStopOperationId: string | null;
  /**
   * Non-blocking DSH data-compatibility warning returned by the last succeeded
   * `generations.restore` (A2/#114), or null. Null covers "no restore yet" and
   * the same-version/unknown-version cases, which never warn.
   */
  readonly restoreWarning: string | null;
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
  /**
   * Clears ONLY the dialog-scoped create error when the create dialog is closed
   * or reopened. It never touches `actionError` or any other flow's error.
   */
  clearCreateError(): void;
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
  /** Records the explicit install-time code-execution acknowledgement (S4). */
  setBuildAuthorizationConfirmed(confirmed: boolean): void;
  /** Starts `changes.apply` for the current plan. */
  applyPluginChange(): void;
  /** Cancels an in-flight preview/apply/restore; terminal operations are untouched. */
  cancelInstallOperation(): void;
  /** Loads `generations.list` for the selected environment. */
  loadGenerations(): void;
  /** Restores a previous generation as active (`generations.restore`). */
  restoreGeneration(generationId: string): void;
  /** Loads the installed-plugin list of the selected environment (`plugins.installed`). */
  loadInstalledPlugins(): void;
  /** Selects one installed plugin for the remove flow. */
  selectInstalledPlugin(pluginId: string | null): void;
  /** Starts `changes.preview` for the selected installed plugin (remove). */
  previewPluginRemoval(): void;
  /** Starts a read-only upstream DSH version listing (`versions.dsh`, A1/#113). */
  loadDshVersions(): void;
  /**
   * Switches a STOPPED environment's active composition to another supported
   * combination (`environments.switchCombination`, A2/#114). The supported set
   * is the audited `versions.dsh` listing; an unsupported/unknown combination is
   * refused, and a running/starting/stopping environment is never auto-stopped.
   */
  switchVersion(catalogCombinationId: string): void;
  /**
   * Starts a read-only EXPECTED composition read for the selected environment
   * (`compositions.expected`, #118). The result is never the runtime ACTIVE set.
   */
  loadExpectedComposition(): void;
  /** Row id input for the desired-config home patch edit (`entries.patch`, #135). */
  setEntryPatchRowId(rowId: string): void;
  /** Config JSON text for the `config` operation (`entries.patch`, #135). */
  setEntryPatchConfigText(config: string): void;
  /**
   * Persists one desired-config edit of the environment home user patch
   * (`entries.patch`, #135). A saved result is NEVER the runtime ACTIVE set.
   */
  patchEntry(kind: EntryPatchOperationKind): void;
  /**
   * Explicit restart fallback: stops and restarts the selected environment so a
   * saved desired config is deterministically applied. It never claims a live
   * reload succeeded.
   */
  restartSelected(): void;
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
  buildAuthorizationConfirmed: false,
  changeApplication: null,
  lastChangeAction: null,
  generations: [],
  installedPlugins: null,
  selectedInstalledPluginId: null,
  dshVersions: null,
  expectedComposition: null,
  entryPatchRowId: '',
  entryPatchConfigText: '',
  entryPatchResult: null,
  restartAfterStopOperationId: null,
  restoreWarning: null,
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

/** The installed plugin currently selected for removal, or null. */
export const selectedInstalledPlugin = (state: RendererState) =>
  state.installedPlugins?.plugins.find((plugin) => plugin.id === state.selectedInstalledPluginId) ?? null;

export const isOperationTerminal = (status: OperationStatus): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';

/** A stopped or failed environment may be started; a running one may not. */
export const canStart = (environment: EnvironmentSummary): boolean =>
  environment.state === 'stopped' || environment.state === 'error';

export const canStop = (environment: EnvironmentSummary): boolean =>
  environment.state === 'running' || environment.state === 'starting';

/** Only a stopped environment may switch composition; switching never auto-stops. */
export const canSwitchVersion = (environment: EnvironmentSummary): boolean =>
  environment.state === 'stopped';

/**
 * A desired-config home patch edit is allowed while running (hot path) or
 * stopped; `starting`/`stopping`/`creating` are refused with `ENVIRONMENT_BUSY`
 * by core. The renderer mirrors that so the buttons can be disabled.
 */
export const canEditRuntimeEntry = (environment: EnvironmentSummary): boolean =>
  environment.state !== 'starting' &&
  environment.state !== 'stopping' &&
  environment.state !== 'creating';

/**
 * Combination ids the audited upstream `versions.dsh` listing marks as
 * supported (A1/#113). An empty set means "not yet known", never "unsafe".
 */
export const supportedCombinationIds = (state: RendererState): ReadonlySet<string> => {
  const ids = new Set<string>();
  const listing = state.dshVersions;
  if (listing === null) {
    return ids;
  }
  for (const entry of listing.versions) {
    if (!entry.supported) continue;
    for (const combinationId of entry.catalogCombinationIds) {
      ids.add(combinationId);
    }
  }
  return ids;
};

/** Catalog combination ids installable on this host (already host-scoped by main). */
export const installableCombinationIds = (state: RendererState): ReadonlySet<string> =>
  new Set(state.catalog.map((entry) => entry.id));

/**
 * True when an upstream `versions.dsh` entry has at least one audited
 * combination that is actually installable on this host. The registry listing
 * reports audited coverage independently of the host, so the renderer
 * intersects it with the host-scoped catalog before claiming that a version can
 * be installed here.
 */
export const isVersionInstallableOnHost = (
  state: RendererState,
  combinationIds: readonly string[],
): boolean => {
  const installable = installableCombinationIds(state);
  return combinationIds.some((id) => installable.has(id));
};

/**
 * Catalog combinations that are verifiably switchable: verified on this host
 * AND referenced by a supported upstream DSH version. Unknown or unverified
 * combinations are never offered as switchable (unknown != unsafe).
 */
export const switchableCombinations = (
  state: RendererState,
): readonly RuntimeCombination[] => {
  const supported = supportedCombinationIds(state);
  return state.catalog.filter(
    (entry) => entry.compatibility.status === 'verified' && supported.has(entry.id),
  );
};

/** Keep mutations from replacing an operation whose initial snapshot is missing. */
export const isBusy = (state: RendererState): boolean =>
  state.commandPending || state.pendingOperationId !== null ||
  (state.trackedOperation !== null && !isOperationTerminal(state.trackedOperation.status));
