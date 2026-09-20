/**
 * Confirmed public calling surface for the T004 managed installer.
 *
 * Confirmed by hdsl-15 (T004 / issue #4) on 2026-09-20; QA drives the real
 * installer only through these public package exports, never an internal
 * module path.
 *
 * ```ts
 * // @hdsl/runtime
 * const runtime = createRuntimePort({ host, faults, ... });
 * // @hdsl/core
 * const install = await createManagedInstall({ dataRoot, catalog, runtime, faults });
 * const api = createContractRuntime({ port: install.port });
 * ```
 *
 * Boundary note (orchestrator, 2026-09-20): extracting the top-level DSH
 * package is NOT install success. T004 must verify complete dependency
 * installation plus an internal lock and a safe managed Node+DSH
 * version/help precheck. The fixtures here use synthetic tarballs and therefore
 * only prove download/digest/journal/isolation/path boundaries — they must
 * never be cited as evidence that a real DSH is runnable. That claim needs the
 * real artifacts and the precheck surface (see `install-completeness.ts`).
 */
import type {
  ContractPort,
  HostPlatform,
  OperationSnapshot,
  RuntimeCombination,
} from '@hdsl/contracts';

/** Opaque to QA; concrete shape owned by `@hdsl/runtime`. */
export type ManagedRuntimePort = unknown;
/** Reported by `recover()`; asserted structurally once the shape is frozen. */
export type RecoveryReport = unknown;

/** Ordered operation phases before commit (confirmed by T004). */
export const OPERATION_PHASES = [
  'queued',
  'downloading',
  'extracting',
  'installing-dependencies',
  'preflight',
  'committing',
] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number] | string;

/** Stable install record persisted at `<generation>/install-manifest.json`. */
export interface PreflightCheck {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
}

export interface InstallManifest {
  readonly schemaVersion: string;
  /** `npm-ci` proves a real closure; `artifacts-only` is synthetic fixtures. */
  readonly installMode: 'npm-ci' | 'artifacts-only';
  readonly node: { readonly version: string; readonly sha256: string; readonly executable: string };
  readonly dsh: { readonly version: string; readonly sha256: string; readonly entrypoint: string };
  readonly closure: {
    readonly lockSha256: string;
    readonly packageCount: number;
    readonly npmVersion: string;
  };
  readonly preflight: {
    readonly checks: readonly PreflightCheck[];
    readonly passed: boolean;
    /** True only for the explicit fixture path (`allowArtifactsOnly`). */
    readonly skipped?: boolean;
  };
  readonly installedAt: string;
}

export interface ReadInstallManifestOptions {
  readonly generationId?: string;
}

/** Public read surface on `ManagedInstall.service`. */
export interface EnvironmentService {
  readInstallManifest(
    environmentId: string,
    options?: ReadInstallManifestOptions,
  ): InstallManifest | Promise<InstallManifest>;
}

/** Fault hooks that leave the install transactional boundaries observable. */
export interface CreationFaults {
  readonly failBeforeCommit?: boolean;
  readonly pauseBeforeCommit?: boolean;
}

/** Transport/extraction faults injected through `@hdsl/runtime`. */
export interface InstallFaults {
  readonly failDownloadAfterBytes?: number;
  readonly corruptDownload?: boolean;
  readonly forceDiskFull?: boolean;
  readonly failExtraction?: boolean;
}

export interface RuntimeLimits {
  readonly maxDownloadBytes?: number;
  readonly maxExtractedBytes?: number;
  readonly minFreeBytes?: number;
}

export interface RuntimePortOptions {
  readonly host?: HostPlatform;
  readonly fetch?: typeof globalThis.fetch;
  readonly faults?: InstallFaults;
  readonly urlRewrites?: Readonly<Record<string, string>>;
  readonly localArtifactDirectory?: string;
  readonly diskFreeBytes?: (path: string) => Promise<number | undefined>;
  readonly limits?: RuntimeLimits;
  /**
   * `true` (default) runs the real `npm ci` closure for a real install; `false`
   * is the synthetic-fixture mode and records `installMode: artifacts-only`.
   */
  readonly closureInstall?: boolean;
  /** `'none'` skips the managed version/help preflight (fixture mode only). */
  readonly precheck?: 'none' | 'managed';
}

export interface ManagedLimits {
  readonly operationTimeoutMs?: number;
}

export interface ManagedInstallOptions {
  readonly dataRoot: string;
  readonly catalog: readonly RuntimeCombination[];
  readonly runtime: ManagedRuntimePort;
  readonly host?: HostPlatform;
  readonly clock?: () => Date;
  readonly faults?: CreationFaults;
  readonly limits?: ManagedLimits;
  /**
   * Test-only escape hatch (confirmed by hdsl-15): without
   * `allowArtifactsOnly: true`, production create rejects an `artifacts-only`
   * generation with `INTERNAL_ERROR` and writes no active pointer.
   */
  readonly fixtures?: { readonly allowArtifactsOnly?: boolean };
}

export interface WaitForOperationOptions {
  readonly timeoutMs?: number;
}

export interface ManagedInstall {
  readonly port: ContractPort;
  readonly service: EnvironmentService;
  recover(): Promise<RecoveryReport>;
  waitForOperation(operationId: string, options?: WaitForOperationOptions): Promise<OperationSnapshot>;
  close(): Promise<void>;
}

export type CreateManagedInstall = (options: ManagedInstallOptions) => Promise<ManagedInstall>;
export type CreateRuntimePort = (options?: RuntimePortOptions) => ManagedRuntimePort;

export interface CoreModule {
  readonly createManagedInstall: CreateManagedInstall;
}

export interface RuntimeModule {
  readonly createRuntimePort: CreateRuntimePort;
  readonly VERIFIED_COMBINATIONS: readonly RuntimeCombination[];
}

const coreLoader = (): Promise<Record<string, unknown>> =>
  import('@hdsl/core') as Promise<Record<string, unknown>>;
const runtimeLoader = (): Promise<Record<string, unknown>> =>
  import('@hdsl/runtime') as Promise<Record<string, unknown>>;

const asFunction = (value: unknown): ((...args: never[]) => unknown) | undefined =>
  typeof value === 'function' ? (value as (...args: never[]) => unknown) : undefined;

/**
 * Resolves the confirmed core factory, or `undefined` while T004 has not
 * exported one. Scenarios must fail loudly when this is `undefined`; they must
 * never silently substitute a mock port.
 */
export const loadCoreModule = async (): Promise<CoreModule | undefined> => {
  const module = await coreLoader();
  const factory = asFunction(module['createManagedInstall']);
  if (factory === undefined) {
    return undefined;
  }
  return { createManagedInstall: factory as unknown as CreateManagedInstall };
};

export const loadRuntimeModule = async (): Promise<RuntimeModule | undefined> => {
  const module = await runtimeLoader();
  const factory = asFunction(module['createRuntimePort']);
  const combinations = module['VERIFIED_COMBINATIONS'];
  if (factory === undefined || !Array.isArray(combinations)) {
    return undefined;
  }
  return {
    createRuntimePort: factory as unknown as CreateRuntimePort,
    VERIFIED_COMBINATIONS: combinations as readonly RuntimeCombination[],
  };
};

export const CONFIRMED_API_STATUS =
  'CONFIRMED by hdsl-15 (issue #4). Install-manifest/preflight surface confirmed; executable runs await the T004 implementation.';
