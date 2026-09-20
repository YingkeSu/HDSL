/**
 * T007b — real managed process lifecycle QA (issue #45).
 *
 * Registered against the exact candidate pair recorded by the orchestrator:
 * runtime PR #48 @ `49b5d59938beecf37bd9694e2cbd6bcd87d0afd2` and core PR #49
 * @ `866888402c78ce7bcbd5bcdc4ae1605f3e1091f2`.
 *
 * The managed entrypoint is the QA fixture (`fixture-process.mjs`) in its
 * DSH-compatible mode; it is not real DSH. Scenarios: readiness/stop tree,
 * port conflict, readiness timeout, crash, identity-missing generation safety
 * and unrelated-process ownership.
 */
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createPosixProcessProbe, findOwnedProcesses } from '@hdsl/runtime';

import { isProcessAlive } from './support/identity.js';
import { waitFor } from './support/isolation.js';
import { httpProbe, isLoopbackPortBound, occupyLoopbackPort } from './support/loopback.js';
import {
  cleanupProcessRoots,
  createProcessHarness,
  FIXTURE_SCRIPT,
  type ProcessHarness,
} from './support/managed-process.js';

const harnesses: ProcessHarness[] = [];
const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const build = (options: Parameters<typeof createProcessHarness>[0] = {}): ProcessHarness => {
  const harness = createProcessHarness(options);
  harnesses.push(harness);
  return harness;
};

const infoPathFor = (root: string, environmentId: string): string => join(root, 'info', `${environmentId}.json`);

const readInfo = (path: string): { pid: number; grandchildPid: number | null } | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { pid: number; grandchildPid: number | null };
  } catch {
    return undefined;
  }
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
  for (const child of spawned.splice(0)) {
    child.kill('SIGKILL');
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupProcessRoots();
});

const startReadyHarness = (environmentId: string, infoRoot: string): ProcessHarness => {
  mkdirSync(join(infoRoot, 'info'), { recursive: true });
  return build({
    env: {
      HDSL_QA_DSH_MODE: 'ready',
      HDSL_QA_INFO_FILE: infoPathFor(infoRoot, environmentId),
    },
  });
};

describe('managed process lifecycle QA (PROC)', () => {
  it('PROC-READY-01/TREE-01: starts a loopback-ready process and stops its whole tree', async () => {
    const infoRoot = tempDir('hdsl-proc-info-');
    const harness = startReadyHarness('env-ready', infoRoot);
    const controller = new AbortController();
    const started = await harness.manager.start(harness.request('env-ready', { signal: controller.signal }));
    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.message);
    }
    expect(started.value.pid).toBeGreaterThan(0);
    expect(started.value.loopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const probe = await httpProbe(`${started.value.loopbackOrigin}/`);
    expect(probe.status).toBe(200);

    const infoPath = infoPathFor(infoRoot, 'env-ready');
    await waitFor(() => readInfo(infoPath)?.grandchildPid !== undefined, {
      timeoutMs: 5_000,
      label: 'fixture info written',
    });
    const grandchildPid = readInfo(infoPath)?.grandchildPid;
    expect(grandchildPid).toBeTruthy();
    expect(isProcessAlive(grandchildPid as number)).toBe(true);

    expect(harness.readLaunch('env-ready')?.state).toBe('running');

    const stopped = await harness.manager.stop(harness.request('env-ready'));
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.value.wasRunning).toBe(true);
    }
    await waitFor(() => !isProcessAlive(started.value.pid), { timeoutMs: 5_000, label: 'managed pid gone' });
    await waitFor(() => !isProcessAlive(grandchildPid as number), {
      timeoutMs: 5_000,
      label: 'grandchild gone (tree stop)',
    });
  }, 30_000);

  it('PROC-PORT-01: a pinned occupied port yields PORT_UNAVAILABLE and keeps the occupant alive', async () => {
    const occupied = await occupyLoopbackPort();
    const harness = build({
      env: { HDSL_QA_DSH_MODE: 'ready' },
    });
    try {
      const started = await harness.manager.start(
        harness.request('env-port', { port: occupied.port }),
      );
      expect(started.ok).toBe(false);
      if (!started.ok) {
        expect(started.code).toBe('PORT_UNAVAILABLE');
      }
      expect(await isLoopbackPortBound(occupied.port)).toBe(true);
    } finally {
      await occupied.close();
    }
  }, 30_000);

  it('PROC-TIMEOUT-01: a never-ready process fails START_TIMEOUT and is reaped', async () => {
    const infoRoot = tempDir('hdsl-proc-info-');
    mkdirSync(join(infoRoot, 'info'), { recursive: true });
    const harness = build({
      readinessTimeoutMs: 500,
      env: {
        HDSL_QA_DSH_MODE: 'never-ready',
        HDSL_QA_INFO_FILE: infoPathFor(infoRoot, 'env-timeout'),
        HDSL_QA_NO_GRANDCHILD: '1',
      },
    });
    const started = await harness.manager.start(harness.request('env-timeout'));
    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.code).toBe('START_TIMEOUT');
    }
    const info = readInfo(infoPathFor(infoRoot, 'env-timeout'));
    expect(info?.pid).toBeTruthy();
    await waitFor(() => !isProcessAlive(info?.pid as number), {
      timeoutMs: 5_000,
      label: 'timed-out process reaped',
    });
  }, 30_000);

  it('PROC-CRASH-01: a crashed managed process surfaces PROCESS_EXITED', async () => {
    const infoRoot = tempDir('hdsl-proc-info-');
    mkdirSync(join(infoRoot, 'info'), { recursive: true });
    const harness = build({
      env: {
        HDSL_QA_DSH_MODE: 'crash',
        HDSL_QA_INFO_FILE: infoPathFor(infoRoot, 'env-crash'),
        HDSL_QA_DSH_EXIT: '3',
      },
    });
    const started = await harness.manager.start(harness.request('env-crash'));
    // The fixture prints readiness and then exits non-zero.
    if (started.ok) {
      await waitFor(() => harness.exits.length > 0, { timeoutMs: 5_000, label: 'exit observed' });
      expect(harness.exits[0]?.exitCode).toBe(3);
    } else {
      expect(started.code).toBe('PROCESS_EXITED');
    }
  }, 30_000);

  it('PROC-PID-01: an identity-missing search does not kill a same-fragment different generation', async () => {
    const root = tempDir('hdsl-proc-gen-');
    const sharedFragment = FIXTURE_SCRIPT;
    const generationA = join(root, 'generations', 'gen-a', 'dsh');
    const generationB = join(root, 'generations', 'gen-b', 'dsh');
    for (const directory of [generationA, generationB]) {
      mkdirSync(directory, { recursive: true });
    }

    const spawnWithGeneration = (generation: string, port: number): ChildProcess => {
      const child = spawn(
        process.execPath,
        [sharedFragment, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port), '--generation', generation],
        {
          env: { ...process.env, HDSL_QA_DSH_MODE: 'ready', HDSL_QA_NO_GRANDCHILD: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      spawned.push(child);
      return child;
    };
    const childA = spawnWithGeneration(generationA, 0);
    const childB = spawnWithGeneration(generationB, 0);

    const probe = createPosixProcessProbe();
    await waitFor(
      () =>
        probe.findIdsByCommandFragment(sharedFragment).filter((pid) => pid === childA.pid || pid === childB.pid)
          .length === 2,
      { timeoutMs: 5_000, label: 'both generations running' },
    );

    // Searching for gen A must never return the gen B process (different dir).
    const foundA = findOwnedProcesses(probe, sharedFragment, generationA);
    const foundB = findOwnedProcesses(probe, sharedFragment, generationB);
    expect(foundA.map((entry) => entry.pid)).toEqual([childA.pid]);
    expect(foundB.map((entry) => entry.pid)).toEqual([childB.pid]);
    expect(foundA.map((entry) => entry.pid)).not.toContain(childB.pid);

    childA.kill('SIGKILL');
    childB.kill('SIGKILL');
  }, 30_000);

  it('PROC-OWN-01: an unrelated control process is never touched by start/stop', async () => {
    const controlRoot = tempDir('hdsl-proc-control-');
    const control = spawn(
      process.execPath,
      [FIXTURE_SCRIPT, '--role', 'parent', '--mode', 'hold', '--label', 'unrelated', '--record-dir', controlRoot],
      { env: { ...process.env, HDSL_QA_PROC_TOKEN: `hdsl-qa-control-${String(Date.now())}` }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    spawned.push(control);

    const infoRoot = tempDir('hdsl-proc-info-');
    const harness = startReadyHarness('env-own', infoRoot);
    try {
      const started = await harness.manager.start(harness.request('env-own'));
      expect(started.ok).toBe(true);
      if (started.ok) {
        await harness.manager.stop(harness.request('env-own'));
      }
      expect(control.exitCode).toBeNull();
      expect(isProcessAlive(control.pid as number)).toBe(true);
    } finally {
      control.kill('SIGKILL');
    }
  }, 30_000);
});
