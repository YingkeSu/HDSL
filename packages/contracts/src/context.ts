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
  EnvironmentSummary,
  ExportResult,
  OpenWebUIResult,
  OperationRef,
  OperationSnapshot,
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
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

export const portOk = <T>(value: T): PortOutcome<T> => ({ ok: true, value });

export const portFail = (code: ErrorCode, message: string): PortOutcome<never> => ({
  ok: false,
  code,
  message,
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

export interface EnvironmentCommand {
  readonly requestId: string;
  readonly environmentId: string;
}

export interface OperationCommand {
  readonly requestId: string;
  readonly operationId: string;
}

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

export interface ContractPort {
  readonly host: HostPlatform;

  listCatalog(): PortOutcome<readonly RuntimeCombination[]>;
  listEnvironments(): PortOutcome<readonly EnvironmentSummary[]>;
  findEnvironment(environmentId: string): PortOutcome<EnvironmentSummary>;
  findOperation(operationId: string): PortOutcome<OperationSnapshot>;
  findCombination(combinationId: string): PortOutcome<RuntimeCombination>;

  createEnvironment(command: CreateEnvironmentCommand): PortOutcome<OperationRef>;
  startEnvironment(command: RevisionCommand): PortOutcome<OperationRef>;
  stopEnvironment(command: RevisionCommand): PortOutcome<OperationRef>;
  /** May only resolve the current managed process' verified loopback origin. */
  openWebUI(command: EnvironmentCommand): PortOutcome<OpenWebUIResult>;
  cancelOperation(command: OperationCommand): PortOutcome<OperationSnapshot>;
  exportDiagnostics(command: EnvironmentCommand): PortOutcome<ExportResult>;

  /** Subscription bookkeeping the contract delegates to the session registry. */
  readIdempotency(requestId: string): IdempotencyRecord | undefined;
  writeIdempotency(requestId: string, record: IdempotencyRecord): void;
}
