/**
 * dataRoot exclusive lock (issue #43) — real second-process tests.
 *
 * Each child runs the *same* `data-root-lock.ts` implementation through the
 * `resolve-ts-hook.mjs` module hook, so this is a real cross-process boundary,
 * not a re-implementation.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeDataRoot, DataRootLock } from '@hdsl/core';

const HOLDER = fileURLToPath(new URL('./support/lock-holder.mjs', import.meta.url));

const roots: string[] = [];
const locks: DataRootLock[] = [];
const children: ChildProcess[] = [];

const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-lockproc-'));
  roots.push(root);
  return root;
};

const track = (lock: DataRootLock): DataRootLock => {
  locks.push(lock);
  return lock;
};

const spawnHolder = (
  root: string,
  mode: 'acquire' | 'try-once',
  staleAfterMs = '150',
  waitTimeoutMs = '5000',
): { readonly child: ChildProcess; readonly firstLine: Promise<string> } => {
  const child = spawn(process.execPath, [HOLDER, root, mode, staleAfterMs, waitTimeoutMs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let buffer = '';
  const firstLine = new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index >= 0) {
        resolve(buffer.slice(0, index));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!buffer.includes('\n')) {
        resolve(`EXIT ${String(code)}`);
      }
    });
  });
  return { child, firstLine };
};

const waitForExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => {
      resolve();
    });
  });

const kill = async (child: ChildProcess): Promise<void> => {
  child.kill('SIGKILL');
  await waitForExit(child);
};

const leaseDirectoryFor = (root: string): string =>
  join(canonicalizeDataRoot(root), 'locks', 'data-root.lock');

const readLease = (root: string): { readonly lockId: string; readonly instanceId: string; readonly pid: number } =>
  JSON.parse(readFileSync(join(leaseDirectoryFor(root), 'lease.json'), 'utf8')) as {
    lockId: string;
    instanceId: string;
    pid: number;
  };

const bindGuardPort = (port: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  }
  for (const lock of locks.splice(0)) {
    if (lock.held) {
      await lock.release();
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('dataRoot lock across real processes', () => {
  it('refuses a real second process while this process holds the lease', async () => {
    const root = freshRoot();
    const holder = track(new DataRootLock({ dataRoot: root, heartbeatIntervalMs: 40, staleAfterMs: 150 }));
    expect(await holder.acquire({ waitTimeoutMs: 500 })).toBe(true);

    const { child, firstLine } = spawnHolder(root, 'try-once');
    expect(await firstLine).toBe('BUSY');
    await waitForExit(child);
    expect(child.exitCode).toBe(3);
    expect(readLease(root).lockId).toBe(holder.lockId);
  });

  it('takes over a crashed second process and preserves its lease as evidence', async () => {
    const root = freshRoot();
    const { child, firstLine } = spawnHolder(root, 'acquire');
    expect(await firstLine).toMatch(/^HELD /);
    const crashed = readLease(root);
    expect(child.pid).toBe(crashed.pid);

    const contender = track(
      new DataRootLock({
        dataRoot: root,
        heartbeatIntervalMs: 40,
        staleAfterMs: 150,
        guardWaitMs: 1_000,
      }),
    );
    // While the child is alive the contender is refused.
    expect(await contender.acquire({ waitTimeoutMs: 200, pollIntervalMs: 20 })).toBe(false);
    expect(readLease(root).lockId).toBe(crashed.lockId);

    await kill(child);
    expect(await contender.acquire({ waitTimeoutMs: 2_000, pollIntervalMs: 20 })).toBe(true);
    expect(contender.lastAttempt?.takeover).toBe(true);
    expect(contender.lockId).not.toBe(crashed.lockId);

    const quarantine = join(canonicalizeDataRoot(root), 'locks', 'quarantine');
    const entries = existsSync(quarantine) ? readdirSync(quarantine) : [];
    expect(entries.some((entry) => entry.startsWith(`${crashed.lockId}-`))).toBe(true);
  });

  it('releases the recovery guard port after a guarded takeover', async () => {
    const root = freshRoot();
    const { child } = spawnHolder(root, 'acquire');
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    const contender = track(
      new DataRootLock({ dataRoot: root, heartbeatIntervalMs: 40, staleAfterMs: 100, guardWaitMs: 1_000 }),
    );
    await kill(child);
    expect(await contender.acquire({ waitTimeoutMs: 2_000, pollIntervalMs: 20 })).toBe(true);
    // The guard listener must be fully closed (bounded await) before relinquishing.
    expect(await bindGuardPort(contender.guardPort)).toBe(true);
  });

  it('lets a spawned child bind a port the parent already closed', async () => {
    // Regression guard for fd inheritance: a listener bound and closed in the
    // parent must not stay bound inside a child spawned by it.
    const port = 39_000 + Math.floor(Math.random() * 1_000);
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen({ port, host: '127.0.0.1' }, () => {
        resolve();
      });
    });
    const child = spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => { const net=require('node:net'); const s=net.createServer(); s.once('error',()=>{process.stdout.write('INHERITED\\n');process.exit(0);}); s.listen({port:${String(port)},host:'127.0.0.1'},()=>{process.stdout.write('FREE\\n');s.close(()=>process.exit(0));}); }, 400);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    const output = await new Promise<string>((resolve) => {
      let collected = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        collected += chunk.toString('utf8');
      });
      child.once('exit', () => {
        resolve(collected.trim());
      });
    });
    expect(output).toBe('FREE');
  });

  it('elects exactly one holder when several real processes race a stale lock', async () => {
    const root = freshRoot();
    const directory = leaseDirectoryFor(root);
    const { mkdirSync, writeFileSync } = await import('node:fs');    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'lease.json'),
      `${JSON.stringify(
        {
          schemaVersion: '1',
          lockId: 'race-stale-0001',
          instanceId: 'race-stale-instance',
          pid: 999_999,
          hostname: hostname(),
          acquiredAt: '2020-01-01T00:00:00.000Z',
          heartbeatAt: '2020-01-01T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );

    const spawned = Array.from({ length: 4 }, () => spawnHolder(root, 'acquire', '100', '1500'));
    const lines = await Promise.all(spawned.map((entry) => entry.firstLine));
    const held = lines.filter((line) => line.startsWith('HELD '));
    expect(held).toHaveLength(1);
    expect(readLease(root).lockId).not.toBe('race-stale-0001');

    // After the winner dies exactly one of a second wave can take over again.
    const winnerIndex = lines.findIndex((line) => line.startsWith('HELD '));
    const winner = spawned[winnerIndex]?.child;
    if (winner !== undefined) {
      await kill(winner);
    }
  }, 20_000);
});
