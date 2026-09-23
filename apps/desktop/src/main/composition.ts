/**
 * Desktop composition root (T006 / issue #6).
 *
 * Wires the real `@hdsl/core` service, the audited `@hdsl/runtime` installer and
 * process manager, the T005c credential reference port and the frozen contract
 * port. This is the only place that:
 * - acquires the exclusive data-root lease before any UI operation (the
 *   single-instance gate required by the T004/T006 hand-off);
 * - builds `createLaunchCredentialPort({ load: service.launchCredentialRequest })`
 *   and injects it into `createProcessManager`;
 * - wraps `openWebUI` so the process manager's own-process/loopback verification
 *   always runs before a main-only opener is invoked.
 *
 * It is Electron-free apart from type-only imports, so unit tests drive the same
 * wiring with fakes.
 */
import {
  isLoopbackOrigin,
  portFail,
  type ContractPort,
  type EnvironmentSummary,
  type HostPlatform,
  type OpenWebUIResult,
  type PortOutcome,
  type RuntimeCombination,
} from '@hdsl/contracts';
import { join } from 'node:path';
import {
  createEnvironmentContractPort,
  EnvironmentService,
  OperationStore,
  PluginDiscoveryService,
  ChangePreviewService,
  ChangeApplyService,
  ChangePlanStore,
  EnvironmentStore,
  InstalledPluginsService,
  type PluginPreviewPort,
  type CloseReport,
  type DataRootLockSnapshot,
  type DiagnosticsExporter,
  type ManagedProcessExit,
  type ManagedProcessPort,
  type ManagedRuntimePort,
  type PluginSourcePort,
  type RecoveryReport,
} from '@hdsl/core';
import {
  createGitHubPluginSource,
  createPluginApplyPort,
  createManagedPnpmExecutor,
  createGenerationRuntimeVerifier,
  createPluginRemovalPort,
  resolveInBoxBundles,
  createResolvingPreviewPort,
  computeCompositionDigest,
  PNPM_EXECUTOR_SPEC,
  createLaunchCredentialPort,
  createProcessManager,
  createRuntimePort,
  VERIFIED_COMBINATIONS,
  type ProcessManager,
} from '@hdsl/runtime';
import type { DiagnosticAppInfo } from './diagnostics.js';
import {
  createDiagnosticsExporter,
  type DiagnosticsLaunchRecord,
  type DiagnosticsPathChooser,
} from './exporter.js';

/** The main-only runtime capability consumed by the WebUI opener. */
export interface WebUiBootstrapCapability {
  consumeWebUIBootstrap(
    environmentId: string,
    open: (bootstrapUrl: string) => void | Promise<void>,
  ): Promise<PortOutcome<void>>;
}

/** Context handed to the main-only WebUI opener after ownership is verified. */
export interface VerifiedWebUiContext {
  readonly environmentId: string;
  readonly loopbackOrigin: string;
  /** The core-declared managed-process port (ownership gate). */
  readonly processPort: ManagedProcessPort;
  /**
   * Present only when the runtime process manager provides the main-only
   * authenticated bootstrap. The URL it hands the callback is never returned to
   * the renderer, logged or persisted.
   */
  readonly webUiBootstrap?: WebUiBootstrapCapability;
}

/**
 * Narrow injection seam: a verified loopback origin for a genuinely owned
 * managed process. The opener is awaited by `DesktopComposition.openWebUi`, so
 * success is bound to the real result and `opened: true` can never precede an
 * async failure. The default entry opener uses the runtime
 * authenticated-bootstrap capability when present and otherwise returns
 * `WEBUI_UNAVAILABLE` instead of opening a token-free origin that would 401.
 * A bootstrap URL must never reach the renderer, logs, diagnostics or durable
 * records.
 */
export type VerifiedWebUiOpener = (
  context: VerifiedWebUiContext,
) => Promise<PortOutcome<OpenWebUIResult>>;

export interface DesktopCompositionOptions {
  readonly dataRoot: string;
  readonly appInfo: DiagnosticAppInfo;
  readonly catalog?: readonly RuntimeCombination[];
  readonly host?: HostPlatform;
  readonly runtime?: ManagedRuntimePort;
  /** Test seam: replaces the real GitHub read adapter (no fixture hits the network). */
  readonly pluginSource?: PluginSourcePort;
  /** Controlled change-preview adapter; defaults to the GitHub adapter. */
  readonly pluginPreview?: PluginPreviewPort;
  /** Test seam: replaces the real process manager (still decorated + attached). */
  readonly process?: ManagedProcessPort;
  /** Test seam: a runtime manager used for observability in diagnostics. */
  readonly manager?: ProcessManager;
  /** Required: the main-only opener invoked after ownership verification. */
  readonly openWebUi: VerifiedWebUiOpener;
  readonly pathChooser?: DiagnosticsPathChooser;
  readonly clock?: () => Date;
  readonly redactions?: readonly string[];
  readonly writeFile?: (targetPath: string, content: string) => void;
  readonly lockWaitTimeoutMs?: number;
  readonly lockPollIntervalMs?: number;
  readonly allowArtifactsOnly?: boolean;
}

export interface DesktopComposition {
  readonly service: EnvironmentService;
  readonly port: ContractPort;
  readonly processPort: ManagedProcessPort;
  readonly available: boolean;
  readonly recovery: RecoveryReport;
  /** Journal + idempotency-ledger reconciliation of crashed apply/restore transactions. */
  readonly applyRecovery: { readonly finalized: number; readonly rolledBack: number };
  /** Reconciliation of crashed (read-only) preview operations; never changes an environment. */
  readonly previewRecovery: { readonly terminated: number };
  readonly lockSnapshot: () => DataRootLockSnapshot;
  readonly exporterAvailable: boolean;
  /**
   * Registers a listener for environment state changes that were **not** caused
   * by a renderer request — a managed process exiting on its own (FR-005).
   * Returns an unsubscribe function. This is the projection source the Electron
   * entry forwards to every open window; the renderer never has to poll for it.
   */
  readonly onEnvironmentChanged: (
    listener: (environment: EnvironmentSummary) => void,
  ) => () => void;
  /**
   * True when restart reconciliation left a managed process it could not prove
   * exited. New create/start mutations are then refused by main until the
   * residue is resolved; stop/read/export remain available.
   */
  readonly recoveryBlocked: boolean;
  readonly recoveryReasons: readonly string[];
  /**
   * Verifies ownership synchronously and then awaits the injected main-only
   * authenticated opener. Success is reported only after the opener's real
   * result, so `opened: true` can never precede an async failure. The token-free
   * `loopbackOrigin` is returned for display; any bootstrap URL stays inside the
   * opener and never reaches the renderer.
   */
  openWebUi(environmentId: string): Promise<PortOutcome<OpenWebUIResult>>;
  close(): Promise<CloseReport>;
}

/** Mutations refused while restart reconciliation is unresolved. */
export const RECOVERY_BLOCKED_METHODS: ReadonlySet<string> = new Set([
  'environments.create',
  'environments.start',
]);

/**
 * True when a contract method is a new mutation that must wait for a manual
 * cleanup of an unverifiable managed process. Reads, stop and export stay
 * available so the residue can be inspected or converged.
 */
export const isBlockedByRecovery = (method: string, recoveryBlocked: boolean): boolean =>
  recoveryBlocked && RECOVERY_BLOCKED_METHODS.has(method);

const noPathChooser: DiagnosticsPathChooser = {
  chooseExportPath: () => null,
};

/**
 * Verifies the managed process port's own-process/loopback result before any
 * main-only opener may run. It never opens anything itself, so the frozen
 * synchronous `environments.openWebUI` dispatch stays free of an unawaited side
 * effect; `DesktopComposition.openWebUi` awaits the opener instead.
 */
export const verifyOpenWebUI = (processPort: ManagedProcessPort): ManagedProcessPort => ({
  ...processPort,
  openWebUI: (environmentId: string): PortOutcome<OpenWebUIResult> => {
    const verified = processPort.openWebUI(environmentId);
    if (!verified.ok) {
      return verified;
    }
    if (!isLoopbackOrigin(verified.value.loopbackOrigin)) {
      return portFail('WEBUI_UNAVAILABLE', 'the managed endpoint is not a canonical loopback origin');
    }
    return verified;
  },
});

const observableLaunch = (
  processLike: unknown,
  environmentId: string,
): DiagnosticsLaunchRecord | null => {
  const reader = (processLike as { readonly readLaunchRecord?: unknown }).readLaunchRecord;
  if (typeof reader !== 'function') {
    return null;
  }
  const record = (reader as (id: string) => {
    readonly state: string;
    readonly endpoint: { readonly origin: string } | null;
    readonly identity: unknown;
    readonly exitCode: number | null;
    readonly errorCode: DiagnosticsLaunchRecord['errorCode'];
  } | undefined)(environmentId);
  if (record === undefined) {
    return null;
  }
  return {
    state: record.state,
    endpointOrigin: record.endpoint === null ? null : record.endpoint.origin,
    identityRecorded: record.identity !== null && record.identity !== undefined,
    exitCode: record.exitCode,
    errorCode: record.errorCode,
  };
};

/**
 * Adapts the runtime process manager to the core-declared `ManagedProcessPort`.
 * The two structural types differ only in `onPhase`'s parameter width: runtime
 * emits a `string` phase while core narrows it to its four managed phases. The
 * adapter filters to the known set so a future unknown runtime phase cannot
 * cross into core.
 */
const MANAGED_PROCESS_PHASES: ReadonlySet<string> = new Set([
  'spawning',
  'waiting-ready',
  'running',
  'stopping',
]);

export const adaptProcessPort = (manager: ProcessManager): ManagedProcessPort => ({
  start: (request) =>
    manager.start({
      ...request,
      onPhase: (phase, progress) => {
        if (MANAGED_PROCESS_PHASES.has(phase)) {
          request.onPhase(phase as Parameters<typeof request.onPhase>[0], progress);
        }
      },
    }),
  stop: (request) =>
    manager.stop({
      ...request,
      onPhase: (phase, progress) => {
        if (MANAGED_PROCESS_PHASES.has(phase)) {
          request.onPhase(phase as Parameters<typeof request.onPhase>[0], progress);
        }
      },
    }),
  openWebUI: (environmentId) => manager.openWebUI(environmentId),
  recover: () => manager.recover(),
  close: () => manager.close(),
});

/**
 * Projects a managed-process exit to a renderer-visible environment summary.
 *
 * It lets core apply the transition first (`handleProcessExit`), then reads the
 * resulting summary and notifies **only when the state actually changed**, so a
 * duplicate or late exit cannot spam the bridge and a renderer-issued stop stays
 * authoritative. An unknown environment (or an unchanged state) is a no-op.
 */
export const projectProcessExit = (
  service: Pick<EnvironmentService, 'findEnvironment' | 'handleProcessExit'>,
  onEnvironmentChanged?: (environment: EnvironmentSummary) => void,
): ((info: ManagedProcessExit) => void) =>
  (info) => {
    const before = service.findEnvironment(info.environmentId);
    service.handleProcessExit(info);
    if (onEnvironmentChanged === undefined) {
      return;
    }
    const after = service.findEnvironment(info.environmentId);
    if (!after.ok) {
      return;
    }
    if (before.ok && before.value.state === after.value.state) {
      return;
    }
    onEnvironmentChanged(after.value);
  };

/** Builds the real credential port + process manager for a live service. */
export const buildManagedProcessPort = (
  service: EnvironmentService,
  dataRoot: string,
  onEnvironmentChanged?: (environment: EnvironmentSummary) => void,
): ProcessManager => {
  const credentials = createLaunchCredentialPort({
    load: (environmentId) => service.launchCredentialRequest(environmentId),
  });
  return createProcessManager({
    dataRoot,
    credentials,
    onProcessExit: projectProcessExit(service, onEnvironmentChanged),
    isRecoveryPermitted: () => service.available,
  });
};

/**
 * Production runtime options. Profile initialization MUST stay enabled on every
 * production install path so a new generation always gets its managed profile
 * and never silently falls back to the shared `web` profile.
 */
export const PRODUCTION_RUNTIME_OPTIONS = { profileInit: true } as const;

export const createDesktopComposition = async (
  options: DesktopCompositionOptions,
): Promise<DesktopComposition> => {
  const catalog = options.catalog ?? VERIFIED_COMBINATIONS;
  const runtime = options.runtime ?? createRuntimePort(PRODUCTION_RUNTIME_OPTIONS);
  const exported: { current: DiagnosticsExporter | undefined } = { current: undefined };
  const service = new EnvironmentService({
    dataRoot: options.dataRoot,
    catalog,
    runtime,
    ...(options.host === undefined ? {} : { host: options.host }),
    exportDiagnostics: (environmentId) =>
      exported.current?.(environmentId) ??
      portFail('EXPORT_FAILED', 'the diagnostic exporter is not ready'),
    ...(options.lockWaitTimeoutMs === undefined
      ? {}
      : { lockWaitTimeoutMs: options.lockWaitTimeoutMs }),
    ...(options.lockPollIntervalMs === undefined
      ? {}
      : { lockPollIntervalMs: options.lockPollIntervalMs }),
    ...(options.allowArtifactsOnly === undefined
      ? {}
      : { allowArtifactsOnly: options.allowArtifactsOnly }),
  });

  await service.open();

  // Projection seam for state changes the renderer did not request. The Electron
  // entry registers a broadcaster once its IPC host exists; the exit path only
  // reads it, so a listener fault can never abort process-exit reconciliation.
  const environmentChangedListeners = new Set<(environment: EnvironmentSummary) => void>();
  const notifyEnvironmentChanged = (environment: EnvironmentSummary): void => {
    for (const listener of [...environmentChangedListeners]) {
      try {
        listener(environment);
      } catch {
        // A faulty listener must not break the managed-process exit path.
      }
    }
  };

  const manager =
    options.manager ??
    (options.process === undefined
      ? buildManagedProcessPort(service, options.dataRoot, notifyEnvironmentChanged)
      : undefined);
  let baseProcess: ManagedProcessPort;
  if (options.process !== undefined) {
    baseProcess = options.process;
  } else {
    baseProcess = adaptProcessPort(manager as ProcessManager);
  }
  const processPort = verifyOpenWebUI(baseProcess);
  service.attachProcess(processPort);

  const operations = new OperationStore(service.layout);
  const exporter = createDiagnosticsExporter({
    service,
    layout: service.layout,
    operations,
    readLaunchRecord: (environmentId) =>
      observableLaunch(manager ?? baseProcess, environmentId),
    app: options.appInfo,
    pathChooser: options.pathChooser ?? noPathChooser,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.redactions === undefined ? {} : { redactions: options.redactions }),
    ...(options.writeFile === undefined ? {} : { writeFile: options.writeFile }),
  });
  exported.current = exporter;

  // Global, read-only plugin discovery. The GitHub adapter is unauthenticated
  // and network-only; it never touches an environment composition (ADR 0005
  // D16/D17). Tests inject a controlled source here.
  const defaultGitHubSource = createGitHubPluginSource({ fetch: globalThis.fetch });
  const pluginDiscovery = new PluginDiscoveryService({
    layout: service.layout,
    source: options.pluginSource ?? defaultGitHubSource,
  });
  // Environment-scoped change preview. The default adapter is the same GitHub
  // source; tests inject a controlled preview port instead.
  const executorIdentity = {
    id: 'pnpm' as const,
    version: PNPM_EXECUTOR_SPEC.version,
    sha256: PNPM_EXECUTOR_SPEC.sha256,
    entrySha256: PNPM_EXECUTOR_SPEC.entrySha256,
    treeSha256: PNPM_EXECUTOR_SPEC.treeSha256,
  };
  const managedPnpmExecutor = createManagedPnpmExecutor({
    spec: PNPM_EXECUTOR_SPEC,
    cacheDirectory: join(service.layout.root, 'pnpm-cache'),
    fetch: globalThis.fetch,
  });
  const previewPort: PluginPreviewPort | undefined =
    options.pluginPreview ??
    (options.pluginSource === undefined
      ? createResolvingPreviewPort({
          gitProvider: defaultGitHubSource,
          executor: managedPnpmExecutor,
          executorIdentity,
        })
      : undefined);
  // S3 removal adapter: in-box identity from the CURRENT managed install, the
  // read-only user-patch scan and the isolated pruned-lock recompute under the
  // managed Node + frozen pnpm executor.
  const removalPort = createPluginRemovalPort({ executor: managedPnpmExecutor });
  const changePreview = new ChangePreviewService({
    layout: service.layout,
    ...(previewPort === undefined ? {} : { port: previewPort }),
    removalPort,
    findEnvironment: (environmentId) => {
      const outcome = service.findEnvironment(environmentId);
      return outcome.ok ? outcome.value : undefined;
    },
  });

  // Environment-scoped apply transaction: the GitHub source is the production
  // GitProvider and the frozen managed pnpm artifact is the executor. The reused
  // runtime is verified with the managed-install tree digest before any commit.
  const applyPort = createPluginApplyPort({
    gitProvider: defaultGitHubSource,
    executor: managedPnpmExecutor,
  });
  const changeApply = new ChangeApplyService({
    layout: service.layout,
    plans: new ChangePlanStore(service.layout),
    environments: new EnvironmentStore(service.layout),
    operations: new OperationStore(service.layout),
    compositionDigest: computeCompositionDigest,
    port: applyPort,
    removalPort,
    verifyGenerationRuntime: createGenerationRuntimeVerifier(),
  });

  // Read-only installed-plugin view of the ACTIVE generation. `isBuiltin` comes
  // from the current managed install's own tree, never from the client.
  const installedPlugins = new InstalledPluginsService({
    layout: service.layout,
    environments: new EnvironmentStore(service.layout),
    inBox: { resolveInBoxBundles },
  });

  const port = createEnvironmentContractPort({
    service,
    catalog,
    ...(options.host === undefined ? {} : { host: options.host }),
    exportDiagnostics: exporter,
    pluginDiscovery,
    changePreview,
    changeApply,
    installedPlugins,
  });

  // Recovery ORDER + ownership (P1 fix): each service reconciles the operation
  // kinds it owns BEFORE the environment service runs. `preview` is read-only
  // (orphans are terminated without touching the environment), and
  // `apply`/`restore` are journal/ledger-reconciled. The environment service no
  // longer sees (or clears the pointer for) kinds it does not own, so a crashed
  // preview can never invalidate a committed generation.
  const applyRecovery = changeApply.recover();
  const previewRecovery = changePreview.recover();
  const recovery = await service.recover();
  const recoveryReasons = (recovery.process ?? [])
    .filter((entry) => entry.resolution === 'unverifiable')
    .map((entry) => entry.environmentId);
  const recoveryBlocked = recoveryReasons.length > 0;

  const openWebUi = async (environmentId: string): Promise<PortOutcome<OpenWebUIResult>> => {
    const verified = processPort.openWebUI(environmentId);
    if (!verified.ok) {
      return verified;
    }
    if (!isLoopbackOrigin(verified.value.loopbackOrigin)) {
      return portFail('WEBUI_UNAVAILABLE', 'the managed endpoint is not a canonical loopback origin');
    }
    return options.openWebUi({
      environmentId,
      loopbackOrigin: verified.value.loopbackOrigin,
      processPort,
      ...(manager === undefined ? {} : { webUiBootstrap: manager }),
    });
  };

  return {
    service,
    port,
    processPort,
    available: service.available,
    recovery,
    applyRecovery,
    previewRecovery,
    recoveryBlocked,
    recoveryReasons,
    lockSnapshot: () => service.lockSnapshot(),
    exporterAvailable: true,
    onEnvironmentChanged: (listener) => {
      environmentChangedListeners.add(listener);
      return () => {
        environmentChangedListeners.delete(listener);
      };
    },
    openWebUi,
    close: () => service.close(),
  };
};
