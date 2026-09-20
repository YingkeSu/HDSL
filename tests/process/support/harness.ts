/**
 * Shared harness for T005 process tests.
 *
 * The managed "nodeExecutable + dshEntrypoint" pair is the real Node binary and
 * a controlled fake DSH script, so the manager exercises its real spawn,
 * readiness, ownership and tree-termination code without pretending a fixture
 * is the real upstream CLI. The credential port is stubbed; the opt-in
 * `real-process.evidence.test.ts` covers the real DSH + adapter path.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import {
  createPosixProcessProbe,
  createProcessManager,
  type LaunchCredentialPort,
  type LaunchEnvironmentHandle,
  type ProcessExitEvent,
  type ProcessLifecycleRequest,
  type ProcessManager,
  type ProcessIdentity,
  type ProcessLaunchRecord,
  type ProcessProbe,
} from '@hdsl/runtime';

export const FAKE_DSH_PATH = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url));

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('waitFor timed out');
    }
    await delay(intervalMs);
  }
};

export interface HarnessOptions {
  readonly mode?: string;
  readonly exitAfterReadyMs?: number;
  /** `false` makes credential resolution fail (no reference). */
  readonly credential?: string | false;
  readonly platform?: 'darwin' | 'win32' | 'linux';
  readonly readinessTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly confirmMs?: number;
  readonly isRecoveryPermitted?: () => boolean;
  readonly onProcessExit?: (event: ProcessExitEvent) => void;
  readonly probe?: ProcessProbe;
}

export interface Harness {
  readonly dataRoot: string;
  readonly environmentId: string;
  readonly generationDirectory: string;
  readonly homeDirectory: string;
  readonly dataDirectory: string;
  readonly infoFile: string;
  readonly manager: ProcessManager;
  /** Number of times the credential handle's `dispose()` was invoked. */
  credentialDisposals(): number;
  request(overrides?: Partial<ProcessLifecycleRequest>): ProcessLifecycleRequest;
  readInfo(): Record<string, unknown> | undefined;
  waitForInfo(timeoutMs?: number): Promise<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

export const createHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-t005-'));
  const environmentId = 'envtest0001';
  const generationId = 'gentest0001';
  const generationDirectory = join(dataRoot, 'environments', environmentId, 'generations', generationId);
  const homeDirectory = join(generationDirectory, 'home');
  const configDirectory = join(generationDirectory, 'config');
  const dataDirectory = join(generationDirectory, 'data');
  for (const directory of [homeDirectory, configDirectory, dataDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  const infoFile = join(dataRoot, 'fake-dsh-info.json');
  // Each harness gets its own copy under the generation directory so the launch
  // record's command fragment is unique to this environment. A shared fixture
  // path would let one environment's identity-free cleanup scan match another
  // environment's live process.
  const localFakeDsh = join(generationDirectory, 'fake-dsh.mjs');
  copyFileSync(FAKE_DSH_PATH, localFakeDsh);

  const mode = options.mode ?? 'ready';
  const credential = options.credential ?? 'canary-model-key';
  let credentialDisposals = 0;
  const credentials: LaunchCredentialPort = {
    resolveLaunchEnvironment: async (): Promise<PortOutcome<LaunchEnvironmentHandle>> => {
      if (credential === false) {
        return portFail('INTERNAL_ERROR', 'no managed credential reference is configured');
      }
      const extra: Record<string, string> = {
        DEEPSEEK_API_KEY: credential,
        FAKE_DSH_MODE: mode,
        FAKE_DSH_INFO_FILE: infoFile,
      };
      if (options.exitAfterReadyMs !== undefined) {
        extra['FAKE_DSH_EXIT_AFTER_READY_MS'] = String(options.exitAfterReadyMs);
      }
      return portOk({
        env: extra,
        dispose: () => {
          credentialDisposals += 1;
          for (const key of Object.keys(extra)) {
            extra[key] = '';
          }
        },
      });
    },
  };

  const manager = createProcessManager({
    dataRoot,
    credentials,
    readinessTimeoutMs: options.readinessTimeoutMs ?? 10_000,
    stopGraceMs: options.stopGraceMs ?? 500,
    confirmMs: options.confirmMs ?? 3_000,
    ...(options.isRecoveryPermitted === undefined
      ? {}
      : { isRecoveryPermitted: options.isRecoveryPermitted }),
    ...(options.onProcessExit === undefined ? {} : { onProcessExit: options.onProcessExit }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  });

  const request = (
    overrides: Partial<ProcessLifecycleRequest> = {},
  ): ProcessLifecycleRequest => ({
    environmentId,
    expectedRevision: 1,
    generationDirectory,
    homeDirectory,
    configDirectory,
    dataDirectory,
    nodeExecutable: process.execPath,
    dshEntrypoint: localFakeDsh,
    installMode: 'npm-ci',
    signal: new AbortController().signal,
    ...overrides,
  });

  const readInfo = (): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(readFileSync(infoFile, 'utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  return {
    dataRoot,
    environmentId,
    generationDirectory,
    homeDirectory,
    dataDirectory,
    infoFile,
    manager,
    credentialDisposals: () => credentialDisposals,
    request,
    readInfo,
    waitForInfo: async (timeoutMs = 5_000) => {
      await waitFor(() => readInfo() !== undefined, timeoutMs);
      const info = readInfo();
      if (info === undefined) {
        throw new Error('fake DSH did not write its info file');
      }
      return info;
    },
    cleanup: async () => {
      const info = readInfo();
      const grandchildPid = info?.['grandchildPid'];
      if (typeof grandchildPid === 'number') {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      await manager.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
};

/** Creates the parent directory of a path (used for journal assertions). */
export const parentOf = (path: string): string => dirname(path);

/** Writes a durable launch record directly, to seed restart scenarios. */
export const writeLaunchRecord = (
  dataRoot: string,
  record: ProcessLaunchRecord,
): void => {
  const directory = join(dataRoot, 'process', 'launches');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${record.environmentId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
};

export const launchFixture = (
  dataRoot: string,
  environmentId: string,
  overrides: Partial<ProcessLaunchRecord> = {},
): ProcessLaunchRecord => ({
  schemaVersion: '1',
  environmentId,
  expectedRevision: 1,
  generationDirectory: join(dataRoot, 'environments', environmentId, 'generations', 'gentest0001'),
  commandFragment: process.execPath,
  state: 'running',
  identity: null,
  endpoint: null,
  exitCode: null,
  errorCode: null,
  errorDetail: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sequence: 1,
  ...overrides,
});

export interface DetachedProcess {
  readonly pid: number;
  readonly identity: ProcessIdentity;
  kill(): void;
  isAlive(): boolean;
}

/** Spawns a real detached process in its own group and returns its kernel identity. */
export const spawnDetachedProcess = async (
  script = 'setInterval(() => {}, 1 << 30)',
): Promise<DetachedProcess> => {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('failed to spawn a detached process');
  }
  child.unref();
  const probe = createPosixProcessProbe();
  const deadline = Date.now() + 3_000;
  let info = probe.inspect(pid);
  while (info === undefined && Date.now() < deadline) {
    await delay(25);
    info = probe.inspect(pid);
  }
  if (info === undefined) {
    throw new Error('failed to inspect the detached process');
  }
  const isAlive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    pid,
    identity: {
      pid,
      pgid: info.pgid,
      startToken: info.startToken,
      commandFragment: process.execPath,
      createdAt: new Date().toISOString(),
    },
    kill: () => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    },
    isAlive,
  };
};
