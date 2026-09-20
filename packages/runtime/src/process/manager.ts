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
import { dirname, join } from 'node:path';
import {
  portFail,
  portOk,
  type ErrorCode,
  type OpenWebUIResult,
  type PortOutcome,
} from '@hdsl/contracts';
import { findOwnedProcesses, identityIsGone, verifyIdentity } from './ownership.js';
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
  parseReadyEndpoint,
  probeLoopbackTcp,
  type ReadyEndpoint,
} from './readiness.js';
import { delay, killProcessTreeSync, signalProcessTree, waitForProcessExit } from './tree.js';
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
  | { readonly kind: 'ready'; readonly endpoint: ReadyEndpoint }
  | {
      readonly kind: 'exit';
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly output: string;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'spawn-error' }
  | { readonly kind: 'loopback-failed'; readonly endpoint: ReadyEndpoint };

interface LaunchPatch {
  readonly state?: ProcessLaunchState;
  readonly identity?: ProcessIdentity | null;
  readonly endpoint?: ProcessEndpoint | null;
  readonly exitCode?: number | null;
  readonly errorCode?: ErrorCode | null;
  readonly errorDetail?: string | null;
}

const OUTPUT_BUFFER_LIMIT = 32 * 1024;
const MANAGED_PATH_SUFFIX = '/usr/bin:/bin:/usr/sbin:/sbin';

const appendBounded = (current: string, chunk: Buffer): string => {
  const next = current + chunk.toString('utf8');
  return next.length > OUTPUT_BUFFER_LIMIT ? next.slice(-OUTPUT_BUFFER_LIMIT) : next;
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

  const managedEnvironment = (request: ProcessLifecycleRequest): Record<string, string> => ({
    HOME: request.homeDirectory,
    DSH_HOME: request.homeDirectory,
    DSH_AGENTS_HOME: join(request.dataDirectory, 'agents-home'),
    PATH: `${dirname(request.nodeExecutable)}${MANAGED_PATH_SUFFIX}`,
    TMPDIR: join(request.homeDirectory, '.tmp'),
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
      if (!(await waitForProcessExit(pid, 0))) {
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
        const endpoint = parseReadyEndpoint(stdout);
        if (endpoint === undefined) {
          return;
        }
        probing = true;
        void probeLoopbackTcp(endpoint.host, endpoint.port, 3_000).then((ok) => {
          finish(ok ? { kind: 'ready', endpoint } : { kind: 'loopback-failed', endpoint });
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
      const current = launches.read(environmentId);
      if (current === undefined || current.state !== 'running') {
        return;
      }
      if (expectedPid !== undefined && current.identity?.pid !== expectedPid) {
        return;
      }
      launches.write(
        patch(current, { state: 'stopped', exitCode: code, errorCode: 'PROCESS_EXITED' }),
      );
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
    const previous = launches.read(environmentId);
    if (previous?.identity !== null && previous?.identity !== undefined) {
      const verdict = verifyIdentity(probe, previous.identity);
      if (verdict.owned) {
        return Promise.resolve(
          portFail('ENVIRONMENT_BUSY', 'a managed process is already running for this environment'),
        );
      }
      // A dead or reused pid is safe to replace; a live pid we cannot prove is
      // ours must be reconciled first, never overwritten.
      if (!identityIsGone(verdict)) {
        return Promise.resolve(
          portFail(
            'INTERNAL_ERROR',
            'a previous process could not be verified; reconcile before starting',
          ),
        );
      }
    }

    const controller = new AbortController();
    active.set(environmentId, { kind: 'start', controller });
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const task = runStart(request, signal).finally(() => {
      if (active.get(environmentId)?.controller === controller) {
        active.delete(environmentId);
      }
    });
    return tracked(task);
  };

  const runStart = async (
    request: ProcessLifecycleRequest,
    signal: AbortSignal,
  ): Promise<PortOutcome<ProcessStartOutcome>> => {
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

    let resolved: PortOutcome<LaunchEnvironmentHandle>;
    try {
      resolved = await credentials.resolveLaunchEnvironment(request.environmentId);
    } catch {
      return failStart(record, 'INTERNAL_ERROR', 'managed credential resolution failed');
    }
    if (!resolved.ok) {
      return failStart(record, resolved.code, resolved.message);
    }

    // Credential plaintext exists only between resolution and `spawn`. The
    // explicit child environment is copied into the spawn call synchronously;
    // `dispose()` (which erases any internal credential material) runs in the
    // `finally` for success, isolation rejection, spawn error and cancellation,
    // and the local child-environment copy is cleared at the same point. Nothing
    // here is persisted, logged or captured by a long-lived closure.
    const launchEnvironment = resolved.value;
    let child: ChildProcess | undefined;
    try {
      if (signal.aborted) {
        return failStart(record, 'INTERNAL_ERROR', 'the start was cancelled');
      }
      const portArgument =
        request.port === undefined || request.port === 'auto' ? '0' : String(request.port);
      const args = [
        request.dshEntrypoint,
        'web',
        '--no-open',
        '--host',
        '127.0.0.1',
        '--port',
        portArgument,
      ];
      const childEnvironment: Record<string, string> = {
        ...managedEnvironment(request),
        ...launchEnvironment.env,
      };
      try {
        const isolationPreserved =
          childEnvironment['HOME'] === request.homeDirectory &&
          childEnvironment['DSH_HOME'] === request.homeDirectory;
        if (!isolationPreserved) {
          return failStart(
            record,
            'INTERNAL_ERROR',
            'the launch environment did not preserve the managed HOME isolation',
          );
        }
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
          origin: readiness.endpoint.origin,
          host: readiness.endpoint.host,
          port: readiness.endpoint.port,
        },
      });
      launches.write(record);
      emitPhase(request, 'running');
      watchExit(child, record);
      return portOk({ pid, loopbackOrigin: readiness.endpoint.origin });
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
    const record = launches.read(environmentId);
    if (record === undefined) {
      return portFail('INTERNAL_ERROR', 'no managed process is recorded for this environment');
    }
    const identity = record.identity;
    if (identity === null) {
      const candidates = findOwnedProcesses(
        probe,
        record.commandFragment,
        record.generationDirectory,
      );
      if (candidates.length === 0) {
        launches.write(patch(record, { state: 'stopped' }));
        return portOk({ wasRunning: false });
      }
      let exitedAll = true;
      for (const info of candidates) {
        exitedAll = (await terminate(info.pid, info.pgid, signal)) && exitedAll;
      }
      launches.write(patch(record, { state: exitedAll ? 'stopped' : 'unverifiable' }));
      return exitedAll
        ? portOk({ wasRunning: true })
        : portFail('INTERNAL_ERROR', 'the recorded process could not be confirmed exited');
    }

    const verdict = verifyIdentity(probe, identity);
    if (identityIsGone(verdict)) {
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
    for (const task of active.values()) {
      task.controller.abort();
    }
    await Promise.allSettled([...tasks]);

    const failures: string[] = [];
    for (const record of launches.list()) {
      const identity = record.identity;
      if (identity === null) {
        const candidates = findOwnedProcesses(
          probe,
          record.commandFragment,
          record.generationDirectory,
        );
        for (const info of candidates) {
          if (!(await terminate(info.pid, info.pgid))) {
            failures.push('an installation process did not exit');
          }
        }
        continue;
      }
      const verdict = verifyIdentity(probe, identity);
      if (identityIsGone(verdict)) {
        continue;
      }
      if (!verdict.owned) {
        failures.push('a managed process identity could not be verified');
        continue;
      }
      if (!(await terminate(identity.pid, identity.pgid))) {
        failures.push('a managed process did not exit');
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

  return {
    start,
    stop,
    openWebUI,
    recover,
    close,
    launchesDirectory: launches.directory,
    readLaunchRecord: (environmentId) => launches.read(environmentId),
    listLaunchRecords: () => launches.list(),
  };
};
