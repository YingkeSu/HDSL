/**
 * `changes.apply` guards + production transaction (ADR 0005 D5/D6/D8/D9/D10/D14).
 *
 * Guard order (side-effect free, before any write):
 *   version(input) -> idempotency (dispatcher) -> environment EXISTS ->
 *   REVISION_CONFLICT -> plan NOT_FOUND -> PLAN_EXPIRED -> PLAN_CONSUMED ->
 *   BUILD_NOT_AUTHORIZED -> ENVIRONMENT_BUSY -> unresolved apply journal.
 *
 * Transaction phases (commit point = active-generation pointer switch):
 *   planned -> staged -> verified -> committed -> finalized
 * - a pre-commit failure/cancel leaves the OLD generation unchanged and does not
 *   consume the plan; the staged generation directory is removed;
 * - after the pointer switch the transaction is COMMITTED: reconciliation is
 *   pointer-authoritative roll-forward (never a rollback), and the plan is
 *   consumed exactly once;
 * - the user's shared home/data are never rolled back.
 *
 * `ChangeFaults.failAt`/`pauseAt` fire AFTER entering the named phase boundary and
 * are injected by tests only (no IPC/backdoor).
 */
import {
  isPlainRecord,
  contractError,
  contractErrorForCode,
  portFail,
  portOk,
  type BuildAuthorization,
  type ChangeApplication,
  type ChangePlan,
  type ContractMethod,
  type CompositionLock,
  type EnvironmentSummary,
  type OperationRef,
  type OperationSnapshot,
  type PluginSourceLock,
  type PortOutcome,
} from '@hdsl/contracts';
import { join } from 'node:path';
import type { RestoreGenerationCommand } from '@hdsl/contracts';
import { ChangePlanStore } from './change-plan-store.js';
import { EnvironmentStore, type EnvironmentRecord } from './environment-store.js';
import { IdempotencyStore } from './idempotency-store.js';
import { OperationStore, isTerminalStatus, toOperationSnapshot } from './operation-store.js';
import { managedProfileName, publishGenerationProfile } from './generation-profile.js';
import { applyJournalRecordPath, generationPaths, type AppDataLayout } from './layout.js';
import { reuseGenerationRuntime } from './generation-runtime-reuse.js';
import { readTargetProfileCache } from './target-profile-cache.js';
import { ensureDirectory, readDirectoryNames, removePath, tryReadJsonFile, writeJsonAtomic } from './fsx.js';
import { newGenerationId, newOperationId, newTransactionId } from './ids.js';

export interface PluginApplyStageCommand {
  readonly environmentId: string;
  readonly generationId: string;
  readonly generationDirectory: string;
  readonly environmentDirectory: string;
  readonly homeDirectory: string;
  /** Managed Node executable of the reused runtime. */
  readonly nodeExecutable: string;
  /** Composition lock of the current active generation (runtime is reused). */
  readonly currentLock: CompositionLock;
  readonly plan: ChangePlan;
  readonly buildAuthorization: BuildAuthorization | null;
  /**
   * Verified target-profile content from the plan cache. When present the
   * adapter installs with this frozen lock; when absent it uses the legacy path.
   */
  readonly targetProfile?: {
    readonly lockText: string;
    readonly declarationText: string;
    readonly workspaceText: string | null;
  };
}

/** Result of staging a new generation composition (before the pointer switch). */
export interface PluginApplyStaged {
  readonly compositionLock: CompositionLock;
  readonly sourceLock: PluginSourceLock;
  readonly stagedProfileDirectory: string;
}

/**
 * Runtime-owned apply adapter: re-resolves the source, enforces the managed
 * executor identity + default deny + the fully-pinned closure lock, and stages
 * the new generation composition. It must not switch the active-generation
 * pointer (core owns the commit).
 */
export interface PluginApplyPort {
  stage(
    command: PluginApplyStageCommand,
    signal: AbortSignal,
  ): Promise<PortOutcome<PluginApplyStaged>>;
}

export type ChangePhase = 'planned' | 'staged' | 'verified' | 'committed' | 'finalized';

export interface ChangeFaults {
  /** Fails after entering the named phase boundary. */
  readonly failAt?: ChangePhase;
  /** Pauses after entering the named phase, leaving journal + running operation. */
  readonly pauseAt?: ChangePhase;
}

export interface ApplyChangeCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly planId: string;
  readonly buildAuthorization: BuildAuthorization | null;
}

export interface ChangeApplyServiceOptions {
  readonly layout: AppDataLayout;
  readonly plans: ChangePlanStore;
  readonly environments: EnvironmentStore;
  readonly operations: OperationStore;
  readonly compositionDigest: (lock: CompositionLock) => string;
  readonly port?: PluginApplyPort;
  /** Reuses the existing managed-install identity verification for the copied runtime. */
  readonly verifyGenerationRuntime?: (input: {
    readonly manifestPath: string;
    readonly nodeDirectory: string;
    readonly dshDirectory: string;
  }) => boolean;
  readonly now?: () => Date;
  /** Test-only fault injection. */
  readonly faults?: ChangeFaults;
  /**
   * Durable idempotency ledger shared with the dispatcher. Recovery reconciles
   * `in-progress` records to a terminal state so a same-`requestId` replay after
   * a crash returns the original outcome (or a controlled failure) instead of
   * `ENVIRONMENT_BUSY` forever.
   */
  readonly idempotency?: IdempotencyStore;
}

interface ApplyJournalRecord {
  readonly schemaVersion: '1';
  readonly kind?: 'apply' | 'restore';
  readonly transactionId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly environmentId: string;
  readonly generationId: string;
  readonly planId: string;
  readonly sourceLock: PluginSourceLock | null;
  readonly phase: ChangePhase;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApplyRecoveryReport {
  readonly finalized: number;
  readonly rolledBack: number;
}

const ALL_PHASES: readonly ChangePhase[] = ['planned', 'staged', 'verified', 'committed', 'finalized'];

/** Methods whose crashed `in-progress` ledger entries this service reconciles. */
const RECONCILABLE_IDEMPOTENT_METHODS: readonly ContractMethod[] = ['changes.apply', 'generations.restore'];

export class ChangeApplyService {
  readonly #layout: AppDataLayout;
  readonly #plans: ChangePlanStore;
  readonly #environments: EnvironmentStore;
  readonly #operations: OperationStore;
  readonly #compositionDigest: (lock: CompositionLock) => string;
  readonly #port: PluginApplyPort | undefined;
  readonly #now: () => Date;
  readonly #faults: ChangeFaults;
  readonly #verifyGenerationRuntime:
    | ((input: { readonly manifestPath: string; readonly nodeDirectory: string; readonly dshDirectory: string }) => boolean)
    | undefined;
  readonly #controllers = new Map<string, AbortController>();
  readonly #inFlight = new Set<string>();
  readonly #idempotency: IdempotencyStore;

  constructor(options: ChangeApplyServiceOptions) {
    this.#layout = options.layout;
    this.#plans = options.plans;
    this.#environments = options.environments;
    this.#operations = options.operations;
    this.#compositionDigest = options.compositionDigest;
    this.#port = options.port;
    this.#now = options.now ?? (() => new Date());
    this.#faults = options.faults ?? {};
    this.#verifyGenerationRuntime = options.verifyGenerationRuntime;
    this.#idempotency = options.idempotency ?? new IdempotencyStore(options.layout);
  }

  get environmentStore(): EnvironmentStore {
    return this.#environments;
  }

  /** Side-effect-free guard evaluation; returns the resolved plan on success. */
  evaluateGuards(command: ApplyChangeCommand): PortOutcome<ChangePlan> {
    const environment = this.#environments.read(command.environmentId);
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
    // S4 (build authorization) is not available in this slice. A source that
    // needs build scripts is refused, and any supplied authorization is refused
    // too: a non-null value is never treated as an unlock.
    if (plan.requiresBuildAuthorization || command.buildAuthorization !== null) {
      return portFail(
        'BUILD_NOT_AUTHORIZED',
        'install-time build scripts are refused by default; build authorization (S4) is not available in this slice',
      );
    }
    return portOk(plan);
  }

  applyChange(command: ApplyChangeCommand): PortOutcome<OperationRef> {
    const guarded = this.evaluateGuards(command);
    if (!guarded.ok) {
      return guarded;
    }
    // Busy/reconciliation-required is a client-facing condition and must be
    // reported before any wiring/internal check.
    if (this.#inFlight.has(command.environmentId) || this.#hasOpenJournal(command.environmentId)) {
      return portFail('ENVIRONMENT_BUSY', 'another change transaction is in progress for this environment');
    }
    if (this.#port === undefined) {
      return portFail('INTERNAL_ERROR', 'the change apply transaction is not wired');
    }
    const operationId = newOperationId();
    const generationId = newGenerationId();
    const transactionId = newTransactionId();
    this.#operations.create({
      id: operationId,
      kind: 'apply',
      environmentId: command.environmentId,
      phase: 'planned',
      status: 'running',
      createdAt: this.#now().toISOString(),
    });
    this.#inFlight.add(command.environmentId);
    const controller = new AbortController();
    this.#controllers.set(operationId, controller);
    void this.#run(command, guarded.value, { operationId, generationId, transactionId }, controller.signal);
    return portOk({ operationId });
  }

  /**
   * Restores a previous generation as the active one (ADR 0005 D4/D10).
   *
   * Pointer-only: the target generation's recorded composition identity is
   * authoritative, the shared environment home/data are untouched, no retained
   * generation is deleted, and no live profile identity is rebuilt. The target
   * runtime identity is verified and its managed profile is (re)published from
   * the immutable declaration source BEFORE the pointer switch; any failure is
   * controlled and leaves the current generation active.
   */
  restoreGeneration(command: RestoreGenerationCommand): PortOutcome<OperationRef> {
    const environment = this.#environments.read(command.environmentId);
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
    const paths = generationPaths(this.#layout, command.environmentId, command.targetGenerationId);
    const record = tryReadJsonFile<{ id?: string; compositionDigest?: string; profileName?: string; createdAt?: string }>(
      paths.generationRecordPath,
    );
    if (record === undefined || typeof record.compositionDigest !== 'string') {
      return portFail('NOT_FOUND', 'the target generation was not found');
    }
    if (tryReadJsonFile(paths.manifestPath) === undefined) {
      return portFail('NOT_FOUND', 'the target generation has no install manifest');
    }
    // Idempotent no-op when the target is already active.
    if (environment.activeGenerationId === command.targetGenerationId) {
      const operationId = newOperationId();
      this.#operations.create({ id: operationId, kind: 'restore', environmentId: command.environmentId, phase: 'switched', status: 'running', createdAt: this.#now().toISOString() });
      const created = this.#operations.read(operationId);
      if (created !== undefined) {
        this.#operations.update(created, { status: 'succeeded', phase: 'finished', output: this.#generationSummary(command, record) }, this.#now().toISOString());
      }
      this.#reconcileLedger(command.requestId, operationId);
      return portOk({ operationId });
    }
    // Single-active: refuse while another apply/restore transaction is pending.
    if (this.#inFlight.has(command.environmentId) || this.#hasOpenJournal(command.environmentId)) {
      return portFail('ENVIRONMENT_BUSY', 'another change transaction is in progress for this environment');
    }
    if (
      this.#verifyGenerationRuntime !== undefined &&
      !this.#verifyGenerationRuntime({
        manifestPath: paths.manifestPath,
        nodeDirectory: paths.nodeDirectory,
        dshDirectory: paths.dshDirectory,
      })
    ) {
      return portFail('INTERNAL_ERROR', 'the target generation runtime did not match its recorded identity');
    }
    // Re-publish the managed profile from the IMMUTABLE declaration source; never
    // from the live profile. A missing/mismatching source fails closed.
    try {
      publishGenerationProfile({
        layout: this.#layout,
        environmentId: command.environmentId,
        generationId: command.targetGenerationId,
        transactionId: `restore-${command.requestId}`,
        stagedDirectory: join(paths.generationDirectory, 'profile'),
      });
    } catch (error) {
      return portFail(
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'the target generation profile could not be published',
      );
    }
    const transactionId = newTransactionId();
    const operationId = newOperationId();
    const createdAt = this.#now().toISOString();
    // Durable journal FIRST (before the operation record and the pointer write):
    // any crash after this point is reconciled by recover(); a crash after the
    // switch is finalize (pointer authoritative), before it is a discard with
    // nothing to roll back (restore has no staging).
    writeJsonAtomic(applyJournalRecordPath(this.#layout, transactionId), {
      schemaVersion: '1',
      kind: 'restore',
      transactionId,
      requestId: command.requestId,
      operationId,
      environmentId: command.environmentId,
      generationId: command.targetGenerationId,
      planId: '',
      sourceLock: null,
      phase: 'committed',
      createdAt,
      updatedAt: createdAt,
    } satisfies ApplyJournalRecord);
    this.#operations.create({
      id: operationId,
      kind: 'restore',
      environmentId: command.environmentId,
      phase: 'switching',
      status: 'running',
      createdAt,
    });
    this.#environments.write({
      ...environment,
      activeGenerationId: command.targetGenerationId,
      revision: environment.revision + 1,
      compositionDigest: record.compositionDigest,
      updatedAt: this.#now().toISOString(),
    });
    const created = this.#operations.read(operationId);
    if (created !== undefined) {
      this.#operations.update(
        created,
        {
          status: 'succeeded',
          phase: 'finished',
          output: {
            generationId: command.targetGenerationId,
            environmentId: command.environmentId,
            compositionDigest: record.compositionDigest,
            profileName: typeof record.profileName === 'string' ? record.profileName : managedProfileName(command.targetGenerationId),
            active: true,
            createdAt: record.createdAt ?? this.#now().toISOString(),
          },
        },
        this.#now().toISOString(),
      );
    }
    this.#reconcileLedger(command.requestId, operationId);
    this.#removeJournal(transactionId);
    return portOk({ operationId });
  }

  #generationSummary(
    command: RestoreGenerationCommand,
    record: { readonly compositionDigest?: string; readonly profileName?: string; readonly createdAt?: string },
  ): Record<string, unknown> {
    return {
      generationId: command.targetGenerationId,
      environmentId: command.environmentId,
      compositionDigest: record.compositionDigest,
      profileName: typeof record.profileName === 'string' ? record.profileName : managedProfileName(command.targetGenerationId),
      active: true,
      createdAt: record.createdAt ?? this.#now().toISOString(),
    };
  }

  /** Reconciles interrupted apply transactions: pointer decides roll-forward. */
  recover(): ApplyRecoveryReport {
    let finalized = 0;
    let rolledBack = 0;
    const reconciledRequestIds = new Set<string>();
    for (const journal of this.#listJournals()) {
      const environment = this.#environments.read(journal.environmentId);
      if (environment !== undefined && environment.activeGenerationId === journal.generationId) {
        this.#markOperationSucceeded(journal.operationId, journal.generationId, journal.planId, journal.sourceLock, journal.requestId);
        if (journal.kind !== 'restore') {
          this.#plans.consumeIfUnused(journal.planId, journal.requestId);
        }
        this.#removeJournal(journal.transactionId);
        finalized += 1;
        continue;
      }
      if (journal.kind === 'restore') {
        // A restore has no staging: nothing to delete; the pointer still points
        // at the previous generation, so this is simply discarded.
        const record = this.#operations.read(journal.operationId);
        if (record !== undefined && !isTerminalStatus(record.status)) {
          this.#operations.update(
            record,
            { status: 'failed', phase: 'failed', error: contractError('INTERNAL_ERROR', 'the restore was interrupted before the pointer switch', { operationId: journal.operationId }) },
            this.#now().toISOString(),
          );
        }
        this.#reconcileLedger(journal.requestId, journal.operationId);
        reconciledRequestIds.add(journal.requestId);
        this.#removeJournal(journal.transactionId);
        rolledBack += 1;
        continue;
      }
      this.#rollback(journal, 'INTERNAL_ERROR', 'apply was interrupted before the generation was committed');
      rolledBack += 1;
    }
    // Orphan reconciliation: a `restore` operation left non-terminal with no
    // journal (crash between the operation record and the journal, or a partial
    // write) would otherwise keep the same requestId stuck in progress forever.
    // The pointer is a single atomic write and stays self-consistent, so the
    // only safe action is to fail the orphaned operation controllably.
    const journalOperationIds = new Set(this.#listJournals().map((journal) => journal.operationId));
    for (const record of this.#operations.list()) {
      if (record.kind !== 'restore' || isTerminalStatus(record.status) || journalOperationIds.has(record.id)) {
        continue;
      }
      this.#operations.update(
        record,
        { status: 'failed', phase: 'failed', error: contractError('INTERNAL_ERROR', 'the restore was interrupted before it could be committed', { operationId: record.id }) },
        this.#now().toISOString(),
      );
      rolledBack += 1;
    }
    // Ledger sweep: an `in-progress` record for an apply/restore transaction that
    // no journal reconciled means the crash happened before any durable effect
    // evidence existed. A same-requestId replay must not stay `ENVIRONMENT_BUSY`
    // forever, so bind it to a controlled terminal failure (the original
    // method/fingerprint binding is preserved, so a different payload under the
    // same id is still `IDEMPOTENCY_CONFLICT`). `changes.preview` is out of scope.
    for (const { requestId, record: ledger } of this.#idempotency.list()) {
      if (ledger.state !== 'in-progress' || reconciledRequestIds.has(requestId)) {
        continue;
      }
      if (!RECONCILABLE_IDEMPOTENT_METHODS.includes(ledger.method)) {
        continue;
      }
      this.#reconcileLedger(requestId, null);
      rolledBack += 1;
    }
    return { finalized, rolledBack };
  }

  async #run(
    command: ApplyChangeCommand,
    plan: ChangePlan,
    ids: { readonly operationId: string; readonly generationId: string; readonly transactionId: string },
    signal: AbortSignal,
  ): Promise<void> {
    const environment = this.#environments.read(command.environmentId);
    if (environment === undefined) {
      return;
    }
    const paths = generationPaths(this.#layout, command.environmentId, ids.generationId);
    const journalBase = {
      schemaVersion: '1' as const,
      transactionId: ids.transactionId,
      requestId: command.requestId,
      operationId: ids.operationId,
      environmentId: command.environmentId,
      generationId: ids.generationId,
      planId: plan.planId,
      sourceLock: null as PluginSourceLock | null,
      createdAt: this.#now().toISOString(),
    };
    const writeJournal = (phase: ChangePhase, sourceLock: PluginSourceLock | null): void => {
      writeJsonAtomic(applyJournalRecordPath(this.#layout, ids.transactionId), {
        ...journalBase,
        sourceLock,
        phase,
        updatedAt: this.#now().toISOString(),
      } satisfies ApplyJournalRecord);
    };
    const controller = new AbortController();
    try {
      writeJournal('planned', null);
      if (this.#fault(ids.operationId, 'planned')) {
        return;
      }

      ensureDirectory(paths.generationDirectory);
      // Reuse the active generation's runtime (physical copy + identity binding)
      // so the new generation keeps a usable Node/DSH install. A missing or
      // unverified identity fails closed before any publish/commit.
      const activeGenerationId = environment.activeGenerationId;
      if (activeGenerationId === null) {
        this.#rollbackJournal(ids, 'INTERNAL_ERROR', 'the environment has no active generation to reuse');
        return;
      }
      const reused = reuseGenerationRuntime({
        layout: this.#layout,
        environmentId: command.environmentId,
        fromGenerationId: activeGenerationId,
        toGenerationId: ids.generationId,
        ...(this.#verifyGenerationRuntime === undefined ? {} : { verify: this.#verifyGenerationRuntime }),
      });
      if (!reused.ok || reused.value.identityVerified !== true) {
        this.#rollbackJournal(ids, 'INTERNAL_ERROR', 'the new generation runtime could not be verified');
        return;
      }
      const currentLock = tryReadJsonFile<CompositionLock>(
        generationPaths(this.#layout, command.environmentId, activeGenerationId).lockPath,
      );
      if (currentLock === undefined) {
        this.#rollbackJournal(ids, 'INTERNAL_ERROR', 'the active generation has no composition lock');
        return;
      }
      // A plan that binds a target profile must have a verified cache entry; a
      // missing/tampered/mismatched cache fails closed before any execution.
      let targetProfile: { lockText: string; declarationText: string; workspaceText: string | null } | undefined;
      if (plan.sourceLock?.targetDeclarationSha256 !== undefined) {
        const cached = readTargetProfileCache(this.#layout, plan.planId, {
          lockSha256: plan.sourceLock.closureLockSha256,
          declarationSha256: plan.sourceLock.targetDeclarationSha256,
        });
        if (!cached.ok) {
          this.#rollbackJournal(ids, cached.code, cached.message);
          return;
        }
        targetProfile = {
          lockText: cached.value.lockText,
          declarationText: cached.value.declarationText,
          workspaceText: cached.value.workspaceText,
        };
      }
      const staged = await this.#port!.stage(
        {
          environmentId: command.environmentId,
          generationId: ids.generationId,
          generationDirectory: paths.generationDirectory,
          environmentDirectory: join(this.#layout.environments, command.environmentId),
          homeDirectory: paths.homeDirectory,
          nodeExecutable: join(paths.generationDirectory, 'node', 'bin', 'node'),
          currentLock,
          plan,
          buildAuthorization: command.buildAuthorization,
          ...(targetProfile === undefined ? {} : { targetProfile }),
        },
        controller.signal,
      );
      if (!staged.ok) {
        this.#rollbackJournal(ids, staged.code, staged.message);
        return;
      }
      writeJournal('staged', staged.value.sourceLock);
      if (this.#fault(ids.operationId, 'staged')) {
        return;
      }

      // Verify: the composition digest is recomputed by core from the staged lock.
      const digest = this.#compositionDigest(staged.value.compositionLock);
      writeJournal('verified', staged.value.sourceLock);
      if (this.#fault(ids.operationId, 'verified')) {
        return;
      }

      if (signal.aborted) {
        // Cancelled before the commit point: no pointer switch, no consumption.
        this.#cancelJournal(ids);
        return;
      }
      const published = publishGenerationProfile({
        layout: this.#layout,
        environmentId: command.environmentId,
        generationId: ids.generationId,
        transactionId: ids.transactionId,
        stagedDirectory: staged.value.stagedProfileDirectory,
      });
      writeJsonAtomic(paths.lockPath, staged.value.compositionLock);
      writeJsonAtomic(paths.generationRecordPath, {
        id: ids.generationId,
        environmentId: command.environmentId,
        compositionDigest: digest,
        createdAt: this.#now().toISOString(),
        profileName: managedProfileName(ids.generationId),
        profileDigest: published.fingerprint,
      });

      // COMMIT POINT re-validation: staging is asynchronous, so another
      // transaction (e.g. a restore) may have moved the pointer meanwhile.
      // Last-writer-wins would silently discard it; instead refuse before the
      // pointer switch and keep the previous generation active.
      const current = this.#environments.read(command.environmentId);
      if (current === undefined) {
        this.#rollbackJournal(ids, 'INTERNAL_ERROR', 'the environment disappeared while the change was being staged');
        return;
      }
      if (current.revision !== command.expectedRevision) {
        this.#rollbackJournal(ids, 'REVISION_CONFLICT', 'the environment revision changed while the change was being staged');
        return;
      }
      this.#environments.write({
        ...current,
        state: 'stopped',
        stateVersion: current.stateVersion + 1,
        revision: current.revision + 1,
        activeGenerationId: ids.generationId,
        compositionDigest: digest,
        updatedAt: this.#now().toISOString(),
      });
      writeJournal('committed', staged.value.sourceLock);
      if (this.#fault(ids.operationId, 'committed')) {
        return;
      }

      this.#plans.consume(plan.planId, command.requestId);
      this.#markOperationSucceeded(ids.operationId, ids.generationId, plan.planId, staged.value.sourceLock, command.requestId, digest);
      writeJournal('finalized', staged.value.sourceLock);
      this.#removeJournal(ids.transactionId);
    } catch {
      this.#rollbackJournal(ids, 'INTERNAL_ERROR', 'the apply transaction failed');
    } finally {
      this.#controllers.delete(ids.operationId);
      this.#inFlight.delete(command.environmentId);
    }
  }

  owns(operationId: string): boolean {
    return this.#operations.read(operationId)?.kind === 'apply';
  }

  findOperation(operationId: string): PortOutcome<OperationSnapshot> | undefined {
    if (!this.owns(operationId)) {
      return undefined;
    }
    const record = this.#operations.read(operationId);
    return record === undefined
      ? portFail('NOT_FOUND', 'operation was not found')
      : portOk(toOperationSnapshot(record));
  }

  cancelOperation(operationId: string): PortOutcome<OperationSnapshot> | undefined {
    if (!this.owns(operationId)) {
      return undefined;
    }
    const record = this.#operations.read(operationId);
    if (record === undefined) {
      return portFail('NOT_FOUND', 'operation was not found');
    }
    if (isTerminalStatus(record.status)) {
      return portFail('CANNOT_CANCEL', 'operation already reached a final state');
    }
    this.#controllers.get(operationId)?.abort();
    const updated = this.#operations.update(
      record,
      { status: 'cancelled', phase: 'cancelled' },
      this.#now().toISOString(),
    );
    return portOk(toOperationSnapshot(updated));
  }

  #cancelJournal(ids: { readonly operationId: string; readonly generationId: string; readonly transactionId: string }): void {
    const journal = this.#readJournal(ids.transactionId);
    if (journal !== undefined) {
      removePath(generationPaths(this.#layout, journal.environmentId, journal.generationId).generationDirectory);
      this.#removeJournal(journal.transactionId);
    }
  }

  #fault(operationId: string, phase: ChangePhase): boolean {
    if (this.#faults.failAt === phase) {
      this.#rollbackJournalById(operationId, 'INTERNAL_ERROR', `injected failure at ${phase}`);
      return true;
    }
    if (this.#faults.pauseAt === phase) {
      // Leaves journal + running operation for a SIGKILL/recover.
      return true;
    }
    return false;
  }

  #rollbackJournal(
    ids: { readonly operationId: string; readonly generationId: string; readonly transactionId: string },
    code: Parameters<typeof contractErrorForCode>[0],
    message: string,
  ): void {
    const journal = this.#readJournal(ids.transactionId);
    if (journal !== undefined) {
      this.#rollback(journal, code, message);
      return;
    }
    this.#rollbackJournalById(ids.operationId, code, message);
  }

  #rollbackJournalById(
    operationId: string,
    code: Parameters<typeof contractErrorForCode>[0],
    message: string,
  ): void {
    const journal = this.#listJournals().find((entry) => entry.operationId === operationId);
    if (journal !== undefined) {
      this.#rollback(journal, code, message);
    }
  }

  #rollback(journal: ApplyJournalRecord, code: Parameters<typeof contractErrorForCode>[0], message: string): void {
    const record = this.#operations.read(journal.operationId);
    if (record !== undefined && !isTerminalStatus(record.status)) {
      this.#operations.update(
        record,
        {
          status: 'failed',
          phase: 'failed',
          error: contractError(code, message, { operationId: journal.operationId }),
        },
        this.#now().toISOString(),
      );
    }
    removePath(generationPaths(this.#layout, journal.environmentId, journal.generationId).generationDirectory);
    // Reconcile the dispatcher ledger: the effect is terminal (the operation is
    // failed), so a same-requestId replay must return that bound operation
    // instead of staying `in-progress` (permanent ENVIRONMENT_BUSY).
    this.#reconcileLedger(journal.requestId, journal.operationId);
    this.#removeJournal(journal.transactionId);
    void message;
  }

  /**
   * Moves an `in-progress` ledger record to its terminal state, preserving the
   * original method/fingerprint binding so a different payload under the same
   * `requestId` is still rejected as `IDEMPOTENCY_CONFLICT`. No-op when the
   * dispatcher already wrote the outcome (the normal path).
   */
  #reconcileLedger(requestId: string, operationId: string | null): void {
    const ledger = this.#idempotency.read(requestId);
    if (ledger === undefined || ledger.state !== 'in-progress') {
      return;
    }
    this.#idempotency.write(requestId, {
      state: 'completed',
      method: ledger.method,
      fingerprint: ledger.fingerprint,
      outcome:
        operationId === null
          ? { ok: false, error: contractError('INTERNAL_ERROR', 'the change transaction was interrupted before it started; retry with a new requestId') }
          : { ok: true, value: { operationId } },
    });
  }

  #markOperationSucceeded(
    operationId: string,
    generationId: string,
    planId: string,
    sourceLock: PluginSourceLock | null,
    requestId: string,
    compositionDigest?: string,
  ): void {
    const record = this.#operations.read(operationId);
    if (record === undefined || isTerminalStatus(record.status)) {
      return;
    }
    const environment = this.#environments.read(record.environmentId ?? '');
    const output: ChangeApplication = {
      planId,
      environmentId: record.environmentId ?? '',
      generationId,
      compositionDigest: compositionDigest ?? environment?.compositionDigest ?? '0'.repeat(64),
      sourceLock,
      committedAt: this.#now().toISOString(),
    };
    this.#operations.update(
      record,
      { status: 'succeeded', phase: 'finished', output },
      this.#now().toISOString(),
    );
    this.#reconcileLedger(requestId, operationId);
  }

  #hasOpenJournal(environmentId: string): boolean {
    return this.#listJournals().some((journal) => journal.environmentId === environmentId);
  }

  #readJournal(transactionId: string): ApplyJournalRecord | undefined {
    return tryReadJsonFile<ApplyJournalRecord>(applyJournalRecordPath(this.#layout, transactionId));
  }

  #listJournals(): ApplyJournalRecord[] {
    const records: ApplyJournalRecord[] = [];
    for (const name of readDirectoryNames(this.#layout.applyJournals)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const record = tryReadJsonFile<ApplyJournalRecord>(
        join(this.#layout.applyJournals, name),
      );
      if (record !== undefined && ALL_PHASES.includes(record.phase)) {
        records.push(record);
      }
    }
    return records;
  }

  #removeJournal(transactionId: string): void {
    removePath(applyJournalRecordPath(this.#layout, transactionId));
  }
}

/** Narrow structural helper so callers can type-narrow an opaque plan action. */
export const isInstallAction = (value: unknown): value is { kind: 'install'; source: unknown } =>
  isPlainRecord(value) && value['kind'] === 'install';

export type { EnvironmentRecord, OperationSnapshot, EnvironmentSummary };
