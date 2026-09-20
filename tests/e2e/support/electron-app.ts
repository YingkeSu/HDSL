/**
 * Real Electron app launcher for the desktop E2E slice.
 *
 * QA launches the candidate's own built app (`apps/desktop` with its pinned
 * Electron 44.4.3) against a disposable data-root/user-data pair and a free CDP
 * port, then drives the real renderer. It reuses the candidate's documented
 * entry contract (`--hdsl-data-root`, `--user-data-dir`, `--remote-debugging-port`)
 * instead of inventing its own flags, and registers the child process plus temp
 * directories so they are always released.
 *
 * `electronExecutable()` resolves the pinned binary through the app's own
 * dependency and lazily triggers the download on first use; the non-mutating
 * `electronBinaryPresent()` is what the always-on harness self-check may call.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { connectCdp, type CdpClient } from './cdp.js';
import { REPO_ROOT } from './desktop-candidate.js';
import type { QaResourceRegistry } from './resources.js';

export const APP_ROOT = join(REPO_ROOT, 'apps', 'desktop');

/** Test-only headless injection entry (never the package `main`). */
export const QA_ENTRY = join(APP_ROOT, 'dist', 'main', 'qa-entry.js');

/** Resolves the pinned Electron binary (may download it on first call). */
export const electronExecutable = (): string => {
  const requireFromDesktop = createRequire(join(APP_ROOT, 'package.json'));
  return requireFromDesktop('electron') as string;
};

/** Non-mutating check: has the Electron binary already been fetched? */
export const electronBinaryPresent = (): boolean =>
  existsSync(join(APP_ROOT, 'node_modules', 'electron', 'dist'));

export interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface LaunchOptions {
  readonly registry: QaResourceRegistry;
  readonly label: string;
  /** Entry script passed to Electron; defaults to the app package. */
  readonly entry?: string;
  /** Reuse an existing (already registered) data root, e.g. for contention. */
  readonly dataRoot?: string;
  readonly userDataDir?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extraArgs?: readonly string[];
  readonly cdpPort?: number;
}

export interface DesktopApp {
  readonly label: string;
  readonly dataRoot: string;
  readonly userDataDir: string;
  readonly cdpPort: number;
  readonly pid: number;
  output(): string;
  isRunning(): boolean;
  exitInfo(): ExitInfo | null;
  waitForPageTarget(timeoutMs?: number): Promise<CdpTarget>;
  connect(timeoutMs?: number): Promise<CdpClient>;
  waitForExit(timeoutMs: number): Promise<ExitInfo>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

const freeLoopbackPort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

const fetchTargets = async (port: number): Promise<readonly CdpTarget[]> => {
  try {
    // Bounded: a second instance blocked on a native modal still has a
    // listening debug port but never answers, so an unbounded fetch would hang.
    const response = await fetch(`http://127.0.0.1:${String(port)}/json`, {
      signal: AbortSignal.timeout(2_000),
    });
    const parsed: unknown = await response.json();
    return Array.isArray(parsed) ? (parsed as CdpTarget[]) : [];
  } catch {
    return [];
  }
};

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const launchDesktopApp = async (options: LaunchOptions): Promise<DesktopApp> => {
  const dataRoot = options.dataRoot ?? options.registry.registerTempRoot(`${options.label}-data`);
  const userDataDir =
    options.userDataDir ?? options.registry.registerTempRoot(`${options.label}-userdata`);
  const cdpPort = options.cdpPort ?? (await freeLoopbackPort());
  const args = [
    options.entry ?? APP_ROOT,
    '--hdsl-data-root',
    dataRoot,
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${String(cdpPort)}`,
    ...(options.extraArgs ?? []),
  ];
  const child = spawn(electronExecutable(), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let exit: ExitInfo | null = null;
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    });
  });

  const kill = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill(signal);
    await Promise.race([exited, delay(3_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(2_000)]);
    }
  };

  const app: DesktopApp = {
    label: options.label,
    dataRoot,
    userDataDir,
    cdpPort,
    pid: child.pid ?? -1,
    output: () => output,
    isRunning: () => child.exitCode === null && child.signalCode === null,
    exitInfo: () => exit,
    waitForPageTarget: async (timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const targets = await fetchTargets(cdpPort);
        const page = targets.find((target) => target.type === 'page');
        if (page !== undefined) {
          return page;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `${options.label}: electron exited before a page target appeared (${JSON.stringify(exit)})\n${output}`,
          );
        }
        await delay(250);
      }
      throw new Error(`${options.label}: no page target within ${String(timeoutMs)}ms\n${output}`);
    },
    connect: async (timeoutMs = 30_000) => {
      const page = await app.waitForPageTarget(timeoutMs);
      return await connectCdp(page.webSocketDebuggerUrl);
    },
    waitForExit: async (timeoutMs: number) => {
      const timeout = delay(timeoutMs).then((): ExitInfo => {
        throw new Error(`${options.label}: process did not exit within ${String(timeoutMs)}ms`);
      });
      return await Promise.race([exited, timeout]);
    },
    kill,
  };

  options.registry.register(`${options.label}-process`, async () => {
    await kill();
  });

  return app;
};

