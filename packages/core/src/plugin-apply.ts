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
  contractErrorForCode,
  portFail,
  portOk,
  type BuildAuthorization,
  type ChangeApplication,
  type ChangePlan,
  type CompositionLock,
  type EnvironmentSummary,
  type OperationRef,
  type OperationSnapshot,
  type PluginSourceLock,
  type PortOutcome,
} from '@hdsl/contracts';
import { join } from 'node:path';
import { ChangePlanStore } from './change-plan-store.js';
import { EnvironmentStore, type EnvironmentRecord } from './environment-store.js';
import { OperationStore, isTerminalStatus } from './operation-store.js';
import { managedProfileName, publishGenerationProfile } from './generation-profile.js';
import { applyJournalRecordPath, generationPaths, type AppDataLayout } from './layout.js';
import { reuseGenerationRuntime } from './generation-runtime-reuse.js';
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
}

interface ApplyJournalRecord {
  readonly schemaVersion: '1';
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
  readonly #inFlight = new Set<string>();

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
    if (plan.requiresBuildAuthorization && command.buildAuthorization === null) {
      return portFail('BUILD_NOT_AUTHORIZED', 'the source requires an explicit build authorization');
    }
    return portOk(plan);
  }

  applyChange(command: ApplyChangeCommand): PortOutcome<OperationRef> {
    const guarded = this.evaluateGuards(command);
    if (!guarded.ok) {
      return guarded;
    }
    if (this.#port === undefined) {
      return portFail('INTERNAL_ERROR', 'the change apply transaction is not wired');
    }
    if (this.#inFlight.has(command.environmentId) || this.#hasOpenJournal(command.environmentId)) {
      return portFail('ENVIRONMENT_BUSY', 'another apply transaction is in progress for this environment');
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
    void this.#run(command, guarded.value, { operationId, generationId, transactionId });
    return portOk({ operationId });
  }

  /** Reconciles interrupted apply transactions: pointer decides roll-forward. */
  recover(): ApplyRecoveryReport {
    let finalized = 0;
    let rolledBack = 0;
    for (const journal of this.#listJournals()) {
      const environment = this.#environments.read(journal.environmentId);
      if (environment !== undefined && environment.activeGenerationId === journal.generationId) {
        this.#markOperationSucceeded(journal.operationId, journal.generationId, journal.planId, journal.sourceLock);
        this.#plans.consumeIfUnused(journal.planId, journal.requestId);
        this.#removeJournal(journal.transactionId);
        finalized += 1;
        continue;
      }
      this.#rollback(journal, 'INTERNAL_ERROR', 'apply was interrupted before the generation was committed');
      rolledBack += 1;
    }
    return { finalized, rolledBack };
  }

  async #run(
    command: ApplyChangeCommand,
    plan: ChangePlan,
    ids: { readonly operationId: string; readonly generationId: string; readonly transactionId: string },
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

      const current = this.#environments.read(command.environmentId);
      if (current !== undefined) {
        this.#environments.write({
          ...current,
          state: 'stopped',
          stateVersion: current.stateVersion + 1,
          revision: current.revision + 1,
          activeGenerationId: ids.generationId,
          compositionDigest: digest,
          updatedAt: this.#now().toISOString(),
        });
      }
      writeJournal('committed', staged.value.sourceLock);
      if (this.#fault(ids.operationId, 'committed')) {
        return;
      }

      this.#plans.consume(plan.planId, command.requestId);
      this.#markOperationSucceeded(ids.operationId, ids.generationId, plan.planId, staged.value.sourceLock, digest);
      writeJournal('finalized', staged.value.sourceLock);
      this.#removeJournal(ids.transactionId);
    } catch {
      this.#rollbackJournal(ids, 'INTERNAL_ERROR', 'the apply transaction failed');
    } finally {
      this.#inFlight.delete(command.environmentId);
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
        { status: 'failed', phase: 'failed', error: contractErrorForCode(code, {}) },
        this.#now().toISOString(),
      );
    }
    removePath(generationPaths(this.#layout, journal.environmentId, journal.generationId).generationDirectory);
    this.#removeJournal(journal.transactionId);
    void message;
  }

  #markOperationSucceeded(
    operationId: string,
    generationId: string,
    planId: string,
    sourceLock: PluginSourceLock | null,
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
