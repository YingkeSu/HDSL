/**
 * Environment creation + managed install, and the restart recovery entry point.
 *
 * The `ContractPort` call is synchronous, so `createEnvironment` persists the
 * environment record, the journal and the operation and then starts the
 * download/extract/closure/preflight work asynchronously. Callers observe the
 * terminal state through `operations.get`/`environments.list` or
 * {@link EnvironmentService.waitForOperation}.
 *
 * Guarantees encoded here:
 * - the active generation pointer is written only after artifacts, the DSH
 *   dependency closure and the preflight all succeeded;
 * - the default HOME and `~/.dsh` are never written: every managed process runs
 *   with explicit `HOME`/`DSH_HOME`/cache variables inside the generation or
 *   app-data root;
 * - an `artifacts-only` install (synthetic fixture runtime) is refused on the
 *   production path unless the caller explicitly opts in, so a fixture can
 *   never be committed as a complete, bootable generation;
 * - an interrupted transaction is reconciled by {@link
 *   EnvironmentService.recover} from the durable journal.
 */
import {
  contractError,
  portFail,
  portOk,
  type CompositionLock,
  type ErrorCode,
  type CreateEnvironmentCommand,
  type EnvironmentSummary,
  type HostPlatform,
  type OperationRef,
  type OperationSnapshot,
  type PortOutcome,
  type RuntimeCombination,
} from '@hdsl/contracts';
import { ensureDirectory, isSpaceError, readJsonFile, removePath, writeJsonAtomic } from './fsx.js';
import { newEnvironmentId, newGenerationId, newOperationId, newTransactionId } from './ids.js';
import {
  generationPaths,
  ensureLayout,
  resolveLayout,
  type AppDataLayout,
} from './layout.js';
import {
  EnvironmentStore,
  toEnvironmentSummary,
  type EnvironmentRecord,
} from './environment-store.js';
import {
  OperationStore,
  isTerminalStatus,
  toOperationSnapshot,
  type OperationRecord,
} from './operation-store.js';
import { JournalStore, type CreateJournalRecord } from './journal.js';
import { IdempotencyStore } from './idempotency-store.js';
import type {
  DiagnosticsExporter,
  InstallContext,
  InstallManifest,
  ManagedRuntimePort,
  ProcessLifecyclePort,
} from './ports.js';
import { errorCodeFrom, ManagedInstallError } from './errors.js';

export interface CreationFaults {
  /** Aborts after artifacts are installed but before the pointer switch. */
  readonly failBeforeCommit?: boolean;
  /** Leaves the journal `artifacts-installed` and the operation running. */
  readonly pauseBeforeCommit?: boolean;
}

export interface EnvironmentServiceOptions {
  readonly dataRoot: string;
  readonly catalog: readonly RuntimeCombination[];
  readonly runtime: ManagedRuntimePort;
  readonly host?: HostPlatform;
  readonly clock?: () => Date;
  readonly faults?: CreationFaults;
  readonly process?: ProcessLifecyclePort;
  readonly exportDiagnostics?: DiagnosticsExporter;
  readonly operationTimeoutMs?: number;
  /**
   * Test-only escape hatch. The production creation path refuses to commit an
   * `artifacts-only` manifest; only a fixture harness may set this to `true`,
   * and the generation still carries `installMode: 'artifacts-only'`.
   */
  readonly allowArtifactsOnly?: boolean;
}

export interface RecoveryDetail {
  readonly transactionId: string | null;
  readonly environmentId: string | null;
  readonly operationId: string | null;
  readonly generationId: string | null;
  readonly resolution: 'finalized' | 'rolled-back' | 'failed';
}

export interface RecoveryReport {
  readonly reconciled: number;
  readonly finalized: number;
  readonly rolledBack: number;
  readonly details: readonly RecoveryDetail[];
}

interface CreateJob {
  readonly requestId: string;
  readonly operationId: string;
  readonly environmentId: string;
  readonly generationId: string;
  readonly transactionId: string;
  readonly name: string;
  readonly digest: string;
  readonly lock: CompositionLock;
  readonly createdAt: string;
  readonly journal: CreateJournalRecord;
}

const notFound = (message: string): PortOutcome<never> => portFail('NOT_FOUND', message);

export class EnvironmentService {
  readonly #layout: AppDataLayout;
  readonly #catalog: readonly RuntimeCombination[];
  readonly #runtime: ManagedRuntimePort;
  readonly #host: HostPlatform;
  readonly #clock: () => Date;
  readonly #faults: CreationFaults;
  readonly #process: ProcessLifecyclePort | undefined;
  readonly #exportDiagnostics: DiagnosticsExporter | undefined;
  readonly #operationTimeoutMs: number;
  readonly #allowArtifactsOnly: boolean;

  readonly #environments: EnvironmentStore;
  readonly #operations: OperationStore;
  readonly #journals: JournalStore;
  readonly #idempotency: IdempotencyStore;

  readonly #controllers = new Map<string, AbortController>();
  readonly #pending = new Set<Promise<void>>();
  #closed = false;

  constructor(options: EnvironmentServiceOptions) {
    this.#layout = resolveLayout(options.dataRoot);
    ensureLayout(this.#layout);
    this.#catalog = [...options.catalog];
    this.#runtime = options.runtime;
    this.#host = options.host ?? { platform: 'darwin', arch: 'arm64' };
    this.#clock = options.clock ?? (() => new Date());
    this.#faults = options.faults ?? {};
    this.#process = options.process;
    this.#exportDiagnostics = options.exportDiagnostics;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 60_000;
    this.#allowArtifactsOnly = options.allowArtifactsOnly ?? false;
    this.#environments = new EnvironmentStore(this.#layout);
    this.#operations = new OperationStore(this.#layout);
    this.#journals = new JournalStore(this.#layout);
    this.#idempotency = new IdempotencyStore(this.#layout);
  }

  get layout(): AppDataLayout {
    return this.#layout;
  }

  get host(): HostPlatform {
    return this.#host;
  }

  get processPort(): ProcessLifecyclePort | undefined {
    return this.#process;
  }

  get exporter(): DiagnosticsExporter | undefined {
    return this.#exportDiagnostics;
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  readIdempotency(requestId: string) {
    return this.#idempotency.read(requestId);
  }

  writeIdempotency(requestId: string, record: Parameters<IdempotencyStore['write']>[1]): void {
    this.#idempotency.write(requestId, record);
  }

  listCatalog(): PortOutcome<readonly RuntimeCombination[]> {
    return portOk(this.#catalog);
  }

  findCombination(combinationId: string): PortOutcome<RuntimeCombination> {
    const combination = this.#catalog.find((entry) => entry.id === combinationId);
    return combination === undefined
      ? notFound('catalog combination was not found')
      : portOk(combination);
  }

  listEnvironments(): PortOutcome<readonly EnvironmentSummary[]> {
    return portOk(this.#environments.list().map(toEnvironmentSummary));
  }

  findEnvironment(environmentId: string): PortOutcome<EnvironmentSummary> {
    const record = this.#environments.read(environmentId);
    return record === undefined
      ? notFound('environment was not found')
      : portOk(toEnvironmentSummary(record));
  }

  findOperation(operationId: string): PortOutcome<OperationSnapshot> {
    const record = this.#operations.read(operationId);
    return record === undefined
      ? notFound('operation was not found')
      : portOk(toOperationSnapshot(record));
  }

  /**
   * Reads the install manifest of an environment's active generation.
   *
   * Returns the manifest directly (the shape QA/T006 observe); use
   * {@link EnvironmentService.tryReadInstallManifest} for a non-throwing
   * `PortOutcome`.
   */
  readInstallManifest(
    environmentId: string,
    options: { readonly generationId?: string } = {},
  ): InstallManifest {
    const outcome = this.tryReadInstallManifest(environmentId, options);
    if (!outcome.ok) {
      throw new ManagedInstallError(outcome.code, outcome.message);
    }
    return outcome.value;
  }

tryReadInstallManifest(
    environmentId: string,
    options: { readonly generationId?: string } = {},
  ): PortOutcome<InstallManifest> {
    const environment = this.#environments.read(environmentId);
    if (environment === undefined) {
      return notFound('environment was not found');
    }
    const generationId = options.generationId ?? environment.activeGenerationId;
    if (generationId === null) {
      return notFound('environment has no active generation');
    }
    const manifest = readJsonFile<InstallManifest>(
      generationPaths(this.#layout, environmentId, generationId).manifestPath,
    );
    return manifest === undefined
      ? notFound('no managed install manifest is recorded for this generation')
      : portOk(manifest);
  }

  /**
   * Starts a creation. Returns as soon as the environment, journal and
   * operation exist on disk; the install itself continues asynchronously.
   */
  createEnvironment(command: CreateEnvironmentCommand): PortOutcome<OperationRef> {
    if (this.#closed) {
      return portFail('INTERNAL_ERROR', 'the environment service is closed');
    }
    const resolved = this.#runtime.resolveComposition(command.combination);
    if (!resolved.ok) {
      return portFail(resolved.code, resolved.message);
    }
    const lock = resolved.value;
    if (!this.#lockMatchesCombination(lock, command.combination)) {
      return portFail('INTERNAL_ERROR', 'catalog produced a composition lock that does not match the combination');
    }
    const digest = this.#runtime.compositionDigest(lock);
    const createdAt = this.#now();
    const environmentId = newEnvironmentId();
    const generationId = newGenerationId();
    const operationId = newOperationId();
    const transactionId = newTransactionId();

    const environment: EnvironmentRecord = {
      schemaVersion: '1',
      id: environmentId,
      name: command.name,
      revision: 0,
      stateVersion: 1,
      state: 'creating',
      activeGenerationId: null,
      compositionDigest: null,
      createdAt,
      updatedAt: createdAt,
    };
    this.#environments.write(environment);
    this.#operations.create({
      id: operationId,
      kind: 'create',
      environmentId,
      phase: 'queued',
      createdAt,
    });
    const journal: CreateJournalRecord = {
      schemaVersion: '1',
      transactionId,
      requestId: command.requestId,
      operationId,
      environmentId,
      generationId,
      compositionDigest: digest,
      lock,
      phase: 'prepared',
      createdAt,
      updatedAt: createdAt,
    };
    this.#journals.write(journal);

    const job: CreateJob = {
      requestId: command.requestId,
      operationId,
      environmentId,
      generationId,
      transactionId,
      name: command.name,
      digest,
      lock,
      createdAt,
      journal,
    };
    this.#track(this.#runCreate(job));
    return portOk({ operationId });
  }

  cancelOperation(operationId: string): PortOutcome<OperationSnapshot> {
    const record = this.#operations.read(operationId);
    if (record === undefined) {
      return notFound('operation was not found');
    }
    if (isTerminalStatus(record.status)) {
      return portFail('CANNOT_CANCEL', 'operation already reached a final state');
    }
    this.#controllers.get(operationId)?.abort();
    const updated = this.#operations.update(record, { status: 'cancelled', phase: 'cancelled' }, this.#now());
    return portOk(toOperationSnapshot(updated));
  }

  /**
   * Reconciles transactions left behind by a previous process.
   *
   * Call this once after constructing the service and before starting new work.
   */
  recover(): RecoveryReport {
    const details: RecoveryDetail[] = [];
    const journals = this.#journals.list();
    const journalOperations = new Set(journals.map((journal) => journal.operationId));

    for (const journal of journals) {
      // Never roll back a transaction this process is still running; recovery
      // is a post-restart entry point and must not delete live staging.
      if (this.#controllers.has(journal.operationId)) {
        continue;
      }
      const environment = this.#environments.read(journal.environmentId);
      if (environment !== undefined && environment.activeGenerationId === journal.generationId) {
        this.#finalizeCommitted(journal);
        details.push({
          transactionId: journal.transactionId,
          environmentId: journal.environmentId,
          operationId: journal.operationId,
          generationId: journal.generationId,
          resolution: 'finalized',
        });
        continue;
      }
      this.#rollBack(journal, 'INTERNAL_ERROR', 'creation was interrupted before the generation was committed');
      details.push({
        transactionId: journal.transactionId,
        environmentId: journal.environmentId,
        operationId: journal.operationId,
        generationId: journal.generationId,
        resolution: 'rolled-back',
      });
    }

    for (const operation of this.#operations.list()) {
      if (isTerminalStatus(operation.status) || this.#controllers.has(operation.id)) {
        continue;
      }
      if (journalOperations.has(operation.id)) {
        continue;
      }
      this.#operations.update(
        operation,
        {
          status: 'failed',
          phase: 'failed',
          error: contractError('INTERNAL_ERROR', 'operation was interrupted and no journal was found', {
            operationId: operation.id,
          }),
        },
        this.#now(),
      );
      this.#markEnvironmentError(operation.environmentId);
      details.push({
        transactionId: null,
        environmentId: operation.environmentId,
        operationId: operation.id,
        generationId: null,
        resolution: 'failed',
      });
    }

    // Extremely narrow crash window: the environment record was written but the
    // journal/operation were not. No scan above would ever see it, so the
    // environment would stay `creating` forever. Fail it explicitly.
    const journalEnvironments = new Set(journals.map((journal) => journal.environmentId));
    for (const environment of this.#environments.list()) {
      if (environment.state !== 'creating' || journalEnvironments.has(environment.id)) {
        continue;
      }
      // A live in-process operation keeps the environment legitimately creating.
      const live = this.#operations
        .list()
        .some((operation) => operation.environmentId === environment.id && !isTerminalStatus(operation.status));
      if (live) {
        continue;
      }
      this.#markEnvironmentError(environment.id);
      details.push({
        transactionId: null,
        environmentId: environment.id,
        operationId: null,
        generationId: null,
        resolution: 'failed',
      });
    }

    return {
      reconciled: details.length,
      finalized: details.filter((detail) => detail.resolution === 'finalized').length,
      rolledBack: details.filter((detail) => detail.resolution !== 'finalized').length,
      details,
    };
  }

  /** Resolves with the operation's terminal snapshot; rejects on timeout. */
  async waitForOperation(
    operationId: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<OperationSnapshot> {
    const timeoutMs = options.timeoutMs ?? this.#operationTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = this.#operations.read(operationId);
      if (record === undefined) {
        throw new Error(`operation ${operationId} was not found`);
      }
      if (isTerminalStatus(record.status)) {
        return toOperationSnapshot(record);
      }
      if (Date.now() >= deadline) {
        throw new Error(`operation ${operationId} did not reach a terminal state within ${String(timeoutMs)}ms`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.#pending]);
  }

  #track(promise: Promise<void>): void {
    this.#pending.add(promise);
    void promise.finally(() => {
      this.#pending.delete(promise);
    });
  }

  #lockMatchesCombination(lock: CompositionLock, combination: RuntimeCombination): boolean {
    return (
      lock.node.version === combination.node.version &&
      lock.node.platform === combination.platform &&
      lock.node.arch === combination.arch &&
      lock.node.sha256 === combination.node.sha256 &&
      lock.dsh.version === combination.dsh.version &&
      lock.dsh.platform === combination.platform &&
      lock.dsh.arch === combination.arch &&
      lock.dsh.sha256 === combination.dsh.sha256 &&
      lock.sources.node.sha256 === combination.artifactLocations.node.sha256 &&
      lock.sources.dsh.sha256 === combination.artifactLocations.dsh.sha256
    );
  }

  async #runCreate(job: CreateJob): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(job.operationId, controller);
    const paths = generationPaths(this.#layout, job.environmentId, job.generationId);
    try {
      const queued = this.#operations.read(job.operationId);
      if (queued !== undefined && !isTerminalStatus(queued.status)) {
        this.#operations.update(queued, { status: 'running', phase: 'downloading' }, this.#now());
      }
      ensureDirectory(paths.generationDirectory);
      const context: InstallContext = {
        signal: controller.signal,
        cacheDirectory: this.#layout.artifacts,
        scratchDirectory: this.#layout.tmp,
        npmCacheDirectory: this.#layout.npmCache,
        onProgress: (update) => {
          const current = this.#operations.read(job.operationId);
          if (current === undefined || isTerminalStatus(current.status)) {
            return;
          }
          this.#operations.update(
            current,
            {
              phase: update.phase,
              ...(update.progress === undefined ? {} : { progress: update.progress }),
            },
            this.#now(),
          );
        },
      };
      const installed = await this.#runtime.install(job.lock, paths.generationDirectory, context);
      if (!installed.ok) {
        this.#fail(job, installed.code, installed.message);
        return;
      }
      this.#journals.write({ ...job.journal, phase: 'artifacts-installed', updatedAt: this.#now() });
      if (this.#faults.failBeforeCommit === true) {
        this.#fail(job, 'INTERNAL_ERROR', 'creation aborted before commit (injected fault)');
        return;
      }
      if (this.#faults.pauseBeforeCommit === true) {
        return;
      }
      this.#commit(job, paths.manifestPath);
    } catch (error) {
      const code: ErrorCode = controller.signal.aborted
        ? 'INTERNAL_ERROR'
        : isSpaceError(error)
          ? 'DISK_FULL'
          : errorCodeFrom(error) ?? 'INTERNAL_ERROR';
      this.#fail(job, code, error instanceof Error ? error.message : 'creation failed');
    } finally {
      this.#controllers.delete(job.operationId);
    }
  }

  #commit(job: CreateJob, manifestPath: string): void {
    const manifest = readJsonFile<InstallManifest>(manifestPath);
    if (manifest === undefined) {
      this.#fail(job, 'INTERNAL_ERROR', 'managed install did not produce an install manifest');
      return;
    }
    if (manifest.installMode !== 'npm-ci' && !this.#allowArtifactsOnly) {
      this.#fail(
        job,
        'INTERNAL_ERROR',
        'managed install is incomplete (dependency closure or preflight missing)',
      );
      return;
    }
    if (manifest.installMode === 'npm-ci' && !manifest.preflight.passed) {
      this.#fail(job, 'INTERNAL_ERROR', 'managed install preflight did not pass');
      return;
    }
    // Defence in depth (review P3-1): the manifest is written by the same
    // process, but the commit must still prove it describes *this* composition.
    const manifestBindsComposition =
      manifest.compositionDigest === job.digest &&
      manifest.node.sha256 === job.lock.node.sha256 &&
      manifest.dsh.sha256 === job.lock.dsh.sha256 &&
      manifest.node.version === job.lock.node.version &&
      manifest.dsh.version === job.lock.dsh.version &&
      (manifest.installMode !== 'npm-ci' || manifest.closure?.installed === true);
    if (!manifestBindsComposition || !(manifest.preflight.passed === true || manifest.preflight.skipped === true)) {
      this.#fail(job, 'INTERNAL_ERROR', 'the install manifest does not match the requested composition');
      return;
    }
    const paths = generationPaths(this.#layout, job.environmentId, job.generationId);
    ensureDirectory(paths.configDirectory);
    ensureDirectory(paths.dataDirectory);
    ensureDirectory(paths.homeDirectory);
    writeJsonAtomic(paths.lockPath, job.lock);
    writeJsonAtomic(paths.generationRecordPath, {
      id: job.generationId,
      environmentId: job.environmentId,
      compositionDigest: job.digest,
      createdAt: job.createdAt,
    });

    const environment = this.#environments.read(job.environmentId);
    if (environment !== undefined) {
      this.#environments.write({
        ...environment,
        state: 'stopped',
        stateVersion: environment.stateVersion + 1,
        revision: environment.revision + 1,
        activeGenerationId: job.generationId,
        compositionDigest: job.digest,
        updatedAt: this.#now(),
      });
    }

    const operation = this.#operations.read(job.operationId);
    if (operation !== undefined && !isTerminalStatus(operation.status)) {
      this.#operations.update(operation, { status: 'succeeded', phase: 'finished' }, this.#now());
    }
    this.#journals.write({ ...job.journal, phase: 'committed', updatedAt: this.#now() });
    this.#journals.remove(job.transactionId);
  }

  /** Terminal failure for a live transaction: fail, mark `error`, drop staging. */
  #fail(job: CreateJob, code: ErrorCode, message: string): void {
    const operation = this.#operations.read(job.operationId);
    if (operation !== undefined && !isTerminalStatus(operation.status)) {
      this.#operations.update(
        operation,
        { status: 'failed', phase: 'failed', error: contractError(code, message, { operationId: job.operationId }) },
        this.#now(),
      );
    }
    this.#markEnvironmentError(job.environmentId);
    removePath(generationPaths(this.#layout, job.environmentId, job.generationId).generationDirectory);
    this.#journals.remove(job.transactionId);
  }

  #markEnvironmentError(environmentId: string | null): void {
    if (environmentId === null) {
      return;
    }
    const environment = this.#environments.read(environmentId);
    if (environment === undefined) {
      return;
    }
    this.#environments.write({
      ...environment,
      state: 'error',
      stateVersion: environment.stateVersion + 1,
      activeGenerationId: null,
      compositionDigest: null,
      updatedAt: this.#now(),
    });
  }

  /** Reconciles a journal whose generation pointer is already live. */
  #finalizeCommitted(journal: CreateJournalRecord): void {
    const operation = this.#operations.read(journal.operationId);
    if (operation !== undefined && !isTerminalStatus(operation.status)) {
      this.#operations.update(operation, { status: 'succeeded', phase: 'finished' }, this.#now());
    }
    this.#journals.remove(journal.transactionId);
  }

  /** Reconciles an uncommitted journal from a crashed process. */
  #rollBack(journal: CreateJournalRecord, code: ErrorCode, message: string): void {
    const operation = this.#operations.read(journal.operationId);
    if (operation !== undefined && !isTerminalStatus(operation.status)) {
      this.#operations.update(
        operation,
        { status: 'failed', phase: 'failed', error: contractError(code, message, { operationId: journal.operationId }) },
        this.#now(),
      );
    }
    this.#markEnvironmentError(journal.environmentId);
    removePath(generationPaths(this.#layout, journal.environmentId, journal.generationId).generationDirectory);
    const ledger = this.#idempotency.read(journal.requestId);
    if (ledger !== undefined && ledger.state === 'in-progress') {
      this.#idempotency.write(journal.requestId, {
        state: 'completed',
        method: ledger.method,
        fingerprint: ledger.fingerprint,
        outcome: { ok: true, value: { operationId: journal.operationId } },
      });
    }
    this.#journals.remove(journal.transactionId);
  }
}

export const isOperationTerminal = (record: OperationRecord): boolean =>
  isTerminalStatus(record.status);
