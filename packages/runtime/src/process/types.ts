/**
 * Public types of the managed DSH process lifecycle (T005).
 *
 * These are runtime-side structural types: `@hdsl/core` declares the same shape
 * for its injected process port, but neither package imports the other. The
 * composition root (later `apps/desktop/src/main`) wires
 * `createProcessManager(...)` into the core service.
 *
 * The frozen contract DTOs (`OperationRef`, `OpenWebUIResult`, error codes) are
 * reused verbatim; no new wire DTO or error code is introduced here.
 */
import type { OpenWebUIResult, PortOutcome } from '@hdsl/contracts';
import type { ProcessProbe } from './probe.js';
import type { ProcessLaunchRecord } from './records.js';

/**
 * What the core service hands the process manager for one start/stop attempt.
 *
 * `signal` is owned by core: aborting it is how `operations.cancel` reaches the
 * process manager. `onPhase` is the only channel through which the manager
 * reports progress; the manager never writes operation or environment records.
 */
export interface ProcessLifecycleRequest {
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly generationDirectory: string;
  readonly homeDirectory: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  /** Absolute `<generation>/node/bin/node`. */
  readonly nodeExecutable: string;
  /** Absolute `<generation>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`. */
  readonly dshEntrypoint: string;
  readonly installMode: 'npm-ci' | 'artifacts-only';
  readonly signal: AbortSignal;
  readonly onPhase?: (phase: string, progress?: number) => void;
  /**
   * `'auto'` (default) asks the OS for a free port (`--port 0`); a number pins
   * the port so a conflict can be observed and reported as `PORT_UNAVAILABLE`.
   */
  readonly port?: 'auto' | number;
}

export interface ProcessStartOutcome {
  readonly pid: number;
  /** Canonical loopback origin; never a token, query or cookie. */
  readonly loopbackOrigin: string;
}

export interface ProcessStopOutcome {
  readonly pid?: number;
  readonly wasRunning: boolean;
}

export type ProcessRecoveryResolution = 'stopped' | 'adopted' | 'no-process' | 'unverifiable';

export interface ProcessRecoveryEntry {
  readonly environmentId: string;
  readonly resolution: ProcessRecoveryResolution;
  readonly loopbackOrigin?: string;
  readonly detail?: string;
}

export interface ProcessRecoveryReport {
  readonly entries: readonly ProcessRecoveryEntry[];
}

/**
 * The injected process-lifecycle port. Structurally identical to the port
 * `@hdsl/core` declares; `close()` returns a `PortOutcome` so core can refuse
 * to release the data-root lock when a managed process could not be confirmed
 * exited.
 */
export interface ManagedProcessPort {
  start(request: ProcessLifecycleRequest): Promise<PortOutcome<ProcessStartOutcome>>;
  stop(request: ProcessLifecycleRequest): Promise<PortOutcome<ProcessStopOutcome>>;
  openWebUI(environmentId: string): PortOutcome<OpenWebUIResult>;
  recover(): Promise<ProcessRecoveryReport>;
  close(): Promise<PortOutcome<void>>;
}

/**
 * Credentials port owned by T005b (#44). `resolveLaunchEnvironment` returns a
 * handle whose `env` is the **complete explicit child environment** (managed
 * isolation variables plus credential variables); the launcher never inherits
 * the host environment. The handle's `dispose()` erases the transient
 * credential material and is called by the process manager in a `finally`
 * around the spawn, covering success, spawn failure and cancellation. The env
 * map is never persisted, logged or captured by a long-lived closure.
 */
export interface LaunchEnvironment {
  readonly env: Readonly<Record<string, string>>;
  /** Idempotent: erases the transient credential material. */
  dispose(): void;
}

export interface LaunchCredentialPort {
  resolveLaunchEnvironment(
    environmentId: string,
  ): Promise<PortOutcome<LaunchEnvironment>>;
}

export interface ProcessExitEvent {
  readonly environmentId: string;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ProcessManagerObservability {
  /** Directory holding `launches/<environmentId>.json`. */
  readonly launchesDirectory: string;
  /** Identity of the last managed launch for an environment (never just a pid). */
  readLaunchRecord(environmentId: string): ProcessLaunchRecord | undefined;
  listLaunchRecords(): readonly ProcessLaunchRecord[];
}

export interface ProcessManager extends ManagedProcessPort, ProcessManagerObservability {}

export interface ProcessManagerOptions {
  /** Application data root; launch records live under `<dataRoot>/process`. */
  readonly dataRoot: string;
  /** T005b credential-injection port; required so no launch can bypass it. */
  readonly credentials: LaunchCredentialPort;
  readonly probe?: ProcessProbe;
  readonly readinessTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly confirmMs?: number;
  /** Called when a running managed process exits unexpectedly. */
  readonly onProcessExit?: (event: ProcessExitEvent) => void;
  /** Returns false when another live instance owns the data root. */
  readonly isRecoveryPermitted?: () => boolean;
}
