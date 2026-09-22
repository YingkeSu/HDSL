/**
 * Real managed DSH process lifecycle (T005).
 *
 * Responsibilities (frozen with the core lifecycle author):
 * - spawn the exact managed Node with the audited DSH entrypoint and an
 *   explicit, isolated environment (never the host environment);
 * - resolve managed credentials through the T005b port and inject them only as
 *   explicit child environment variables (never argv, never persisted);
 * - detect readiness from the upstream ready line plus a loopback probe, and
 *   persist only the canonical loopback origin (no token/query/cookie);
 * - record process ownership as pid + kernel start token + command fragment so
 *   a reused pid can never be mistaken for our process;
 * - terminate the whole owned process tree (SIGTERM → grace → SIGKILL) on stop,
 *   cancel, timeout, spawn failure and `close`, and resolve only once the tree
 *   has exited;
 * - reconcile leftovers from a crashed instance without rolling back another
 *   live instance.
 *
 * The manager never writes operation or environment records: core owns those.
 * It reports progress through `onPhase` and unexpected exits through
 * `onProcessExit`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  isErrorCode,
  portFail,
  portOk,
  type ErrorCode,
  type OpenWebUIResult,
  type PortOutcome,
} from '@hdsl/contracts';
import { findOwnedProcessesDetailed, identityIsGone, verifyIdentity } from './ownership.js';
import type { OwnershipVerdict } from './ownership.js';
import { createPosixProcessProbe } from './probe.js';
import {
  LaunchRecordStore,
  listInstallChildJournals,
  type ProcessEndpoint,
  type ProcessIdentity,
  type ProcessLaunchRecord,
  type ProcessLaunchState,
} from './records.js';
import {
  isManagedLoopbackOrigin,
  parseReadyTarget,
  probeLoopbackTcp,
  type ReadyTarget,
} from './readiness.js';
import {
  captureGroupSurvivors,
  cleanupLostLeaderTree,
  readGroupLeftovers,
  type LeftoverCleanupResult,
} from './leftovers.js';
import { delay, isProcessAlive, killProcessTreeSync, signalProcessTree, waitForProcessExit } from './tree.js';
import { reconcileRuntimeState } from '../reconcile/reconcile.js';
import type { LaunchCredentialPort, LaunchEnvironmentHandle } from '../credentials/index.js';
import type {
  ProcessExitEvent,
  ProcessLifecycleRequest,
  ProcessManager,
  ProcessManagerOptions,
  ProcessRecoveryReport,
  ProcessStartOutcome,
  ProcessStopOutcome,
} from './types.js';

interface ActiveTask {
  readonly kind: 'start' | 'stop';
  readonly controller: AbortController;
}

type ReadinessResult =
  | { readonly kind: 'ready'; readonly target: ReadyTarget }
  | {
      readonly kind: 'exit';
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly output: string;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'spawn-error' }
  | { readonly kind: 'loopback-failed'; readonly target: ReadyTarget };

/**
 * In-memory-only WebUI bootstrap for one launched process (T006 prerequisite).
 * Bound to the launched identity and the verified loopback endpoint; never
 * persisted and never exposed through the frozen contract port.
 */
interface WebUIBootstrapEntry {
  readonly url: string;
  readonly origin: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  readonly startToken: string;
}

interface LaunchPatch {
  readonly state?: ProcessLaunchState;
  readonly identity?: ProcessIdentity | null;
  readonly endpoint?: ProcessEndpoint | null;
  readonly exitCode?: number | null;
  readonly observedSurvivors?: readonly ProcessIdentity[] | null;
  readonly errorCode?: ErrorCode | null;
  readonly errorDetail?: string | null;
}

const OUTPUT_BUFFER_LIMIT = 32 * 1024;
const MANAGED_PATH_ENTRIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;
const appendBounded = (current: string, chunk: Buffer): string => {
  const next = current + chunk.toString('utf8');
  return next.length > OUTPUT_BUFFER_LIMIT ? next.slice(-OUTPUT_BUFFER_LIMIT) : next;
};

/** Runtime shape check for the injected credential port result (review P3-2). */
const isCredentialOutcome = (value: unknown): value is PortOutcome<LaunchEnvironmentHandle> => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { readonly ok?: unknown };
  if (candidate.ok === true) {
    return Object.prototype.hasOwnProperty.call(value, 'value');
  }
  if (candidate.ok === false) {
    return (
      Object.prototype.hasOwnProperty.call(value, 'code') &&
      Object.prototype.hasOwnProperty.call(value, 'message')
    );
  }
  return false;
};

const isLaunchEnvironmentHandle = (value: unknown): value is LaunchEnvironmentHandle => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { readonly env?: unknown; readonly dispose?: unknown };
  return (
    candidate.env !== null &&
    typeof candidate.env === 'object' &&
    typeof candidate.dispose === 'function'
  );
};

export const createProcessManager = (options: ProcessManagerOptions): ProcessManager => {
  const probe = options.probe ?? createPosixProcessProbe();
  const launches = new LaunchRecordStore(join(options.dataRoot, 'process', 'launches'));
  const dataRoot = options.dataRoot;
  const credentials: LaunchCredentialPort = options.credentials;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
  const stopGraceMs = options.stopGraceMs ?? 5_000;
  const confirmMs = options.confirmMs ?? 5_000;
  const onProcessExit = options.onProcessExit;
  const isRecoveryPermitted = options.isRecoveryPermitted;

  let closed = false;
  const active = new Map<string, ActiveTask>();
  const tasks = new Set<Promise<unknown>>();
  // Main-only, in-memory WebUI bootstrap; cleared on stop/close/exit and before
  // any replacement launch. Never persisted or exposed to the contract port.
  const bootstraps = new Map<string, WebUIBootstrapEntry>();

  const tracked = <T>(promise: Promise<T>): Promise<T> => {
    tasks.add(promise);
    const remove = (): void => {
      tasks.delete(promise);
    };
    void promise.then(remove, remove);
    return promise;
  };

  const emitPhase = (request: ProcessLifecycleRequest, phase: string): void => {
    try {
      request.onPhase?.(phase);
    } catch {
      // A failing progress callback must never break the lifecycle.
    }
  };

  const patch = (record: ProcessLaunchRecord, update: LaunchPatch): ProcessLaunchRecord => ({
    schemaVersion: '1',
    environmentId: record.environmentId,
    expectedRevision: record.expectedRevision,
    generationDirectory: record.generationDirectory,
    commandFragment: record.commandFragment,
    state: update.state ?? record.state,
    identity: update.identity !== undefined ? update.identity : record.identity,
    endpoint: update.endpoint !== undefined ? update.endpoint : record.endpoint,
    exitCode: update.exitCode !== undefined ? update.exitCode : record.exitCode,
    observedSurvivors:
      update.observedSurvivors !== undefined ? update.observedSurvivors : record.observedSurvivors,
    errorCode: update.errorCode !== undefined ? update.errorCode : record.errorCode,
    errorDetail: update.errorDetail !== undefined ? update.errorDetail : record.errorDetail,
    createdAt: record.createdAt,
    updatedAt: new Date().toISOString(),
    sequence: record.sequence + 1,
  });

  const failStart = (
    record: ProcessLaunchRecord,
    code: ErrorCode,
    message: string,
  ): PortOutcome<never> => {
    const current = launches.read(record.environmentId) ?? record;
    launches.write(patch(current, { state: 'failed', errorCode: code, errorDetail: message }));
    return portFail(code, message);
  };

  /** The five-key managed mapping, exactly matching core's baseEnv. */
  const managedEnvironment = (request: ProcessLifecycleRequest): Record<string, string> => ({
    HOME: request.homeDirectory,
    DSH_HOME: request.homeDirectory,
    DSH_AGENTS_HOME: join(request.homeDirectory, 'agents'),
    // Derive from the trusted generation path (core's convention), not from
    // `dirname(nodeExecutable)`: PATH is a managed mapping key and must match
    // core's baseEnv exactly, while a misplaced nodeExecutable is a separate
    // request-configuration concern.
    PATH: [join(request.generationDirectory, 'node', 'bin'), ...MANAGED_PATH_ENTRIES].join(':'),
    TMPDIR: join(request.homeDirectory, '.tmp'),
  });

  /** Runtime launch policy keys, authoritative and separate from the mapping. */
  const launchPolicy = (): Record<string, string> => ({
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
  });

  const captureIdentity = async (
    pid: number,
    commandFragment: string,
  ): Promise<ProcessIdentity | undefined> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const info = probe.inspect(pid);
      if (info !== undefined) {
        return {
          pid,
          pgid: info.pgid,
          startToken: info.startToken,
          commandFragment,
          createdAt: new Date().toISOString(),
        };
      }
      // The process dying is a definite failure; a transiently unreadable
      // living pid (for example `ps` racing the fork) is retried until the
      // deadline instead of giving up immediately.
      if (!isProcessAlive(pid)) {
        return undefined;
      }
      if (Date.now() >= deadline) {
        return undefined;
      }
      await delay(25);
    }
  };

  const terminate = async (
    pid: number,
    pgid: number,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (signal === undefined || !signal.aborted) {
      signalProcessTree({ pid, pgid }, 'SIGTERM', { group: true });
      if (await waitForProcessExit(pid, stopGraceMs)) {
        return true;
      }
    }
    killProcessTreeSync({ pid, pgid }, { group: true });
    return waitForProcessExit(pid, confirmMs);
  };

  /**
   * Resolves the descendant tree of a launch whose leader is no longer owned.
   *
   * Cleanup never keys off the dead leader's pid: every live member of the
   * recorded group must carry the launch's own evidence (command fragment or
   * generation directory) before it is signalled. Unprovable survivors make the
   * result unverifiable so `close` refuses to report success.
   */
  const cleanupGoneLeader = async (
    record: ProcessLaunchRecord,
    identity: ProcessIdentity,
    verdict: OwnershipVerdict,
  ): Promise<LeftoverCleanupResult> =>
    cleanupLostLeaderTree({
      probe,
      pgid: identity.pgid,
      leaderReason: verdict.reason,
      leaderIdentity: identity,
      commandFragment: record.commandFragment,
      generationDirectory: record.generationDirectory,
      capturedSurvivors: record.observedSurvivors,
      confirmMs,
    });

  const waitForReadiness = (
    child: ChildProcess,
    signal: AbortSignal,
  ): Promise<ReadinessResult> => {
    if (signal.aborted) {
      return Promise.resolve({ kind: 'aborted' });
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({
        kind: 'exit',
        exitCode: child.exitCode,
        signal: child.signalCode,
        output: '',
      });
    }
    return new Promise<ReadinessResult>((resolve) => {
      let settled = false;
      let probing = false;
      let stdout = '';
      let stderr = '';
      const finish = (result: ReadinessResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('exit', onExit);
        child.off('error', onError);
        resolve(result);
      };
      const onAbort = (): void => {
        finish({ kind: 'aborted' });
      };
      const consider = (): void => {
        if (probing || settled) {
          return;
        }
        const target = parseReadyTarget(stdout);
        if (target === undefined) {
          return;
        }
        probing = true;
        void probeLoopbackTcp(target.host, target.port, 3_000).then((ok) => {
          finish(ok ? { kind: 'ready', target } : { kind: 'loopback-failed', target });
        });
      };
      const onStdout = (chunk: Buffer): void => {
        stdout = appendBounded(stdout, chunk);
        consider();
      };
      const onStderr = (chunk: Buffer): void => {
        stderr = appendBounded(stderr, chunk);
      };
      const onExit = (code: number | null, sig: NodeJS.Signals | null): void => {
        finish({ kind: 'exit', exitCode: code, signal: sig, output: `${stdout}\n${stderr}` });
      };
      const onError = (): void => {
        finish({ kind: 'spawn-error' });
      };
      const timer = setTimeout(() => {
        finish({ kind: 'timeout' });
      }, readinessTimeoutMs);

      signal.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  };

  const watchExit = (child: ChildProcess, record: ProcessLaunchRecord): void => {
    child.stdout?.resume();
    child.stderr?.resume();
    const environmentId = record.environmentId;
    const expectedPid = record.identity?.pid;
    child.once('exit', (code, sig) => {
      bootstraps.delete(environmentId);
      const current = launches.read(environmentId);
      if (current === undefined || current.state !== 'running') {
        return;
      }
      if (expectedPid !== undefined && current.identity?.pid !== expectedPid) {
        return;
      }
      // Mark the launch stopped. Descendants left in the recorded process group
      // are resolved by `stop()`, `close()` and `recover()`, which all treat a
      // stopped record with live group members as unfinished cleanup (and fail
      // rather than report success when they cannot prove ownership).
      // Capture the survivor identities while the group is still observable,
      // then mark stopped. These captured identities are the only member
      // evidence a later cleanup may rely on besides the command/generation
      // link; a member's own start time is never sufficient.
      const captured =
        record.identity === null
          ? null
          : captureGroupSurvivors(probe, record.identity.pgid, record.commandFragment);
      launches.write(
        patch(current, {
          state: 'stopped',
          exitCode: code,
          observedSurvivors: captured,
          errorCode: 'PROCESS_EXITED',
        }),
      );
      // An unexpected exit can orphan descendants in our process group. Resolve
      // the provable ones now (bounded window), and mark the record
      // unverifiable if any survivor cannot be proven so a later close()
      // refuses to report success.
      if (record.identity !== null) {
        const cleanup = cleanupLostLeaderTree({
          probe,
          pgid: record.identity.pgid,
          leaderReason: 'dead',
          leaderIdentity: record.identity,
          commandFragment: record.commandFragment,
          generationDirectory: record.generationDirectory,
          capturedSurvivors: captured,
          confirmMs,
        }).then((result) => {
          if (result.ok) {
            return;
          }
          const latest = launches.read(environmentId);
          if (latest !== undefined) {
            launches.write(patch(latest, { state: 'unverifiable' }));
          }
        });
        tracked(cleanup);
      }
      if (!closed && onProcessExit !== undefined && expectedPid !== undefined) {
        const event: ProcessExitEvent = {
          environmentId,
          pid: expectedPid,
          exitCode: code,
          signal: sig,
        };
        try {
          onProcessExit(event);
        } catch {
          // Persisting the exit is best effort; the record is already updated.
        }
      }
    });
  };

  const start = (request: ProcessLifecycleRequest): Promise<PortOutcome<ProcessStartOutcome>> => {
    const environmentId = request.environmentId;
    if (closed) {
      return Promise.resolve(portFail('INTERNAL_ERROR', 'the process manager is closed'));
    }
    if (active.has(environmentId)) {
      return Promise.resolve(
        portFail('ENVIRONMENT_BUSY', 'a start or stop is already in progress'),
      );
    }
    if (request.installMode !== 'npm-ci') {
      return Promise.resolve(
        portFail('INTERNAL_ERROR', 'the generation is not a complete managed install'),
      );
    }

    const controller = new AbortController();
    active.set(environmentId, { kind: 'start', controller });
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const task = (async (): Promise<PortOutcome<ProcessStartOutcome>> => {
      try {
        const previous = launches.read(environmentId);
        if (previous?.identity !== null && previous?.identity !== undefined) {
          const verdict = verifyIdentity(probe, previous.identity);
          if (verdict.owned) {
            return portFail(
              'ENVIRONMENT_BUSY',
              'a managed process is already running for this environment',
            );
          }
          if (!identityIsGone(verdict)) {
            // A live pid we cannot prove is ours must be reconciled first; the
            // previous ownership record is kept, never overwritten.
            return portFail(
              'INTERNAL_ERROR',
              'a previous process could not be verified; reconcile before starting',
            );
          }
          // The previous leader is gone, but its detached group may still hold
          // descendants. Resolve them (using the previous record's evidence)
          // before the new spawn overwrites the record; otherwise a later
          // close() would only see the new group and leave the old orphans.
          const cleanup = await cleanupGoneLeader(previous, previous.identity, verdict);
          if (!cleanup.ok) {
            return portFail(
              'INTERNAL_ERROR',
              'a previous managed process tree could not be resolved; reconcile before starting',
            );
          }
        }
        return await runStart(request, signal);
      } finally {
        if (active.get(environmentId)?.controller === controller) {
          active.delete(environmentId);
        }
      }
    })();
    return tracked(task);
  };

  const runStart = async (
    request: ProcessLifecycleRequest,
    signal: AbortSignal,
  ): Promise<PortOutcome<ProcessStartOutcome>> => {
    // Replacing this environment's launch invalidates any previous in-memory
    // bootstrap before the new record is written.
    bootstraps.delete(request.environmentId);
    const now = new Date().toISOString();
    let record: ProcessLaunchRecord = {
      schemaVersion: '1',
      environmentId: request.environmentId,
      expectedRevision: request.expectedRevision,
      generationDirectory: request.generationDirectory,
      commandFragment: request.dshEntrypoint,
      state: 'spawning',
      identity: null,
      endpoint: null,
      exitCode: null,
      observedSurvivors: null,
      errorCode: null,
      errorDetail: null,
      createdAt: now,
      updatedAt: now,
      sequence: 0,
    };
    launches.write(record);
    emitPhase(request, 'spawning');

    if (signal.aborted) {
      return failStart(record, 'INTERNAL_ERROR', 'the start was cancelled');
    }

    let resolved: unknown;
    try {
      resolved = await credentials.resolveLaunchEnvironment(request.environmentId);
    } catch {
      return failStart(record, 'INTERNAL_ERROR', 'managed credential resolution failed');
    }
    // The port is injected by the composition root, so its runtime shape is
    // validated before any field is trusted; a malformed result becomes a
    // controlled INTERNAL_ERROR, never an undefined code/message.
    if (!isCredentialOutcome(resolved)) {
      return failStart(record, 'INTERNAL_ERROR', 'managed credential resolution returned an invalid result');
    }
    if (!resolved.ok) {
      const code = isErrorCode(resolved.code) ? resolved.code : 'INTERNAL_ERROR';
      const message =
        typeof resolved.message === 'string' && resolved.message.length > 0
          ? resolved.message
          : 'managed credential resolution failed';
      return failStart(record, code, message);
    }

    // Credential plaintext exists only between resolution and `spawn`. The
    // explicit child environment is copied into the spawn call synchronously;
    // `dispose()` (which erases any internal credential material) runs in the
    // `finally` for success, isolation rejection, spawn error and cancellation,
    // and the local child-environment copy is cleared at the same point. Nothing
    // here is persisted, logged or captured by a long-lived closure.
    const launchEnvironment = resolved.value;
    if (!isLaunchEnvironmentHandle(launchEnvironment)) {
      return failStart(
        record,
        'INTERNAL_ERROR',
        'managed credential resolution returned an invalid environment',
      );
    }
    let child: ChildProcess | undefined;
    try {
      if (signal.aborted) {
        return failStart(record, 'INTERNAL_ERROR', 'the start was cancelled');
      }
      const portArgument =
        request.port === undefined || request.port === 'auto' ? '0' : String(request.port);
      const args = [
        request.dshEntrypoint,
        // P-A: boot the generation-scoped managed profile. `web` is the shipped
        // alias/default and keeps generations with no published profile working.
        '--profile',
        request.profileName ?? 'web',
        '--no-open',
        '--host',
        '127.0.0.1',
        '--port',
        portArgument,
      ];
      const managed = managedEnvironment(request);
      // The single five-key managed mapping is derived from the trusted request
      // paths and matches core's `launchCredentialRequest` baseEnv (HOME,
      // DSH_HOME, DSH_AGENTS_HOME, PATH, TMPDIR). A provided managed key must
      // agree exactly: a mismatch is a wiring error and fails closed before
      // spawn (so dispose() still runs), instead of silently overwriting it.
      for (const [key, expected] of Object.entries(managed)) {
        const provided = launchEnvironment.env[key];
        if (provided !== undefined && provided !== expected) {
          return failStart(
            record,
            'INTERNAL_ERROR',
            `the launch environment disagrees with the managed ${key}`,
          );
        }
      }
      // Credential variables may only add non-managed keys; the managed mapping
      // and the runtime launch policy are authoritative for their own keys.
      const childEnvironment: Record<string, string> = {
        ...managed,
        ...launchEnvironment.env,
        ...launchPolicy(),
      };
      try {
        child = spawn(request.nodeExecutable, args, {
          cwd: request.dataDirectory,
          env: childEnvironment,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // A permanent listener prevents an unhandled 'error' event when the
        // executable cannot be spawned; the readiness waiter (or the pid check
        // below) observes the failure.
        child.on('error', () => {
          // observed via waitForReadiness / pid check
        });
      } finally {
        for (const key of Object.keys(childEnvironment)) {
          childEnvironment[key] = '';
        }
      }
    } catch {
      return failStart(record, 'INTERNAL_ERROR', 'the managed process could not be spawned');
    } finally {
      try {
        launchEnvironment.dispose();
      } catch {
        // Credential cleanup is best effort; it must not mask the outcome.
      }
    }
    if (child === undefined) {
      return failStart(record, 'INTERNAL_ERROR', 'the managed process could not be spawned');
    }
    const pid = child.pid;
    if (pid === undefined) {
      return failStart(record, 'INTERNAL_ERROR', 'the managed process did not report a pid');
    }

    const identity = await captureIdentity(pid, request.dshEntrypoint);
    if (identity === undefined) {
      killProcessTreeSync({ pid }, { group: true });
      await waitForProcessExit(pid, confirmMs);
      return failStart(
        record,
        'INTERNAL_ERROR',
        'the managed process identity could not be captured',
      );
    }
    record = patch(record, { state: 'starting', identity });
    launches.write(record);
    emitPhase(request, 'waiting-ready');

    const readiness = await waitForReadiness(child, signal);
    if (readiness.kind === 'ready' && !signal.aborted) {
      record = patch(record, {
        state: 'running',
        endpoint: {
          origin: readiness.target.origin,
          host: readiness.target.host,
          port: readiness.target.port,
        },
      });
      launches.write(record);
      // Hold the bootstrap URL in memory only, bound to this launch identity
      // and verified loopback endpoint. It is never written to the record.
      bootstraps.set(request.environmentId, {
        url: readiness.target.bootstrapUrl,
        origin: readiness.target.origin,
        host: readiness.target.host,
        port: readiness.target.port,
        pid: identity.pid,
        startToken: identity.startToken,
      });
      emitPhase(request, 'running');
      watchExit(child, record);
      return portOk({ pid, loopbackOrigin: readiness.target.origin });
    }

    // Every failure path terminates our own tree before the promise resolves.
    await terminate(pid, identity.pgid);
    switch (readiness.kind) {
      case 'ready':
        return failStart(record, 'INTERNAL_ERROR', 'the start was cancelled after readiness');
      case 'aborted':
        return failStart(record, 'INTERNAL_ERROR', 'the start was cancelled');
      case 'timeout':
        return failStart(
          record,
          'START_TIMEOUT',
          'the managed process did not become ready in time',
        );
      case 'spawn-error':
        return failStart(record, 'INTERNAL_ERROR', 'the managed process could not be spawned');
      case 'loopback-failed':
        return failStart(
          record,
          'INTERNAL_ERROR',
          'the ready endpoint did not answer on loopback',
        );
      case 'exit': {
        if (/EADDRINUSE/.test(readiness.output)) {
          return failStart(record, 'PORT_UNAVAILABLE', 'the requested port is already in use');
        }
        return failStart(
          record,
          'PROCESS_EXITED',
          'the managed process exited before it became ready',
        );
      }
    }
  };

  const stop = (request: ProcessLifecycleRequest): Promise<PortOutcome<ProcessStopOutcome>> => {
    const environmentId = request.environmentId;
    if (closed) {
      return Promise.resolve(portFail('INTERNAL_ERROR', 'the process manager is closed'));
    }
    if (active.has(environmentId)) {
      return Promise.resolve(
        portFail('ENVIRONMENT_BUSY', 'a start or stop is already in progress'),
      );
    }
    const controller = new AbortController();
    active.set(environmentId, { kind: 'stop', controller });
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const task = runStop(request, signal).finally(() => {
      if (active.get(environmentId)?.controller === controller) {
        active.delete(environmentId);
      }
    });
    return tracked(task);
  };

  const runStop = async (
    request: ProcessLifecycleRequest,
    signal: AbortSignal,
  ): Promise<PortOutcome<ProcessStopOutcome>> => {
    const environmentId = request.environmentId;
    // Stopping invalidates any held WebUI bootstrap for this environment.
    bootstraps.delete(environmentId);
    const record = launches.read(environmentId);
    if (record === undefined) {
      return portFail('INTERNAL_ERROR', 'no managed process is recorded for this environment');
    }
    const identity = record.identity;
    if (identity === null) {
      const scan = findOwnedProcessesDetailed(probe, record.commandFragment, record.generationDirectory);
      if (!scan.ok) {
        // The scan or a candidate could not be read: nothing was proven, so this
        // must not be reported as "already stopped".
        launches.write(patch(record, { state: 'unverifiable' }));
        return portFail(
          'INTERNAL_ERROR',
          'the managed process scan is unavailable; nothing was proven',
        );
      }
      if (scan.processes.length === 0) {
        // A verified empty scan is a legitimate "nothing to stop".
        launches.write(patch(record, { state: 'stopped' }));
        return portOk({ wasRunning: false });
      }
      // A candidate exists but the identity was never captured, so command and
      // directory matches are not proof of ownership (a decoy can share both).
      // Never signal an unverified process: fail closed and retain the record.
      launches.write(patch(record, { state: 'unverifiable' }));
      return portFail(
        'INTERNAL_ERROR',
        'an unverified managed process is present and was not signalled',
      );
    }

    const verdict = verifyIdentity(probe, identity);
    if (identityIsGone(verdict)) {
      const cleanup = await cleanupGoneLeader(record, identity, verdict);
      if (!cleanup.ok) {
        launches.write(patch(record, { state: 'unverifiable' }));
        return portFail(
          'INTERNAL_ERROR',
          'the managed process tree could not be confirmed exited',
        );
      }
      launches.write(patch(record, { state: 'stopped' }));
      return portOk({ wasRunning: false, pid: identity.pid });
    }
    if (!verdict.owned) {
      launches.write(patch(record, { state: 'unverifiable' }));
      return portFail(
        'INTERNAL_ERROR',
        'the recorded process identity no longer matches; it was not signalled',
      );
    }

    launches.write(patch(record, { state: 'stopping' }));
    emitPhase(request, 'stopping');
    const exited = await terminate(identity.pid, identity.pgid, signal);
    if (!exited) {
      launches.write(patch(record, { state: 'unverifiable' }));
      return portFail('INTERNAL_ERROR', 'the managed process did not exit after SIGKILL');
    }
    launches.write(patch(record, { state: 'stopped' }));
    return portOk({ pid: identity.pid, wasRunning: true });
  };

  const openWebUI = (environmentId: string): PortOutcome<OpenWebUIResult> => {
    if (closed) {
      return portFail('INTERNAL_ERROR', 'the process manager is closed');
    }
    const record = launches.read(environmentId);
    if (
      record === undefined ||
      record.state !== 'running' ||
      record.endpoint === null ||
      record.identity === null
    ) {
      return portFail(
        'WEBUI_UNAVAILABLE',
        'no verified managed endpoint is recorded for this environment',
      );
    }
    if (!isManagedLoopbackOrigin(record.endpoint.origin)) {
      return portFail('WEBUI_UNAVAILABLE', 'the recorded endpoint is not a canonical loopback origin');
    }
    const verdict = verifyIdentity(probe, record.identity);
    if (!verdict.owned) {
      return portFail(
        'WEBUI_UNAVAILABLE',
        'the managed process for this endpoint is no longer verified',
      );
    }
    return portOk({ loopbackOrigin: record.endpoint.origin });
  };

  const recover = async (): Promise<ProcessRecoveryReport> => {
    if (closed) {
      return { entries: [] };
    }
    return reconcileRuntimeState({
      dataRoot,
      launches,
      probe,
      stopGraceMs,
      confirmMs,
      ...(isRecoveryPermitted === undefined ? {} : { isPermitted: isRecoveryPermitted }),
    });
  };

  const close = async (): Promise<PortOutcome<void>> => {
    closed = true;
    bootstraps.clear();
    for (const task of active.values()) {
      task.controller.abort();
    }
    await Promise.allSettled([...tasks]);

    const failures: string[] = [];
    for (const record of launches.list()) {
      const identity = record.identity;
      if (identity === null) {
        const scan = findOwnedProcessesDetailed(probe, record.commandFragment, record.generationDirectory);
        if (!scan.ok) {
          failures.push('a managed process scan was unavailable');
          continue;
        }
        if (scan.processes.length > 0) {
          // Identity was never captured, so command/directory matches are not
          // proof of ownership (a decoy can share both). Never signal; retain
          // the record and fail close so the data-root lock is not released.
          failures.push('an unverified managed process is present and was not signalled');
        }
        continue;
      }
      const verdict = verifyIdentity(probe, identity);
      if (verdict.owned) {
        if (!(await terminate(identity.pid, identity.pgid))) {
          failures.push('a managed process did not exit');
          continue;
        }
      } else if (!verdict.alive) {
        const cleanup = await cleanupGoneLeader(record, identity, verdict);
        if (!cleanup.ok) {
          failures.push('a managed process tree could not be confirmed exited');
          continue;
        }
      } else {
        failures.push('a managed process identity could not be verified');
        continue;
      }
      // A successful close means no own descendant remains in the recorded
      // group; a scan failure or a live member is a failure, never success.
      const leftovers = readGroupLeftovers(probe, identity.pgid);
      if (leftovers === undefined || leftovers.length > 0) {
        failures.push('a managed process group still has live members');
        continue;
      }
      const current = launches.read(record.environmentId);
      if (current !== undefined) {
        launches.write(patch(current, { state: 'stopped' }));
      }
    }

    for (const { journal } of listInstallChildJournals(dataRoot)) {
      for (const child of journal.list()) {
        const verdict = verifyIdentity(probe, {
          pid: child.pid,
          pgid: child.pgid,
          startToken: child.startToken,
          commandFragment: child.commandFragment,
          createdAt: child.createdAt,
        });
        if (identityIsGone(verdict)) {
          journal.remove(child.token);
          continue;
        }
        if (!verdict.owned) {
          failures.push('an installation process identity could not be verified');
          continue;
        }
        if (await terminate(child.pid, child.pgid)) {
          journal.remove(child.token);
        } else {
          failures.push('an installation process did not exit');
        }
      }
    }

    return failures.length === 0
      ? portOk(undefined)
      : portFail(
          'INTERNAL_ERROR',
          `close did not confirm exit of ${String(failures.length)} managed process(es)`,
        );
  };

  /**
   * Main-only WebUI bootstrap consumption (T006 prerequisite).
   *
   * Re-verifies that the environment is running, that the held bootstrap is
   * bound to the current launch identity and canonical loopback endpoint, and
   * that it is still current after an asynchronous liveness check, then hands
   * the bootstrap URL to `open`. The URL is never returned, logged, persisted or
   * placed in an error/diagnostic. A thrown `open` message is never relayed
   * because it may contain the URL/token.
   */
  const consumeWebUIBootstrap = async (
    environmentId: string,
    open: (bootstrapUrl: string) => void | Promise<void>,
  ): Promise<PortOutcome<void>> => {
    if (closed) {
      return portFail('INTERNAL_ERROR', 'the process manager is closed');
    }
    const record = launches.read(environmentId);
    const entry = bootstraps.get(environmentId);
    if (
      record === undefined ||
      record.state !== 'running' ||
      record.identity === null ||
      record.endpoint === null ||
      entry === undefined
    ) {
      return portFail(
        'WEBUI_UNAVAILABLE',
        'no verified managed WebUI bootstrap is available for this environment',
      );
    }
    if (entry.pid !== record.identity.pid || entry.startToken !== record.identity.startToken) {
      return portFail(
        'WEBUI_UNAVAILABLE',
        'the WebUI bootstrap does not belong to the current managed process',
      );
    }
    if (verifyIdentity(probe, record.identity).owned !== true) {
      return portFail(
        'WEBUI_UNAVAILABLE',
        'the managed process for this WebUI bootstrap is no longer verified',
      );
    }
    if (
      entry.origin !== record.endpoint.origin ||
      entry.host !== record.endpoint.host ||
      entry.port !== record.endpoint.port ||
      !isManagedLoopbackOrigin(entry.origin)
    ) {
      return portFail(
        'WEBUI_UNAVAILABLE',
        'the WebUI bootstrap origin does not match the managed endpoint',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      return portFail('WEBUI_UNAVAILABLE', 'the WebUI bootstrap is not a valid URL');
    }
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.origin !== entry.origin ||
      parsed.hostname !== entry.host ||
      Number(parsed.port) !== entry.port
    ) {
      return portFail('WEBUI_UNAVAILABLE', 'the WebUI bootstrap is not a canonical loopback URL');
    }
    // Final liveness check; then re-validate that the launch is still current so
    // a restart/close during the check cannot open a stale URL.
    if (!(await probeLoopbackTcp(entry.host, entry.port, 2_000))) {
      return portFail('WEBUI_UNAVAILABLE', 'the managed WebUI endpoint is no longer reachable');
    }
    if (closed || bootstraps.get(environmentId) !== entry) {
      return portFail('WEBUI_UNAVAILABLE', 'the managed WebUI bootstrap is no longer current');
    }
    const current = launches.read(environmentId);
    if (
      current === undefined ||
      current.state !== 'running' ||
      current.identity === null ||
      current.identity.pid !== entry.pid ||
      current.identity.startToken !== entry.startToken ||
      verifyIdentity(probe, current.identity).owned !== true
    ) {
      return portFail('WEBUI_UNAVAILABLE', 'the managed WebUI bootstrap is no longer current');
    }
    try {
      await open(entry.url);
    } catch {
      // A thrown open error can contain the URL/token; never relay it.
      return portFail('INTERNAL_ERROR', 'the native WebUI open failed');
    }
    return portOk(undefined);
  };

  return {
    start,
    stop,
    openWebUI,
    recover,
    close,
    consumeWebUIBootstrap,
    launchesDirectory: launches.directory,
    readLaunchRecord: (environmentId) => launches.read(environmentId),
    listLaunchRecords: () => launches.list(),
  };
};
