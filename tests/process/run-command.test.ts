/**
 * T005 installer-subtree governance: `runCommand` must terminate the whole
 * process tree on timeout/cancel (not just the direct child) and leave a
 * verifiable, non-secret identity record that restart reconciliation can use.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isProcessAlive, runCommand } from '@hdsl/runtime';
import { delay, waitFor } from './support/harness.js';

const HANG_TREE_PATH = fileURLToPath(new URL('./support/hang-tree.mjs', import.meta.url));

interface Fixture {
  readonly root: string;
  readonly generationDirectory: string;
  readonly homeDirectory: string;
  readonly pidFile: string;
  readonly journalDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
}

const roots: string[] = [];

const createFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-run-command-'));
  roots.push(root);
  const generationDirectory = join(root, 'generation');
  const homeDirectory = join(generationDirectory, 'home');
  const journalDirectory = join(generationDirectory, '.hdsl-process-children');
  mkdirSync(homeDirectory, { recursive: true });
  const pidFile = join(root, 'grandchild.pid');
  return {
    root,
    generationDirectory,
    homeDirectory,
    pidFile,
    journalDirectory,
    environment: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: homeDirectory,
      DSH_HOME: homeDirectory,
      HANG_TREE_PID_FILE: pidFile,
    },
  };
};

const grandchildPid = async (fixture: Fixture): Promise<number> => {
  await waitFor(() => existsSync(fixture.pidFile), 5_000);
  return Number(readFileSync(fixture.pidFile, 'utf8'));
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runCommand process-tree governance', () => {
  it('kills the grandchild as well as the direct child on timeout', async () => {
    const fixture = createFixture();
    const result = await runCommand(process.execPath, [HANG_TREE_PATH], {
      cwd: fixture.generationDirectory,
      env: fixture.environment,
      timeoutMs: 1_500,
    });
    expect(result.timedOut).toBe(true);
    const grandchild = await grandchildPid(fixture);
    await waitFor(() => !isProcessAlive(grandchild));
  });

  it('kills the whole tree when the caller aborts', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const running = runCommand(process.execPath, [HANG_TREE_PATH], {
      cwd: fixture.generationDirectory,
      env: fixture.environment,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const grandchild = await grandchildPid(fixture);
    controller.abort();
    const result = await running;
    expect(result.timedOut).toBe(false);
    await waitFor(() => !isProcessAlive(grandchild));
  });

  it('journals a verifiable child identity during the run and removes it after', async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    const running = runCommand(process.execPath, [HANG_TREE_PATH], {
      cwd: fixture.generationDirectory,
      env: fixture.environment,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await waitFor(() => {
      try {
        return existsSync(fixture.journalDirectory) && readdirSync(fixture.journalDirectory).length > 0;
      } catch {
        return false;
      }
    }, 5_000);
    const files = readdirSync(fixture.journalDirectory).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(fixture.journalDirectory, files[0] as string), 'utf8'),
    ) as Record<string, unknown>;
    expect(record['startToken']).toEqual(expect.any(String));
    expect(String(record['startToken']).length).toBeGreaterThan(0);
    expect(record['pgid']).toEqual(expect.any(Number));
    expect(record['commandFragment']).toBe(process.execPath);
    // argv is never persisted; only the executable path is recorded.
    expect(JSON.stringify(record)).not.toContain(HANG_TREE_PATH);

    controller.abort();
    await running;
    await waitFor(() => readdirSync(fixture.journalDirectory).length === 0, 5_000);
    await delay(10);
  });
});
