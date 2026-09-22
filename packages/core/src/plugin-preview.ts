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
import { isTerminalStatus, OperationStore, toOperationSnapshot } from './operation-store.js';
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
  readonly port: PluginPreviewPort;
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
  readonly #port: PluginPreviewPort;
  readonly #findEnvironment: (environmentId: string) => EnvironmentSummary | undefined;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: ChangePreviewServiceOptions) {
    this.#layout = options.layout;
    this.#plans = new ChangePlanStore(options.layout);
    this.#operations = new OperationStore(options.layout);
    this.#port = options.port;
    this.#findEnvironment = options.findEnvironment;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? CHANGE_PLAN_DEFAULT_TTL_MS;
  }

  get plans(): ChangePlanStore {
    return this.#plans;
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
    if (command.action.kind !== 'install') {
      // Remove preview belongs to S3. This is an explicit, controlled rejection
      // of a valid-but-unsupported action, not an internal-error fake.
      return portFail(
        'UNSUPPORTED_COMBINATION',
        'remove preview is not supported in this slice (S3)',
      );
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
    if (command.action.kind !== 'install') {
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
          };
    let outcome: PortOutcome<PluginPreviewResolution>;
    try {
      outcome = await this.#port.previewSource(command.action.source, signal, context);
    } catch {
      outcome = portFail('INTERNAL_ERROR', 'the plugin preview source threw');
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
}
