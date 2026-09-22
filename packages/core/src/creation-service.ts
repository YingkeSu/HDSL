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
  type EnvironmentState,
  type EnvironmentSummary,
  type HostPlatform,
  type OperationRef,
  type OperationSnapshot,
  type OpenWebUIResult,
  type PortOutcome,
  type RevisionCommand,
  type RuntimeCombination,
} from '@hdsl/contracts';
import { join } from 'node:path';
import {
  ensureDirectory,
  isSpaceError,
  readJsonFile,
  removePath,
  tryReadJsonFile,
  writeJsonAtomic,
} from './fsx.js';
import { newEnvironmentId, newGenerationId, newOperationId, newTransactionId } from './ids.js';
import {
  generationPaths,
  ensureLayout,
  resolveLayout,
  type AppDataLayout,
  type GenerationPaths,
} from './layout.js';
import { migrateEnvironmentHome } from './home-migration.js';
import {
  CredentialStore,
  type CredentialBinding,
  type LaunchCredentialRequest,
} from './credential-store.js';
import {
  DataRootLock,
  type DataRootLockSnapshot,
} from './data-root-lock.js';
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
  type OperationUpdate,
} from './operation-store.js';
import { JournalStore, type CreateJournalRecord } from './journal.js';
import { IdempotencyStore } from './idempotency-store.js';
import type {
  DiagnosticsExporter,
  InstallContext,
  InstallManifest,
  ManagedProcessExit,
  ManagedProcessPhase,
  ManagedProcessPort,
  ManagedRuntimePort,
  ProcessLifecycleRequest,
  ProcessRecoveryEntry,
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
  readonly process?: ManagedProcessPort;
  readonly exportDiagnostics?: DiagnosticsExporter;
  readonly operationTimeoutMs?: number;
  /** Data-root lock configuration; a caller normally lets core create it. */
  readonly lock?: DataRootLock;
  /** Bounded wait for the exclusive data-root lease. Default 5 000 ms. */
  readonly lockWaitTimeoutMs?: number;
  readonly lockPollIntervalMs?: number;
  readonly lockHeartbeatIntervalMs?: number;
  readonly lockStaleAfterMs?: number;
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
  /** True when the caller does not hold the data-root lease and nothing ran. */
  readonly refused?: boolean;
  /** Bounded, secret-free reason for a refusal. */
  readonly reason?: string;
  /** What the injected managed-process module reconciled, when present. */
  readonly process?: readonly ProcessRecoveryEntry[];
}

/**
 * Outcome of {@link EnvironmentService.close}. `released` is false whenever the
 * process module could not prove it stopped every owned process tree or the
 * data-root lease could not be confirmed removed; the caller must then treat
 * the data root as still owned by this (dying) instance.
 */
export interface CloseFailure {
  readonly code: ErrorCode;
  readonly message: string;
}

export interface CloseReport {
  readonly released: boolean;
  /**
   * Managed-process (start/stop) operations that were still in flight when
   * close began. Core cannot observe the runtime's OS process count; the
   * runtime owns the actual number of process trees it stopped.
   */
  readonly stoppedProcesses: number;
  readonly failure?: CloseFailure;
}

/** Trusted, internal command to replace an environment's credential bindings. */
export interface SetEnvironmentCredentialsCommand {
  readonly environmentId: string;
  readonly bindings: readonly CredentialBinding[];
  /** Guards the environment composition revision, like other mutations. */
  readonly expectedRevision?: number;
}

export interface ClearEnvironmentCredentialsCommand {
  readonly environmentId: string;
  readonly expectedRevision?: number;
}

interface GenerationView {
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly generationId: string;
  readonly directory: string;
  readonly homeDirectory: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly nodeExecutable: string;
  readonly dshEntrypoint: string;
  readonly installMode: 'npm-ci' | 'artifacts-only';
  readonly compositionDigest: string;
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

const NOT_IMPLEMENTED = 'this capability is owned by the managed-process slice (T005)';

const PROCESS_PHASES: ReadonlySet<ManagedProcessPhase> = new Set<ManagedProcessPhase>([
  'spawning',
  'waiting-ready',
  'running',
  'stopping',
]);

export class EnvironmentService {
  readonly #layout: AppDataLayout;
  readonly #catalog: readonly RuntimeCombination[];
  readonly #runtime: ManagedRuntimePort;
  readonly #host: HostPlatform;
  readonly #clock: () => Date;
  readonly #faults: CreationFaults;
  #process: ManagedProcessPort | undefined;
  readonly #exportDiagnostics: DiagnosticsExporter | undefined;
  readonly #operationTimeoutMs: number;
  readonly #allowArtifactsOnly: boolean;
  readonly #lock: DataRootLock;
  readonly #lockWaitTimeoutMs: number;
  readonly #lockPollIntervalMs: number;

  readonly #environments: EnvironmentStore;
  readonly #operations: OperationStore;
  readonly #journals: JournalStore;
  readonly #idempotency: IdempotencyStore;
  readonly #credentials: CredentialStore;

  readonly #controllers = new Map<string, AbortController>();
  readonly #pending = new Set<Promise<void>>();
  #closed = false;
  #closePromise: Promise<CloseReport> | undefined;

  constructor(options: EnvironmentServiceOptions) {
    this.#layout = resolveLayout(options.dataRoot);
    this.#catalog = [...options.catalog];
    this.#runtime = options.runtime;
    this.#host = options.host ?? { platform: 'darwin', arch: 'arm64' };
    this.#clock = options.clock ?? (() => new Date());
    this.#faults = options.faults ?? {};
    this.#process = options.process;
    this.#exportDiagnostics = options.exportDiagnostics;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 60_000;
    this.#allowArtifactsOnly = options.allowArtifactsOnly ?? false;
    this.#lockWaitTimeoutMs = options.lockWaitTimeoutMs ?? 5_000;
    this.#lockPollIntervalMs = options.lockPollIntervalMs ?? 50;
    this.#lock =
      options.lock ??
      new DataRootLock({
        dataRoot: this.#layout.root,
        clock: this.#clock,
        ...(options.lockHeartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: options.lockHeartbeatIntervalMs }),
        ...(options.lockStaleAfterMs === undefined ? {} : { staleAfterMs: options.lockStaleAfterMs }),
      });
    // Best-effort fast path so a free data root is available synchronously;
    // open() performs the bounded acquisition and only then writes the layout.
    this.#lock.tryAcquire();
    this.#environments = new EnvironmentStore(this.#layout);
    this.#operations = new OperationStore(this.#layout);
    this.#journals = new JournalStore(this.#layout);
    this.#idempotency = new IdempotencyStore(this.#layout);
    this.#credentials = new CredentialStore(this.#layout);
  }

  /**
   * Bounded acquisition of the exclusive data-root lease. When it returns
   * `false` the instance is intentionally *unavailable*: reads still work and
   * every mutating call fails with `ENVIRONMENT_BUSY`. No layout is written.
   */
  async open(): Promise<boolean> {
    if (this.#lock.held) {
      ensureLayout(this.#layout);
      return true;
    }
    const acquired = await this.#lock.acquire({
      waitTimeoutMs: this.#lockWaitTimeoutMs,
      pollIntervalMs: this.#lockPollIntervalMs,
    });
    if (acquired) {
      ensureLayout(this.#layout);
    }
    return acquired;
  }

  get layout(): AppDataLayout {
    return this.#layout;
  }

  get host(): HostPlatform {
    return this.#host;
  }

  get processPort(): ManagedProcessPort | undefined {
    return this.#process;
  }

  get exporter(): DiagnosticsExporter | undefined {
    return this.#exportDiagnostics;
  }

  /** True when this instance holds the exclusive data-root lease. */
  get available(): boolean {
    return this.#lock.held;
  }

  /** Queryable lock owner identity / ABA credential / refusal reasons (QA). */
  lockSnapshot(): DataRootLockSnapshot {
    return this.#lock.snapshot();
  }

  /** Wires the managed-process module once the composition root built it. */
  attachProcess(port: ManagedProcessPort): void {
    this.#process = port;
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #assertLock(): void {
    // Fail closed before any durable write. A live holder is never taken over,
    // so this is defence in depth against a lease that was lost abnormally.
    this.#lock.assertHeld();
  }

  /** Non-throwing form for entry points that return a `PortOutcome`. */
  #tryAssertLock(): boolean {
    try {
      this.#assertLock();
      return true;
    } catch {
      return false;
    }
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
   * Runs (or resumes) the ADR 0006 home migration for one environment before any
   * runtime-affecting operation. Idempotent; refuses while the environment is
   * running or changing so the shared home is never mutated under a live process.
   * A new/empty environment finalizes immediately without touching anything.
   */
  ensureHomeMigrated(environmentId: string): PortOutcome<void> {
    if (!this.#tryAssertLock()) {
      return portFail('ENVIRONMENT_BUSY', 'the data root is locked by another instance');
    }
    const environment = this.#environments.read(environmentId);
    if (environment === undefined) {
      return notFound('environment was not found');
    }
    if (
      environment.state === 'starting' ||
      environment.state === 'running' ||
      environment.state === 'stopping'
    ) {
      return portFail('ENVIRONMENT_BUSY', 'the environment is running or changing');
    }
    try {
      const result = migrateEnvironmentHome({
        layout: this.#layout,
        environmentId,
        activeGenerationId: environment.activeGenerationId,
        clock: this.#clock,
      });
      return result.state === 'interrupted'
        ? portFail('INTERNAL_ERROR', 'home migration was interrupted')
        : portOk(undefined);
    } catch (error) {
      return portFail(
        errorCodeFrom(error) ?? 'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'home migration failed',
      );
    }
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
    // Re-read the published lease before the first durable write, not just the
    // cached `held` flag, so an abnormally lost lease cannot write new records.
    if (!this.#tryAssertLock()) {
      return portFail('ENVIRONMENT_BUSY', 'the data root is locked by another instance');
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

  /**
   * Starts a managed process. Core owns the operation, the environment state
   * and the revision/state guards; the injected process port performs the
   * actual spawn and readiness wait.
   */
  startEnvironment(command: RevisionCommand): PortOutcome<OperationRef> {
    return this.#beginProcessOperation('start', command);
  }

  stopEnvironment(command: RevisionCommand): PortOutcome<OperationRef> {
    return this.#beginProcessOperation('stop', command);
  }

  /**
   * Trusted, internal API: replaces an environment's credential bindings.
   *
   * Guards: the service is open, this instance holds the data-root lease, the
   * environment exists, is not running/changing and (when supplied) matches
   * `expectedRevision`. The record only holds references; a secret value is
   * never accepted or persisted.
   */
  writeEnvironmentCredentials(
    command: SetEnvironmentCredentialsCommand,
  ): PortOutcome<{ readonly revision: number }> {
    const guard = this.#guardCredentialMutation(command.environmentId, command.expectedRevision);
    if (guard !== undefined) {
      return guard;
    }
    const current = this.#credentials.read(command.environmentId);
    const previousRevision = current.kind === 'valid' ? current.record.revision : 0;
    try {
      const record = this.#credentials.write(
        command.environmentId,
        command.bindings,
        previousRevision,
        this.#now(),
      );
      return portOk({ revision: record.revision });
    } catch (error) {
      return portFail(
        'INVALID_INPUT',
        error instanceof Error ? error.message : 'the credential binding is invalid',
      );
    }
  }

  /** Trusted, internal API: removes an environment's credential bindings. */
  clearEnvironmentCredentials(command: ClearEnvironmentCredentialsCommand): PortOutcome<void> {
    const guard = this.#guardCredentialMutation(command.environmentId, command.expectedRevision);
    if (guard !== undefined) {
      return guard;
    }
    this.#credentials.clear(command.environmentId);
    return portOk(undefined);
  }

  #guardCredentialMutation(
    environmentId: string,
    expectedRevision: number | undefined,
  ): PortOutcome<never> | undefined {
    if (this.#closed) {
      return portFail('INTERNAL_ERROR', 'the environment service is closed');
    }
    if (!this.#tryAssertLock()) {
      return portFail('ENVIRONMENT_BUSY', 'the data root is locked by another instance');
    }
    const environment = this.#environments.read(environmentId);
    if (environment === undefined) {
      return notFound('environment was not found');
    }
    if (
      environment.state === 'starting' ||
      environment.state === 'running' ||
      environment.state === 'stopping'
    ) {
      return portFail('ENVIRONMENT_BUSY', 'the environment is running or changing');
    }
    if (expectedRevision !== undefined && environment.revision !== expectedRevision) {
      return portFail(
        'REVISION_CONFLICT',
        'expectedRevision does not match the current composition revision',
      );
    }
    return undefined;
  }

  /**
   * The `@hdsl/runtime` `LaunchCredentialLoader` implementation.
   *
   * Reads the environment's stored reference bindings and builds an explicit
   * base environment from the trusted generation paths. It rejects (fail
   * closed) when the environment, its generation or its credential record is
   * missing or corrupt, and never inherits the host `process.env`. The
   * authoritative keychain/`service#account` enforcement stays in the runtime
   * credential port.
   */
  async launchCredentialRequest(environmentId: string): Promise<LaunchCredentialRequest> {
    const environment = this.#environments.read(environmentId);
    if (environment === undefined) {
      throw new Error('environment was not found');
    }
    if (environment.activeGenerationId === null) {
      throw new Error('environment has no active generation');
    }
    const record = this.#credentials.read(environmentId);
    if (record.kind === 'missing') {
      throw new Error('no credential binding is configured for this environment');
    }
    if (record.kind === 'invalid') {
      throw new Error(record.message);
    }
    const paths = generationPaths(this.#layout, environmentId, environment.activeGenerationId);
    return {
      bindings: record.record.bindings,
      baseEnv: this.#baseLaunchEnvironment(paths),
    };
  }

  #baseLaunchEnvironment(paths: GenerationPaths): Readonly<Record<string, string>> {
    const homeDirectory = paths.homeDirectory;
    const nodeBin = join(paths.generationDirectory, 'node', 'bin');
    return {
      HOME: homeDirectory,
      DSH_HOME: homeDirectory,
      DSH_AGENTS_HOME: join(homeDirectory, 'agents'),
      PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: join(homeDirectory, '.tmp'),
    };
  }

  openWebUI(environmentId: string): PortOutcome<OpenWebUIResult> {
    if (this.#closed) {
      return portFail('INTERNAL_ERROR', 'the environment service is closed');
    }
    if (this.#process === undefined) {
      return portFail('INTERNAL_ERROR', NOT_IMPLEMENTED);
    }
    return this.#process.openWebUI(environmentId);
  }

  /**
   * Runtime callback for a managed process that exited on its own. Marks the
   * environment stopped and fails any live start operation with
   * `PROCESS_EXITED`.
   */
  handleProcessExit(info: ManagedProcessExit): void {
    if (this.#closed || !this.#lock.held) {
      return;
    }
    try {
      this.#assertLock();
    } catch {
      return;
    }
    const environment = this.#environments.read(info.environmentId);
    if (environment !== undefined && (environment.state === 'running' || environment.state === 'starting')) {
      this.#setEnvironmentState(environment.id, 'stopped');
    }
    for (const operation of this.#operations.list()) {
      if (operation.environmentId !== info.environmentId || operation.kind !== 'start') {
        continue;
      }
      if (isTerminalStatus(operation.status) || this.#controllers.has(operation.id)) {
        continue;
      }
      this.#failOperation(operation.id, 'PROCESS_EXITED', 'the managed process exited unexpectedly');
    }
  }

  #beginProcessOperation(
    kind: 'start' | 'stop',
    command: RevisionCommand,
  ): PortOutcome<OperationRef> {
    if (this.#closed) {
      return portFail('INTERNAL_ERROR', 'the environment service is closed');
    }
    if (!this.#tryAssertLock()) {
      return portFail('ENVIRONMENT_BUSY', 'the data root is locked by another instance');
    }
    if (this.#process === undefined) {
      return portFail('INTERNAL_ERROR', NOT_IMPLEMENTED);
    }
    const environment = this.#environments.read(command.environmentId);
    if (environment === undefined) {
      return notFound('environment was not found');
    }
    if (environment.revision !== command.expectedRevision) {
      return portFail('REVISION_CONFLICT', 'expectedRevision does not match the current composition revision');
    }
    const startable = kind === 'start' ? environment.state === 'stopped' : environment.state === 'running' || environment.state === 'starting';
    if (!startable) {
      return portFail('ENVIRONMENT_BUSY', `the environment is not ${kind === 'start' ? 'stopped' : 'running'}`);
    }
    const generation = this.#generationFor(environment.id);
    if (generation === undefined) {
      return notFound('no installed generation is available for this environment');
    }
    // Migration mutates the shared home, so it is only run before a `start`
    // (never while running/stopping). `stop` must stay available at all times.
    if (kind === 'start') {
      const migration = this.ensureHomeMigrated(environment.id);
      if (!migration.ok) {
        return portFail(migration.code, migration.message);
      }
    }
    const operation = this.#operations.create({
      id: newOperationId(),
      kind,
      environmentId: environment.id,
      phase: 'queued',
      createdAt: this.#now(),
    });
    this.#setEnvironmentState(environment.id, kind === 'start' ? 'starting' : 'stopping');
    this.#track(this.#runProcessOperation(kind, operation.id, generation));
    return portOk({ operationId: operation.id });
  }

  async #runProcessOperation(
    kind: 'start' | 'stop',
    operationId: string,
    generation: GenerationView,
  ): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(operationId, controller);
    const environmentId = generation.environmentId;
    const request: ProcessLifecycleRequest = {
      environmentId,
      expectedRevision: generation.expectedRevision,
      generationDirectory: generation.directory,
      homeDirectory: generation.homeDirectory,
      configDirectory: generation.configDirectory,
      dataDirectory: generation.dataDirectory,
      nodeExecutable: generation.nodeExecutable,
      dshEntrypoint: generation.dshEntrypoint,
      installMode: generation.installMode,
      signal: controller.signal,
      onPhase: (phase, progress) => {
        this.#updateOperationPhase(operationId, phase, progress);
      },
    };
    const revertTo = kind === 'start' ? 'stopped' : 'running';
    try {
      this.#assertLock();
      this.#updateOperation(operationId, {
        status: 'running',
        phase: kind === 'start' ? 'spawning' : 'stopping',
      });
      const outcome =
        kind === 'start' ? await this.#process!.start(request) : await this.#process!.stop(request);
      if (controller.signal.aborted) {
        this.#setEnvironmentStateIf(environmentId, kind === 'start' ? 'starting' : 'stopping', revertTo);
        return;
      }
      if (!outcome.ok) {
        this.#failOperation(operationId, outcome.code, outcome.message);
        this.#setEnvironmentStateIf(environmentId, kind === 'start' ? 'starting' : 'stopping', revertTo);
        return;
      }
      this.#updateOperation(operationId, { status: 'succeeded', phase: 'finished' });
      this.#setEnvironmentState(environmentId, kind === 'start' ? 'running' : 'stopped');
    } catch (error) {
      if (controller.signal.aborted) {
        this.#setEnvironmentStateIf(environmentId, kind === 'start' ? 'starting' : 'stopping', revertTo);
        return;
      }
      this.#failOperation(
        operationId,
        errorCodeFrom(error) ?? 'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'the managed process operation failed',
      );
      this.#setEnvironmentStateIf(environmentId, kind === 'start' ? 'starting' : 'stopping', revertTo);
    } finally {
      this.#controllers.delete(operationId);
    }
  }

  #generationFor(environmentId: string): GenerationView | undefined {
    const environment = this.#environments.read(environmentId);
    if (environment === undefined || environment.activeGenerationId === null) {
      return undefined;
    }
    const paths = generationPaths(this.#layout, environmentId, environment.activeGenerationId);
    const manifest = tryReadJsonFile<InstallManifest>(paths.manifestPath);
    if (manifest === undefined) {
      return undefined;
    }
    return {
      environmentId,
      expectedRevision: environment.revision,
      generationId: environment.activeGenerationId,
      directory: paths.generationDirectory,
      homeDirectory: paths.homeDirectory,
      configDirectory: paths.configDirectory,
      dataDirectory: paths.dataDirectory,
      nodeExecutable: join(paths.generationDirectory, manifest.node.executable),
      dshEntrypoint: join(paths.generationDirectory, manifest.dsh.entrypoint),
      installMode: manifest.installMode,
      compositionDigest: environment.compositionDigest ?? manifest.compositionDigest,
    };
  }

  #updateOperation(operationId: string, update: OperationUpdate): void {
    if (!this.#lock.held) {
      return;
    }
    const record = this.#operations.read(operationId);
    if (record === undefined || isTerminalStatus(record.status)) {
      return;
    }
    this.#operations.update(record, update, this.#now());
  }

  #updateOperationPhase(operationId: string, phase: ManagedProcessPhase, progress?: number): void {
    if (!PROCESS_PHASES.has(phase)) {
      return;
    }
    this.#updateOperation(operationId, {
      phase,
      ...(progress === undefined ? {} : { progress }),
    });
  }

  #failOperation(operationId: string, code: ErrorCode, message: string): void {
    this.#updateOperation(operationId, {
      status: 'failed',
      phase: 'failed',
      error: contractError(code, message, { operationId }),
    });
  }

  #setEnvironmentState(environmentId: string, state: EnvironmentState): void {
    if (!this.#lock.held) {
      return;
    }
    const environment = this.#environments.read(environmentId);
    if (environment === undefined || environment.state === state) {
      return;
    }
    this.#environments.write({
      ...environment,
      state,
      stateVersion: environment.stateVersion + 1,
      updatedAt: this.#now(),
    });
  }

  #setEnvironmentStateIf(environmentId: string, from: EnvironmentState, to: EnvironmentState): void {
    if (!this.#lock.held) {
      return;
    }
    const environment = this.#environments.read(environmentId);
    if (environment === undefined || environment.state !== from) {
      return;
    }
    this.#environments.write({
      ...environment,
      state: to,
      stateVersion: environment.stateVersion + 1,
      updatedAt: this.#now(),
    });
  }

  cancelOperation(operationId: string): PortOutcome<OperationSnapshot> {
    if (!this.#tryAssertLock()) {
      return portFail('ENVIRONMENT_BUSY', 'the data root is locked by another instance');
    }
    const record = this.#operations.read(operationId);
    if (record === undefined) {
      return notFound('operation was not found');
    }
    if (isTerminalStatus(record.status)) {
      return portFail('CANNOT_CANCEL', 'operation already reached a final state');
    }
    // Aborting the controller is the cancel signal: the runtime kills its
    // owned process tree, and the install job aborts before commit.
    this.#controllers.get(operationId)?.abort();
    const updated = this.#operations.update(record, { status: 'cancelled', phase: 'cancelled' }, this.#now());
    return portOk(toOperationSnapshot(updated));
  }

  /**
   * Reconciles transactions left behind by a previous process.
   *
   * Only the instance that holds the exclusive data-root lease may reconcile;
   * otherwise the call is refused without touching a single record, so a live
   * instance's in-flight transaction is never rolled back. When the injected
   * process module is present it is reconciled first (adopted -> `running`,
   * everything else -> `stopped`), then the create journals.
   */
  async recover(): Promise<RecoveryReport> {
    if (this.#closed) {
      return {
        reconciled: 0,
        finalized: 0,
        rolledBack: 0,
        details: [],
        refused: true,
        reason: 'the environment service is closed',
      };
    }
    if (!this.#lock.held) {
      await this.#lock.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 });
    }
    if (!this.#lock.held) {
      return {
        reconciled: 0,
        finalized: 0,
        rolledBack: 0,
        details: [],
        refused: true,
        reason: 'data-root-lock-held-by-another-instance',
      };
    }
    ensureLayout(this.#layout);
    const details: RecoveryDetail[] = [];
    // ADR 0006: bring every environment's shared home up to date before any
    // runtime-affecting operation. A failed migration is left for the next
    // start/recover to resume; it must not abort the whole reconciliation.
    for (const environment of this.#environments.list()) {
      try {
        migrateEnvironmentHome({
          layout: this.#layout,
          environmentId: environment.id,
          activeGenerationId: environment.activeGenerationId,
          clock: this.#clock,
        });
      } catch {
        // Retried on the next start/recover; the environment stays refused.
      }
    }
    const processEntries = await this.#recoverProcesses(details);
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
      if (operation.kind === 'start' || operation.kind === 'stop') {
        // Reconciled with the process module above; without one these cannot
        // have been created.
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
      process: processEntries,
    };
  }

  async #recoverProcesses(details: RecoveryDetail[]): Promise<readonly ProcessRecoveryEntry[]> {
    if (this.#process === undefined) {
      return [];
    }
    let entries: readonly ProcessRecoveryEntry[] = [];
    try {
      const report = await this.#process.recover();
      entries = report.entries;
    } catch {
      return [];
    }
    for (const entry of entries) {
      const environment = this.#environments.read(entry.environmentId);
      if (environment !== undefined) {
        this.#setEnvironmentState(
          environment.id,
          entry.resolution === 'adopted' ? 'running' : 'stopped',
        );
      }
    }
    for (const operation of this.#operations.list()) {
      if (operation.kind !== 'start' && operation.kind !== 'stop') {
        continue;
      }
      if (isTerminalStatus(operation.status) || this.#controllers.has(operation.id)) {
        continue;
      }
      this.#failOperation(operation.id, 'INTERNAL_ERROR', 'operation was interrupted by a restart');
      details.push({
        transactionId: null,
        environmentId: operation.environmentId,
        operationId: operation.id,
        generationId: null,
        resolution: 'failed',
      });
    }
    return entries;
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

  /**
   * Blocks new work, aborts and awaits every in-flight create/start/stop task,
   * asks the process module to stop every provably-owned process tree, and only
   * then releases the data-root lease. If the process module cannot prove a
   * clean shutdown, or the lease cannot be confirmed removed, the lock is kept
   * and `released` is false so the caller never treats the root as reusable.
   * Idempotent and safe to call concurrently.
   */
  async close(): Promise<CloseReport> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closePromise = this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<CloseReport> {
    this.#closed = true;
    // Count the managed-process operations that were still in flight when close
    // began; core cannot observe the runtime's OS process count.
    const stoppedProcesses = this.#operations.list().filter(
      (operation) =>
        (operation.kind === 'start' || operation.kind === 'stop') &&
        !isTerminalStatus(operation.status),
    ).length;
    for (const controller of this.#controllers.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.#pending]);
    let failure: CloseFailure | undefined;
    if (this.#process !== undefined) {
      try {
        const outcome = await this.#process.close();
        if (!outcome.ok) {
          failure = { code: outcome.code, message: outcome.message };
        }
      } catch (error) {
        failure = {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'the managed process module failed to close',
        };
      }
    }
    if (failure === undefined) {
      try {
        await this.#lock.release();
      } catch {
        // release() records its own result; inspect the snapshot below.
      }
      const snapshot = this.#lock.snapshot();
      const released = snapshot.publishedBy === 'none' && !this.#lock.held;
      if (!released) {
        failure = {
          code: 'INTERNAL_ERROR',
          message:
            snapshot.lastRelease?.reason ??
            'another instance still owns the data-root lease after close',
        };
      }
      const report: CloseReport = {
        released: failure === undefined,
        stoppedProcesses,
        ...(failure === undefined ? {} : { failure }),
      };
      return report;
    }
    return { released: false, stoppedProcesses, failure };
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
      this.#assertLock();
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
      this.#assertLock();
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
    if (!this.#tryAssertLock()) {
      // The lease was lost abnormally; do not write. The journal stays for the
      // next recover to reconcile.
      return;
    }
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
    if (!this.#tryAssertLock()) {
      return;
    }
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
