/**
 * Minimal context port between contract semantics and the rest of the app.
 *
 * T003 owns the stateless validation, the envelope/version rules, idempotency
 * bookkeeping, resource-existence and revision guards, the loopback check for
 * `openWebUI` and the subscription/event sequence. Everything that needs real
 * storage, install, process or credential work is delegated through
 * {@link ContractPort}; T004–T006 provide the persistent implementation.
 *
 * The reference/in-memory port in `testing/reference-port.ts` exists only to
 * exercise the contract with fixtures. It is not real storage and must not be
 * shipped as launcher behavior.
 */
import type { ContractError, ErrorCode } from './errors.js';
import type { ContractMethod } from './methods.js';
import type { HostPlatform } from './platform.js';
import type {
  InstalledPluginsView,
  BuildAuthorization,
  ChangePlanAction,
  EntryPatchOperation,
  EntryPatchResult,
  EnvironmentSummary,
  ExportResult,
  GenerationSummary,
  OpenWebUIResult,
  OperationRef,
  OperationSnapshot,
  PluginSearchResult,
  PluginSourceSelector,
  RuntimeCombination,
} from './dto.js';

/**
 * Downstream result: either a value or a contract error code plus a message.
 *
 * The `message` is for downstream logging/diagnostics only. The dispatcher
 * does **not** forward it to the wire: it maps `code` to a controlled message
 * (`contractErrorForCode`) so a compromised or buggy port cannot leak
 * credentials or local paths (security review P2-3).
 */
export type PortOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly message: string;
      /** Machine-readable retry delay for `RATE_LIMITED` (ADR 0005 D11). */
      readonly retryAfterSeconds?: number;
    };

export const portOk = <T>(value: T): PortOutcome<T> => ({ ok: true, value });

export const portFail = (
  code: ErrorCode,
  message: string,
  options: { readonly retryAfterSeconds?: number } = {},
): PortOutcome<never> => ({
  ok: false,
  code,
  message,
  ...(options.retryAfterSeconds === undefined
    ? {}
    : { retryAfterSeconds: options.retryAfterSeconds }),
});

export interface CreateEnvironmentCommand {
  readonly requestId: string;
  readonly name: string;
  readonly combination: RuntimeCombination;
}

export interface RevisionCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly expectedRevision: number;
}

/**
 * `environments.switchCombination`: switches an environment's active
 * composition to another supported, evidence-backed catalog combination. The port receives the
 * already-resolved `RuntimeCombination` (the dispatcher resolves the
 * `catalogCombinationId` and rejects unsupported/mismatched ones first).
 */
export interface SwitchCombinationCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly combination: RuntimeCombination;
}

export interface EnvironmentCommand {
  readonly requestId: string;
  readonly environmentId: string;
}

export interface OperationCommand {
  readonly requestId: string;
  readonly operationId: string;
}

export interface PluginSearchCommand {
  readonly requestId: string;
  /** The exact discovery query; the port must send it character for character. */
  readonly query: string;
}

export interface PluginInspectCommand {
  readonly requestId: string;
  readonly source: PluginSourceSelector;
}

/** `versions.dsh`: a global, registry-only read that starts a discovery operation. */
export interface DshVersionCommand {
  readonly requestId: string;
}

/** `compositions.expected`: a read-only expected-composition read for one environment. */
export interface ExpectedCompositionCommand {
  readonly requestId: string;
  readonly environmentId: string;
}

/** `entries.patch`: one desired-config edit of the environment home user patch. */
export interface EntryPatchCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly operation: EntryPatchOperation;
}

/**
 * Terminal payload a plugin-source adapter returns for `plugins.search`.
 * `PluginSearchResult` is the wire DTO; re-exported name keeps the port seam
 * explicit without a second type.
 */
export type PluginSearchPayload = PluginSearchResult;

/** Stored outcome of an executed idempotent call, replayed verbatim. */
export type StoredOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ContractError };

/**
 * Durable idempotency record. There are exactly two states:
 *
 * - `in-progress`: written immediately **after** all guards pass and **before**
 *   the effect starts. A replay of an `in-progress` request returns
 *   `ENVIRONMENT_BUSY` and never re-executes the effect, so a crash between the
 *   effect and the outcome write (or a reentrant call) cannot double-apply it.
 *   T004 reconciles such records from the operation journal.
 * - `completed`: the effect ran (success or a port-declared terminal failure);
 *   a replay returns the original outcome.
 *
 * Pure guard rejections (version, input, unknown id, revision, platform) never
 * write a record, so a corrected retry with the same `requestId` is allowed.
 */
export type IdempotencyRecord =
  | {
      readonly state: 'in-progress';
      readonly method: ContractMethod;
      readonly fingerprint: string;
    }
  | {
      readonly state: 'completed';
      readonly method: ContractMethod;
      readonly fingerprint: string;
      readonly outcome: StoredOutcome;
    };

export interface PreviewChangeCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly action: ChangePlanAction;
}

export interface ApplyChangeCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly planId: string;
  readonly buildAuthorization: BuildAuthorization | null;
}

export interface RestoreGenerationCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly targetGenerationId: string;
}

export interface ContractPort {
  /**
   * The real host the contract gate must evaluate. `undefined` means the
   * caller did not supply a resolvable host; the platform guard then refuses
   * create/switch instead of assuming a verified host (never a silent
   * darwin/arm64 fallback).
   */
  readonly host: HostPlatform | undefined;

  listCatalog(): PortOutcome<readonly RuntimeCombination[]>;
  listEnvironments(): PortOutcome<readonly EnvironmentSummary[]>;
  findEnvironment(environmentId: string): PortOutcome<EnvironmentSummary>;
  findOperation(operationId: string): PortOutcome<OperationSnapshot>;
  findCombination(combinationId: string): PortOutcome<RuntimeCombination>;

  createEnvironment(command: CreateEnvironmentCommand): PortOutcome<OperationRef>;
  startEnvironment(command: RevisionCommand): PortOutcome<OperationRef>;
  stopEnvironment(command: RevisionCommand): PortOutcome<OperationRef>;
  /**
   * Switches an existing, STOPPED environment to another supported catalog
   * combination: install + verify the new generation, then atomically switch
   * the active-generation pointer. A pre-commit failure keeps the old
   * generation; it never auto-stops or auto-restarts a process.
   */
  switchCombination(command: SwitchCombinationCommand): PortOutcome<OperationRef>;
  /** May only resolve the current managed process' verified loopback origin. */
  openWebUI(command: EnvironmentCommand): PortOutcome<OpenWebUIResult>;
  cancelOperation(command: OperationCommand): PortOutcome<OperationSnapshot>;
  exportDiagnostics(command: EnvironmentCommand): PortOutcome<ExportResult>;

  /**
   * Starts a cancellable, global (`environmentId = null`) GitHub read-only
   * search. It is never blocked by an environment `ENVIRONMENT_BUSY`, needs no
   * GitHub credential and must not change any environment composition
   * (ADR 0005 D5/D16).
   */
  searchPlugins(command: PluginSearchCommand): PortOutcome<OperationRef>;
  /** Starts a cancellable, global GitHub read-only repository inspection. */
  inspectPluginSource(command: PluginInspectCommand): PortOutcome<OperationRef>;

  /**
   * Starts a cancellable, global (`environmentId = null`) read-only listing of
   * upstream DSH versions from the public npm registry. It uses no credential,
   * never touches an environment composition and never runs plugin code.
   */
  listDshVersions(command: DshVersionCommand): PortOutcome<OperationRef>;

  /**
   * Starts a cancellable, read-only expected-composition read for one
   * environment (`compositions.expected`). The terminal `ExpectedCompositionView`
   * is read only from `OperationSnapshot.output`. It runs the managed
   * `--dump-config` offline (no plugin execution, no credential) and never
   * claims the runtime ACTIVE plugin set.
   */
  describeExpectedComposition(command: ExpectedCompositionCommand): PortOutcome<OperationRef>;

  /**
   * Persists ONE desired-config edit on the environment-shared home user patch
   * (`$DSH_HOME/cordis.patch.yml`). It never writes a generation's immutable
   * profile declaration source and never reports the running process as ACTIVE:
   * the terminal `EntryPatchResult` carries `saved: true` with
   * `runtime: 'pending'` / `runtimeVerification: 'unavailable'` and an
   * `activation` that is never an ACTIVE claim. The read-modify-write is
   * serialized per environment; a `starting`/`stopping` environment is refused
   * with `ENVIRONMENT_BUSY`.
   */
  patchEntry(command: EntryPatchCommand): PortOutcome<EntryPatchResult>;

  /**
   * Starts a cancellable `changes.preview` for one environment. The terminal
   * `ChangePlan` is read only from `OperationSnapshot.output` (ADR 0005 D5).
   */
  previewChange(command: PreviewChangeCommand): PortOutcome<OperationRef>;

  /**
   * Starts a cancellable `changes.apply` transaction. The terminal
   * `ChangeApplication` is read only from `OperationSnapshot.output` (D5).
   */
  applyChange(command: ApplyChangeCommand): PortOutcome<OperationRef>;

  /**
   * Read-only generation summaries for an environment (ADR 0005 D4). Returns
   * immediately; it carries no `requestId` and is never deduplicated. It reads
   * only the durable generation records; it never rebuilds identity from the
   * live profile (ADR 0006).
   */
  listGenerations(environmentId: string): PortOutcome<readonly GenerationSummary[]>;
  /** Read-only installed-plugin list of the active generation (`plugins.installed`). */
  listInstalledPlugins(environmentId: string): PortOutcome<InstalledPluginsView>;

  /**
   * Restores a previous generation as the active one (ADR 0005 D4/D10). This
   * switches the pointer only: the generation's composition identity and the
   * shared environment home/data are preserved and no retained generation is
   * deleted.
   */
  restoreGeneration(command: RestoreGenerationCommand): PortOutcome<OperationRef>;

  /** Subscription bookkeeping the contract delegates to the session registry. */
  readIdempotency(requestId: string): IdempotencyRecord | undefined;
  writeIdempotency(requestId: string, record: IdempotencyRecord): void;
}
