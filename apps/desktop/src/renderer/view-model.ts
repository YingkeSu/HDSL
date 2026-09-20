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
import type {
  ContractError,
  EnvironmentSummary,
  ExportResult,
  OperationKind,
  OperationStatus,
  RuntimeCombination,
} from '@hdsl/contracts';

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
  /** Error from polling `operations.get`, kept separate from command errors. */
  readonly trackingError: ContractError | null;
  /** True after polling exhausted its bounded retries and stopped. */
  readonly trackingPaused: boolean;
  /** True while a user command is in flight (serializes mutations). */
  readonly commandPending: boolean;
  readonly exportResult: ExportResult | null;
  /** Set only after `openWebUI` returns a verified loopback origin. */
  readonly webUIOrigin: string | null;
  readonly notice: string | null;
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
  trackingError: null,
  trackingPaused: false,
  commandPending: false,
  exportResult: null,
  webUIOrigin: null,
  notice: null,
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
