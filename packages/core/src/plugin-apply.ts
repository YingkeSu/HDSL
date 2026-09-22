/**
 * `changes.apply` guard layer + transaction seam (ADR 0005 D8/D9/D14).
 *
 * Guard order (must be observed before any write):
 *   version(input) -> idempotency (dispatcher) -> environment EXISTS ->
 *   REVISION_CONFLICT -> plan (NOT_FOUND) -> PLAN_EXPIRED -> PLAN_CONSUMED ->
 *   BUILD_NOT_AUTHORIZED (S4 required) -> ENVIRONMENT_BUSY -> re-resolve/stage.
 *
 * Revision drift is REVISION_CONFLICT and outranks the plan-class errors
 * (ADR 0005 D6/D8/D9).
 *
 * Transaction semantics (implemented by the injected {@link PluginApplyPort} plus
 * the core commit below):
 *   - a pre-commit failure or cancel leaves the OLD generation unchanged;
 *   - after the active-generation pointer switch the transaction is COMMITTED and
 *     reconciliation is pointer-authoritative roll-forward, never a rollback;
 *   - the user's shared home/data are never rolled back.
 *
 * The transaction itself is not wired in this step: without a `PluginApplyPort`
 * the call fails with a controlled `INTERNAL_ERROR` (never a fake success) and
 * the method is not added to the callable whitelist yet.
 */
import {
  isPlainRecord,
  portFail,
  portOk,
  type BuildAuthorization,
  type ChangePlan,
  type CompositionLock,
  type EnvironmentSummary,
  type OperationRef,
  type PluginSourceLock,
  type PortOutcome,
} from '@hdsl/contracts';
import { ChangePlanStore } from './change-plan-store.js';

export interface PluginApplyStageCommand {
  readonly environmentId: string;
  readonly generationId: string;
  readonly generationDirectory: string;
  readonly environmentDirectory: string;
  readonly homeDirectory: string;
  readonly plan: ChangePlan;
  readonly buildAuthorization: BuildAuthorization | null;
}

/** Result of staging a new generation composition (before the pointer switch). */
export interface PluginApplyStaged {
  readonly compositionLock: CompositionLock;
  readonly sourceLock: PluginSourceLock;
  readonly stagedProfileDirectory: string;
}

/**
 * Runtime-owned apply adapter: resolves the source again, enforces the managed
 * executor identity + default deny, and stages the new generation composition.
 * It must not switch the active-generation pointer (core owns the commit).
 */
export interface PluginApplyPort {
  stage(
    command: PluginApplyStageCommand,
    signal: AbortSignal,
  ): Promise<PortOutcome<PluginApplyStaged>>;
}

export interface ChangeFaults {
  /** Fails after entering the named phase boundary. */
  readonly failAt?: ChangePhase;
  /** Pauses after entering the named phase, leaving journal + running operation. */
  readonly pauseAt?: ChangePhase;
}

export type ChangePhase = 'planned' | 'staged' | 'verified' | 'committed' | 'finalized';

export interface ApplyChangeCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly planId: string;
  readonly buildAuthorization: BuildAuthorization | null;
}

export interface ChangeApplyServiceOptions {
  readonly plans: ChangePlanStore;
  readonly findEnvironment: (environmentId: string) => EnvironmentSummary | undefined;
  readonly port?: PluginApplyPort;
  readonly now?: () => Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> => isPlainRecord(value);

export class ChangeApplyService {
  readonly #plans: ChangePlanStore;
  readonly #findEnvironment: (environmentId: string) => EnvironmentSummary | undefined;
  readonly #port: PluginApplyPort | undefined;
  readonly #now: () => Date;

  constructor(options: ChangeApplyServiceOptions) {
    this.#plans = options.plans;
    this.#findEnvironment = options.findEnvironment;
    this.#port = options.port;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Guard order is exhaustive and side-effect free; it returns the resolved plan
   * on success so the caller can run the transaction. Extracted from
   * {@link applyChange} so tests can assert the order directly.
   */
  evaluateGuards(
    command: ApplyChangeCommand,
  ): PortOutcome<ChangePlan> {
    const environment = this.#findEnvironment(command.environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    if (environment.revision !== command.expectedRevision) {
      return portFail('REVISION_CONFLICT', 'expectedRevision does not match the current composition revision');
    }
    if (
      environment.state === 'starting' ||
      environment.state === 'running' ||
      environment.state === 'stopping'
    ) {
      return portFail('ENVIRONMENT_BUSY', 'the environment is running or changing');
    }
    const record = this.#plans.read(command.planId);
    if (record === undefined || record.plan.environmentId !== command.environmentId) {
      return portFail('NOT_FOUND', 'the change plan was not found for this environment');
    }
    const plan = record.plan;
    const now = this.#now().getTime();
    const expiry = Date.parse(plan.expiresAt);
    if (Number.isFinite(expiry) && now > expiry) {
      return portFail('PLAN_EXPIRED', 'the change plan has expired');
    }
    if (record.consumedBy !== null && record.consumedBy !== command.requestId) {
      return portFail('PLAN_CONSUMED', 'the change plan was consumed by another request');
    }
    if (plan.requiresBuildAuthorization && command.buildAuthorization === null) {
      // Default deny: a source that needs build scripts goes through S4 (explicit
      // per-commit authorization). Never commit an unusable generation.
      return portFail('BUILD_NOT_AUTHORIZED', 'the source requires an explicit build authorization');
    }
    return portOk(plan);
  }

  /**
   * Runs the guarded transaction. Without the injected apply adapter the
   * transaction is not wired: it fails with a controlled `INTERNAL_ERROR`
   * instead of pretending to have committed anything.
   */
  applyChange(command: ApplyChangeCommand): PortOutcome<OperationRef> {
    const guarded = this.evaluateGuards(command);
    if (!guarded.ok) {
      return guarded;
    }
    if (this.#port === undefined) {
      return portFail('INTERNAL_ERROR', 'the change apply transaction is not wired');
    }
    // The transaction (stage -> verify -> publish profile -> pointer switch ->
    // journal finalize, with roll-forward after commit) is implemented in the
    // next step. Consumption is intentionally NOT marked here so a retry with a
    // new request id is not blocked by a half-run guard.
    return portFail('INTERNAL_ERROR', 'the change apply transaction is not implemented in this step');
  }

  /** Read-only helper used by callers/tests to observe consumed plans. */
  planRecord(planId: string): { readonly consumedBy: string | null } | undefined {
    const record = this.#plans.read(planId);
    return record === undefined ? undefined : { consumedBy: record.consumedBy };
  }
}

/** Narrow structural helper so callers can type-narrow an opaque plan action. */
export const isInstallAction = (value: unknown): value is { kind: 'install'; source: unknown } =>
  isRecord(value) && value['kind'] === 'install';
