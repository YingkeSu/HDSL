/**
 * Ports the environment/transaction layer needs from the managed-runtime
 * adapter (`@hdsl/runtime`).
 *
 * `@hdsl/core` and `@hdsl/runtime` are sibling packages: neither may depend on
 * the other (tests/engineering/workspace-boundaries.test.ts). The composition
 * root — today the test/acceptance harness, later `apps/desktop/src/main` —
 * wires a concrete runtime port into this layer. The interfaces below are
 * structural, so a runtime object declared with the same shape is assignable
 * without an import in either direction.
 */
import type {
  InstalledPluginsView,
  CompositionLock,
  EntryPatchOperation,
  EntryPatchResult,
  ExpectedCompositionDiagnostic,
  ExpectedCompositionGroup,
  ExportResult,
  OpenWebUIResult,
  PortOutcome,
  RuntimeCombination,
} from '@hdsl/contracts';

export interface InstallProgress {
  readonly phase: string;
  readonly progress?: number;
}

export interface InstallContext {
  readonly signal: AbortSignal;
  /** Shared, immutable verified-download cache (`<dataRoot>/artifacts`). */
  readonly cacheDirectory: string;
  /** Scratch root used for staging archive copies (`<dataRoot>/tmp`). */
  readonly scratchDirectory: string;
  /** Shared, isolated npm download cache (`<dataRoot>/npm-cache`). */
  readonly npmCacheDirectory: string;
  /**
   * Managed profile name for this generation. The installer may stage an
   * immutable declaration source for it when profile initialization is enabled.
   */
  readonly profileName?: string;
  readonly onProgress?: (update: InstallProgress) => void;
}

export interface InstalledRuntimeArtifacts {
  readonly directory: string;
  readonly nodeExecutable: string;
  readonly dshEntrypoint: string;
  readonly manifestPath: string;
}

/** Read-only installed-plugin listing of an environment's active generation. */
export interface InstalledPluginsPort {
  list(environmentId: string): PortOutcome<InstalledPluginsView>;
}

/** Inputs for one managed `--dump-config` read of an active generation (#118). */
export interface ExpectedCompositionDumpRequest {
  readonly nodeExecutable: string;
  readonly dshEntrypoint: string;
  readonly profileName: string;
  readonly homeDirectory: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}

/** Parsed grouped `--dump-config` result (never the runtime ACTIVE set). */
export interface ExpectedCompositionDumpResult {
  readonly groups: readonly ExpectedCompositionGroup[];
  readonly diagnostics: readonly ExpectedCompositionDiagnostic[];
  readonly rowCount: number;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly observedAt: string;
}

/**
 * Managed read-only `--dump-config` adapter. Implementations run the managed
 * Node + DSH entrypoint offline (no plugin execution, no credential) and must
 * honour the abort signal.
 */
export interface ExpectedCompositionPort {
  describeExpectedComposition(
    request: ExpectedCompositionDumpRequest,
    signal: AbortSignal,
  ): Promise<PortOutcome<ExpectedCompositionDumpResult>>;
}

/**
 * One desired-config edit of the environment-shared home user patch (#135). The
 * core service resolves the environment-shared home and the published profile's
 * `patchReload`, reads the current patch text (`[]` when absent) and delegates
 * the atomic edit to the runtime boundary.
 */
export interface EntryPatchRequest {
  readonly operation: EntryPatchOperation;
  /** Environment-shared `$DSH_HOME`; the patch path must be strictly inside. */
  readonly homeRoot: string;
  /** Absolute path of `<homeRoot>/cordis.patch.yml`. */
  readonly patchPath: string;
  /** Current patch text; `[]` when the file is absent. */
  readonly text: string;
  readonly reloadMode: 'live' | 'startup' | 'unknown';
}

/** Terminal home-patch result without the core-owned `environmentId`. */
export type EntryPatchApplied = Omit<EntryPatchResult, 'environmentId'>;

/**
 * Runtime-owned desired-config adapter. It MUST write only inside `homeRoot`
 * (never a generation's immutable profile declaration source) and MUST NOT
 * upgrade a saved file to a runtime ACTIVE claim.
 */
export interface EntryPatchPort {
  applyPatch(request: EntryPatchRequest): PortOutcome<EntryPatchApplied>;
}


export interface ManagedRuntimePort {
  resolveComposition(combination: RuntimeCombination): PortOutcome<CompositionLock>;
  compositionDigest(lock: CompositionLock): string;
  install(
    lock: CompositionLock,
    destination: string,
    context: InstallContext,
  ): Promise<PortOutcome<InstalledRuntimeArtifacts>>;
}

/**
 * Runtime-owned phase values for a managed start/stop operation. Bounded and
 * secret-free; core persists them as the operation phase.
 */
export type ManagedProcessPhase = 'spawning' | 'waiting-ready' | 'running' | 'stopping';

/**
 * Everything the managed-process module needs to start or stop one environment.
 * The generation paths are resolved by core from the committed install
 * manifest; the request never carries credentials (those are resolved by the
 * runtime-owned credential port immediately before spawn).
 */
export interface ProcessLifecycleRequest {
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly generationDirectory: string;
  readonly homeDirectory: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  /** Absolute path of the managed Node executable. */
  readonly nodeExecutable: string;
  /** Absolute path of the managed DSH entrypoint. */
  readonly dshEntrypoint: string;
  /** The runtime refuses to really start an `artifacts-only` generation. */
  readonly installMode: InstallMode;
  /**
   * DSH profile name to boot (`--profile <name>`). Defaults to `web` when
   * absent, preserving the pre-P-A behavior for generations with no published
   * managed profile.
   */
  readonly profileName?: string;
  readonly signal: AbortSignal;
  readonly onPhase: (phase: ManagedProcessPhase, progress?: number) => void;
  /** `'auto'` asks for an OS-assigned loopback port. */
  readonly port?: 'auto' | number;
}

export interface ProcessStartOutcome {
  readonly pid: number;
  /** Verified loopback origin; never carries a token or query. */
  readonly loopbackOrigin: string;
}

export interface ProcessStopOutcome {
  readonly pid?: number;
  readonly wasRunning: boolean;
}

export interface ProcessRecoveryEntry {
  readonly environmentId: string;
  readonly resolution: 'stopped' | 'adopted' | 'no-process' | 'unverifiable';
  readonly loopbackOrigin?: string;
  readonly detail?: string;
}

export interface ProcessRecoveryReport {
  readonly entries: readonly ProcessRecoveryEntry[];
}

/**
 * The T005 managed-process port, injected at the composition root. It is
 * structural: `@hdsl/runtime` declares an equivalent type without importing
 * core, and core never imports runtime.
 *
 * `close()` must stop every provably-owned/adopted DSH and every install /
 * preflight child tree this instance still holds, await their exit, and only
 * then resolve `ok`. An unprovable identity must fail with `INTERNAL_ERROR`
 * rather than report success.
 */
export interface ManagedProcessPort {
  start(request: ProcessLifecycleRequest): Promise<PortOutcome<ProcessStartOutcome>>;
  stop(request: ProcessLifecycleRequest): Promise<PortOutcome<ProcessStopOutcome>>;
  openWebUI(environmentId: string): PortOutcome<OpenWebUIResult>;
  recover(): Promise<ProcessRecoveryReport>;
  close(): Promise<PortOutcome<void>>;
}

/** Injected by the composition root into the runtime process module. */
export interface ManagedProcessExit {
  readonly environmentId: string;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

export type ProcessExitHandler = (info: ManagedProcessExit) => void;

/** Signals a managed process exited on its own after a successful start. */
export type ProcessExitListener = (info: ManagedProcessExit) => void;

export type DiagnosticsExporter = (environmentId: string) => PortOutcome<ExportResult>;

/** `artifacts-only` means the DSH dependency closure was not installed. */
export type InstallMode = 'npm-ci' | 'artifacts-only';

export interface InstallCheck {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
}

export interface InstallManifest {
  readonly schemaVersion: '1';
  readonly installMode: InstallMode;
  readonly catalogRevision: string;
  readonly compositionDigest: string;
  readonly node: {
    readonly version: string;
    readonly sha256: string;
    readonly executable: string;
    /** Optional (older records omit it); reuse verification fails closed without it. */
    readonly treeDigest?: string;
  };
  readonly dsh: {
    readonly version: string;
    readonly sha256: string;
    readonly entrypoint: string;
    readonly treeDigest: string;
  };
  readonly closure: {
    readonly installed: boolean;
    readonly lockSha256: string;
    readonly lockAsset: string;
    readonly packageCount: number;
    readonly rootIntegritySha512: string;
    readonly npmVersion: string;
    readonly nodeVersion: string;
  } | null;
  readonly preflight: {
    readonly skipped: boolean;
    readonly passed: boolean;
    readonly checks: readonly InstallCheck[];
    readonly reason?: string;
  };
  /**
   * Optional (schema v1 add-on). Absent on records from older builds, which are
   * treated as "no managed profile" (legacy `web` compatibility). When present,
   * the commit verifies BOTH the name and the digest against the real staged
   * declaration source before publishing.
   */
  readonly profile?: {
    readonly name: string;
    readonly digest: string;
  } | null;
  readonly installedAt: string;
}
