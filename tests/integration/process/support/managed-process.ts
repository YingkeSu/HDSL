/**
 * QA-owned harness for the managed DSH process lifecycle (issue #45).
 *
 * Drives the public `createProcessManager` from `@hdsl/runtime` (T005 candidate,
 * session hdsl-20) with the QA fixture process (`fixture-process.mjs`) acting as
 * the managed DSH entrypoint. The fixture emits the real readiness line, binds
 * loopback, spawns a grandchild and honours SIGTERM, so ownership, tree stop,
 * readiness, port conflict, timeout and crash can be observed end to end.
 *
 * The credential port is a QA fake that injects only fixture-control variables;
 * it is never cited as credential acceptance (that stricter `service#account`
 * case is a separate slice from session hdsl-22).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portOk, type PortOutcome } from '@hdsl/contracts';
import {
  createPosixProcessProbe,
  createProcessManager,
  type LaunchCredentialPort,
  type LaunchEnvironment,
  type ProcessLaunchRecord,
  type ProcessManager,
  type ProcessLifecycleRequest,
  type ProcessProbe,
} from '@hdsl/runtime';

export const FIXTURE_SCRIPT = fileURLToPath(new URL('./fixture-process.mjs', import.meta.url));

export const qaCredentialPort = (env: Readonly<Record<string, string>>): LaunchCredentialPort => ({
  resolveLaunchEnvironment: async (): Promise<PortOutcome<LaunchEnvironment>> => {
    const handle: LaunchEnvironment = {
      env,
      injectedVariables: Object.keys(env),
      dispose: () => {
        // no transient secret in the fixture port
      },
    };
    return portOk(handle);
  },
});

export interface ProcessHarnessOptions {
  readonly dataRoot?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly readinessTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly confirmMs?: number;
  /** Override the process probe (e.g. a failed-scan probe for QA). */
  readonly probe?: ProcessProbe;
}

export interface ProcessHarness {
  readonly dataRoot: string;
  readonly manager: ProcessManager;
  readonly exits: { environmentId: string; pid?: number; exitCode?: number | null; signal?: string | null }[];
  request(environmentId: string, overrides?: Partial<ProcessLifecycleRequest>): ProcessLifecycleRequest;
  readLaunch(environmentId: string): ProcessLaunchRecord | undefined;
  cleanup(): Promise<void>;
}

const roots: string[] = [];

export const cleanupProcessRoots = (): void => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
};

export const createProcessHarness = (options: ProcessHarnessOptions = {}): ProcessHarness => {
  const dataRoot = options.dataRoot ?? mkdtempSync(join(tmpdir(), 'hdsl-proc-managed-'));
  roots.push(dataRoot);
  const exits: ProcessHarness['exits'] = [];
  const manager = createProcessManager({
    dataRoot,
    credentials: qaCredentialPort(options.env ?? {}),
    probe: options.probe ?? createPosixProcessProbe(),
    ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    ...(options.confirmMs === undefined ? {} : { confirmMs: options.confirmMs }),
    onProcessExit: (event) => {
      exits.push({
        environmentId: event.environmentId,
        pid: event.pid,
        exitCode: event.exitCode,
        signal: event.signal,
      });
    },
  });

  const request = (
    environmentId: string,
    overrides: Partial<ProcessLifecycleRequest> = {},
  ): ProcessLifecycleRequest => {
    const generationDirectory = join(dataRoot, 'generations', environmentId);
    const homeDirectory = join(dataRoot, 'homes', environmentId);
    const configDirectory = join(dataRoot, 'config', environmentId);
    const dataDirectory = join(dataRoot, 'data', environmentId);
    for (const directory of [generationDirectory, homeDirectory, configDirectory, dataDirectory]) {
      mkdirSync(directory, { recursive: true });
    }
    return {
      environmentId,
      expectedRevision: 1,
      generationDirectory,
      homeDirectory,
      configDirectory,
      dataDirectory,
      nodeExecutable: process.execPath,
      dshEntrypoint: FIXTURE_SCRIPT,
      // The process port only accepts a complete managed install. This QA
      // harness presents a synthetic generation (fixture entrypoint); the
      // evidence is synthetic process behavior, never real DSH.
      installMode: 'npm-ci',
      signal: new AbortController().signal,
      onPhase: () => undefined,
      port: 'auto',
      ...overrides,
    };
  };

  return {
    dataRoot,
    manager,
    exits,
    request,
    readLaunch: (environmentId) => manager.readLaunchRecord(environmentId),
    cleanup: async () => {
      await manager.close().catch(() => undefined);
    },
  };
};
