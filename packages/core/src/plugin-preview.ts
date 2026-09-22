/**
 * Core-owned `changes.preview` lifecycle (ADR 0005 D5/D6/D7/D8).
 *
 * The change preview is an environment-scoped, cancellable long-running
 * operation that returns an `OperationRef`; the terminal `ChangePlan` is read
 * ONLY from `OperationSnapshot.output` (D5). The injected {@link PluginPreviewPort}
 * performs the read-only resolution (exact commit SHA, manifest, dependency
 * closure, install-time script assessment, executor identity); core owns the
 * operation lifecycle and the durable plan store.
 *
 * Preview never changes the environment composition, the active-generation
 * pointer or any source lock (D6); it may write cache/journal/temp files.
 */
import {
  contractError,
  contractErrorForCode,
  portFail,
  portOk,
  type ChangePlan,
  type ChangePlanAction,
  type ContractError,
  type EnvironmentSummary,
  type ExecutorIdentity,
  type OperationRef,
  type OperationSnapshot,
  type BuildScriptEntry,
  type PluginSourceLock,
  type PluginSourceSelector,
  type PortOutcome,
  type ScriptAssessment,
} from '@hdsl/contracts';
import { join } from 'node:path';
import { newOperationId, newPlanId } from './ids.js';
import { generationPaths } from './layout.js';
import { writeTargetProfileCache } from './target-profile-cache.js';
import { ChangePlanStore } from './change-plan-store.js';
import {
  buildRemovalResolveInput,
  removalPlanInputsDigest,
  type PluginRemovalPort,
} from './plugin-removal.js';
import { isTerminalStatus, OperationStore, toOperationSnapshot } from './operation-store.js';
import { tryReadJsonFile } from './fsx.js';
import type { AppDataLayout } from './layout.js';

/** Read-only resolution of one plugin source into plan inputs. */
export interface PluginPreviewResolution {
  readonly sourceLock: PluginSourceLock;
  readonly scripts: readonly BuildScriptEntry[];
  readonly scriptAssessment: ScriptAssessment;
  readonly requiresBuildAuthorization: boolean;
  readonly riskItems: readonly string[];
  readonly executor: ExecutorIdentity | null;
  readonly planInputsDigest: string;
  /** Target profile lock resolved in isolation; `null` for a source-only preview. */
  readonly targetLockText: string | null;
  /** Target profile declaration; `null` for a source-only preview. */
  readonly targetDeclarationText: string | null;
  /** Workspace resolution config used for the target; `null` when absent. */
  readonly targetWorkspaceText: string | null;
  /** Target declaration digest; `null` for a source-only preview. */
  readonly targetDeclarationSha256: string | null;
}

/** Context for resolving the EXPECTED TARGET PROFILE in isolation. */
export interface PreviewSourceContext {
  /** Current generation's immutable declaration source directory. */
  readonly declarationDirectory: string;
  /** Isolated staging directory (never the environment home). */
  readonly stagingDirectory: string;
  /**
   * Managed Node executable of the current generation. It is REQUIRED: the
   * resolution child must run under the managed runtime, never the host process
   * binary (inside Electron, `process.execPath` is Electron and never exits).
   */
  readonly nodeExecutable: string;
}

/**
 * Read-only preview adapter (the GitHub adapter lives in `@hdsl/runtime`). It
 * never loads plugin code, never executes an install script and never receives a
 * GitHub credential (ADR 0005 D16/D17).
 */
export interface PluginPreviewPort {
  previewSource(
    source: PluginSourceSelector,
    signal: AbortSignal,
    context?: PreviewSourceContext,
  ): Promise<PortOutcome<PluginPreviewResolution>>;
}

export interface PreviewChangeCommand {
  readonly requestId: string;
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly action: ChangePlanAction;
}

export interface ChangePreviewServiceOptions {
  readonly layout: AppDataLayout;
  /**
   * Install/source preview adapter. Optional so a removal-only wiring (S3) can
   * still construct the service; an install preview without it is a controlled
   * `INTERNAL_ERROR`, never a fake plan.
   */
  readonly port?: PluginPreviewPort;
  /** Removal adapter (S3): required for `action.kind === 'remove'` previews. */
  readonly removalPort?: PluginRemovalPort;
  readonly findEnvironment: (environmentId: string) => EnvironmentSummary | undefined;
  readonly now?: () => Date;
  /** Plan validity window; default 15 minutes. */
  readonly ttlMs?: number;
}

export const CHANGE_PLAN_DEFAULT_TTL_MS = 15 * 60_000;

export class ChangePreviewService {
  readonly #layout: AppDataLayout;
  readonly #plans: ChangePlanStore;
  readonly #operations: OperationStore;
  readonly #port: PluginPreviewPort | undefined;
  readonly #removalPort: PluginRemovalPort | undefined;
  readonly #findEnvironment: (environmentId: string) => EnvironmentSummary | undefined;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: ChangePreviewServiceOptions) {
    this.#layout = options.layout;
    this.#plans = new ChangePlanStore(options.layout);
    this.#operations = new OperationStore(options.layout);
    this.#port = options.port;
    this.#removalPort = options.removalPort;
    this.#findEnvironment = options.findEnvironment;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? CHANGE_PLAN_DEFAULT_TTL_MS;
  }

  get plans(): ChangePlanStore {
    return this.#plans;
  }

  /**
   * Reconciliation for restart (P1 ownership dispatch): this service owns the
   * `preview` kind. A non-terminal preview operation left by a crash is a
   * READ-ONLY transaction, so it is terminated controllably here and the
   * environment record is never touched — no pointer, composition digest or
   * revision change. Live in-process operations are skipped.
   */
  recover(): { readonly terminated: number } {
    let terminated = 0;
    for (const record of this.#operations.list()) {
      if (record.kind !== 'preview' || isTerminalStatus(record.status) || this.#controllers.has(record.id)) {
        continue;
      }
      this.#operations.update(
        record,
        {
          status: 'failed',
          phase: 'failed',
          error: contractError('INTERNAL_ERROR', 'the preview was interrupted and did not complete', {
            operationId: record.id,
          }),
        },
        this.#now().toISOString(),
      );
      terminated += 1;
    }
    return { terminated };
  }

  /** True when this service owns the operation id. */
  owns(operationId: string): boolean {
    const record = this.#operations.read(operationId);
    return record !== undefined && record.kind === 'preview';
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

  /** Starts an async, cancellable preview. The plan is read from the terminal output. */
  previewChange(command: PreviewChangeCommand): PortOutcome<OperationRef> {
    const environment = this.#findEnvironment(command.environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    if (environment.revision !== command.expectedRevision) {
      return portFail('REVISION_CONFLICT', 'expectedRevision does not match the current composition revision');
    }
    if (command.action.kind !== 'install' && this.#removalPort === undefined) {
      // Removal has its own preview branch (S3). A valid remove request with no
      // wired removal adapter is a controlled internal failure, never a fake plan
      // and never a silent install-path fallback.
      return portFail('INTERNAL_ERROR', 'the removal preview adapter is not wired');
    }
    const operationId = newOperationId();
    const controller = new AbortController();
    this.#operations.create({
      id: operationId,
      kind: 'preview',
      environmentId: command.environmentId,
      phase: 'planning',
      status: 'running',
      createdAt: this.#now().toISOString(),
    });
    this.#controllers.set(operationId, controller);
    void this.#run(operationId, command, controller.signal);
    return portOk({ operationId });
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
    this.#controllers.delete(operationId);
    const cancelled = this.#operations.update(
      record,
      { status: 'cancelled', phase: 'cancelled' },
      this.#now().toISOString(),
    );
    return portOk(toOperationSnapshot(cancelled));
  }

  async #run(
    operationId: string,
    command: PreviewChangeCommand,
    signal: AbortSignal,
  ): Promise<void> {
    if (command.action.kind === 'remove') {
      await this.#runRemoval(operationId, command, signal);
      return;
    }
    // The target profile is resolved from the CURRENT generation's immutable
    // declaration source, in an isolated staging directory (never the env home).
    const environment = this.#findEnvironment(command.environmentId);
    const context: PreviewSourceContext | undefined =
      environment?.activeGenerationId == null
        ? undefined
        : {
            declarationDirectory: join(
              generationPaths(this.#layout, command.environmentId, environment.activeGenerationId).generationDirectory,
              'profile',
            ),
            stagingDirectory: join(this.#layout.tmp, `target-profile-${operationId}`),
            nodeExecutable: join(
              generationPaths(this.#layout, command.environmentId, environment.activeGenerationId).nodeDirectory,
              'bin',
              'node',
            ),
          };
    let outcome: PortOutcome<PluginPreviewResolution>;
    if (this.#port === undefined) {
      outcome = portFail('INTERNAL_ERROR', 'the change preview adapter is not wired');
    } else {
      try {
        outcome = await this.#port.previewSource(command.action.source, signal, context);
      } catch {
        outcome = portFail('INTERNAL_ERROR', 'the plugin preview source threw');
      }
    }
    this.#controllers.delete(operationId);
    const record = this.#operations.read(operationId);
    if (record === undefined || isTerminalStatus(record.status)) {
      return;
    }
    const now = this.#now();
    if (outcome.ok) {
      const resolution = outcome.value;
      const plan: ChangePlan = {
        planId: newPlanId(),
        environmentId: command.environmentId,
        baseRevision: command.expectedRevision,
        action: command.action,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
        sourceLock: resolution.sourceLock,
        scriptAssessment: resolution.scriptAssessment,
        scripts: [...resolution.scripts],
        requiresBuildAuthorization: resolution.requiresBuildAuthorization,
        riskItems: [...resolution.riskItems],
        removals: [],
        retention: [],
        blockingReferences: [],
        executor: resolution.executor,
        planInputsDigest: resolution.planInputsDigest,
      };
      // Cache the target profile bound to the plan, so apply can verify and use
      // it. A source-only resolution has nothing to cache.
      if (resolution.targetLockText !== null && resolution.targetDeclarationText !== null) {
        const cached = writeTargetProfileCache(this.#layout, plan.planId, {
          lockText: resolution.targetLockText,
          declarationText: resolution.targetDeclarationText,
          workspaceText: resolution.targetWorkspaceText,
        });
        if (!cached.ok) {
          this.#operations.update(record, { status: 'failed', phase: 'failed', error: contractErrorForCode(cached.code, {}) }, now.toISOString());
          return;
        }
      }
      this.#plans.write({ schemaVersion: '1', plan, consumedBy: null });
      this.#operations.update(
        record,
        { status: 'succeeded', phase: 'finished', output: plan },
        now.toISOString(),
      );
      return;
    }
    const error: ContractError = contractErrorForCode(
      outcome.code,
      outcome.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: outcome.retryAfterSeconds },
    );
    this.#operations.update(record, { status: 'failed', phase: 'failed', error }, now.toISOString());
  }

  /**
   * S3 remove preview: resolves removals/retention/blockers from the ACTIVE
   * generation (ADR 0005 D15/D21) and binds the pruned target profile to the plan
   * through the target-profile cache. Builtin targets fail closed; a blocked
   * resolution still produces a plan so the UI can explain it, but nothing is
   * cached and the plan is never applyable.
   */
  async #runRemoval(
    operationId: string,
    command: PreviewChangeCommand,
    signal: AbortSignal,
  ): Promise<void> {
    const fail = (code: Parameters<typeof contractErrorForCode>[0]): void => {
      const record = this.#operations.read(operationId);
      if (record !== undefined && !isTerminalStatus(record.status)) {
        this.#operations.update(record, { status: 'failed', phase: 'failed', error: contractErrorForCode(code, {}) }, this.#now().toISOString());
      }
      this.#controllers.delete(operationId);
    };
    if (command.action.kind !== 'remove') {
      return;
    }
    if (this.#removalPort === undefined) {
      fail('INTERNAL_ERROR');
      return;
    }
    const environment = this.#findEnvironment(command.environmentId);
    const built = buildRemovalResolveInput({
      layout: this.#layout,
      environment:
        environment === undefined
          ? undefined
          : { id: environment.id, activeGenerationId: environment.activeGenerationId },
      pluginId: command.action.pluginId,
      stagingKey: operationId,
      readJson: (path) => tryReadJsonFile<unknown>(path),
    });
    if (!built.ok) {
      fail(built.code);
      return;
    }

    let outcome;
    try {
      outcome = await this.#removalPort.resolveRemoval(built.value.resolve, signal);
    } catch {
      outcome = portFail('INTERNAL_ERROR', 'the removal resolution threw');
    }
    this.#controllers.delete(operationId);
    const record = this.#operations.read(operationId);
    if (record === undefined || isTerminalStatus(record.status)) {
      return;
    }
    const now = this.#now();
    if (!outcome.ok) {
      this.#operations.update(record, { status: 'failed', phase: 'failed', error: contractErrorForCode(outcome.code, {}) }, now.toISOString());
      return;
    }
    const resolution = outcome.value;
    // In-box bundle protection is a FAIL (no side effect, no plan), decided from
    // the resolved in-box identity rather than from the reference text.
    if (resolution.isBuiltin) {
      this.#operations.update(
        record,
        { status: 'failed', phase: 'failed', error: contractErrorForCode('BUILTIN_BUNDLE_PROTECTED', {}) },
        now.toISOString(),
      );
      return;
    }
    const plan: ChangePlan = {
      planId: newPlanId(),
      environmentId: command.environmentId,
      baseRevision: command.expectedRevision,
      action: command.action,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      sourceLock: null,
      scriptAssessment: 'none-detected',
      scripts: [],
      requiresBuildAuthorization: false,
      riskItems: [...resolution.riskItems],
      removals: [...resolution.removals],
      retention: [...resolution.retention],
      blockingReferences: [...resolution.blockingReferences],
      executor: null,
      planInputsDigest: removalPlanInputsDigest({
        declarationSha256: resolution.targetDeclarationSha256,
        pluginId: command.action.pluginId,
        expectedCommitSha: built.value.resolve.expectedCommitSha,
        expectedManifestSha256: built.value.resolve.expectedManifestSha256,
        runtime: built.value.resolve.runtime,
      }),
    };
    // A blocked removal still produces a plan so the UI can explain it, but it is
    // NOT cached and therefore NOT applyable. Only a clean resolution caches the
    // pruned target profile the plan binds.
    if (resolution.blockingReferences.length === 0) {
      const cached = writeTargetProfileCache(this.#layout, plan.planId, {
        lockText: resolution.targetLockText,
        declarationText: resolution.targetDeclarationText,
        workspaceText: resolution.targetWorkspaceText,
      });
      if (!cached.ok) {
        this.#operations.update(record, { status: 'failed', phase: 'failed', error: contractErrorForCode(cached.code, {}) }, now.toISOString());
        return;
      }
    }
    this.#plans.write({ schemaVersion: '1', plan, consumedBy: null });
    this.#operations.update(record, { status: 'succeeded', phase: 'finished', output: plan }, now.toISOString());
  }
}
