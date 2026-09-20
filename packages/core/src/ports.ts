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
  CompositionLock,
  ExportResult,
  OpenWebUIResult,
  OperationRef,
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
  readonly onProgress?: (update: InstallProgress) => void;
}

export interface InstalledRuntimeArtifacts {
  readonly directory: string;
  readonly nodeExecutable: string;
  readonly dshEntrypoint: string;
  readonly manifestPath: string;
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

/** Provides the T005 process lifecycle; absent in the T004-only harness. */
export interface ProcessLifecyclePort {
  start(environmentId: string, expectedRevision: number): PortOutcome<OperationRef>;
  stop(environmentId: string, expectedRevision: number): PortOutcome<OperationRef>;
  openWebUI(environmentId: string): PortOutcome<OpenWebUIResult>;
}

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
  readonly installedAt: string;
}
