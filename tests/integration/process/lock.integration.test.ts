/**
 * T007b — real dataRoot lock ownership QA (issue #45, scenarios PROC-LOCK-01/04/06).
 *
 * First executable batch, registered against the frozen T005a lock interface
 * (session hdsl-21, PR #49, SHA 5bf7091011b137955ab4cfd83c746b9baf01b832).
 * The suite drives the *public* `DataRootLock` from `@hdsl/core` and a real
 * second OS process (`tests/core/support/lock-holder.mjs`, reused read-only as
 * session hdsl-21 sanctioned) that runs the same production implementation.
 *
 * Every scenario is deterministic: a fake clock plus an injected liveness probe
 * reproduce stale/PID-reuse/foreign-host/corrupt states without sleeping, and a
 * real subprocess proves the cross-process boundary. No mock stands in for the
 * lock, no scenario is skipped, and `PROC-LOCK-03/05/07/08` stay blocked until
 * the candidate exposes the required interleaving/close semantics.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DataRootLock, DataRootLockLostError, type DataRootLease } from '@hdsl/core';

import { waitFor } from './support/wait.js';

const HOLDER = fileURLToPath(new URL('../../core/support/lock-holder.mjs', import.meta.url));

const roots: string[] = [];
const locks: DataRootLock[] = [];
const children: ChildProcess[] = [];

const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-proc-lock-'));
  roots.push(root);
  return root;
};

const track = (lock: DataRootLock): DataRootLock => {
  locks.push(lock);
  return lock;
};

afterEach(async () => {
  for (const lock of locks.splice(0)) {
    await lock.release().catch(() => undefined);
  }
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const leaseFor = (overrides: Partial<DataRootLease> = {}): DataRootLease => ({
  schemaVersion: '1',
  lockId: `lock-${Math.random().toString(16).slice(2)}`,
  instanceId: `instance-${Math.random().toString(16).slice(2)}`,
  pid: process.pid,
  hostname: hostname(),
  acquiredAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  ...overrides,
});

/** Writes the canonical lease directory directly, bypassing the lock API. */
const publishLease = (dataRoot: string, contents: string): void => {
  const directory = join(dataRoot, 'locks', 'data-root.lock');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'lease.json'), contents);
};

interface Holder {
  readonly child: ChildProcess;
  readonly firstLine: Promise<string>;
}

const spawnHolder = (root: string, mode: 'acquire' | 'try-once'): Holder => {
  const child = spawn(process.execPath, [HOLDER, root, mode, '150', '5000'], {
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

const waitForExit = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
  });

describe('dataRoot lock ownership QA (PROC-LOCK)', () => {
  it('PROC-LOCK-01: a real second process is BUSY while a live holder owns the root', async () => {
    const root = freshRoot();
    const first = spawnHolder(root, 'acquire');
    try {
      const held = await first.firstLine;
      expect(held).toBe(`HELD ${String(first.child.pid)}`);

      // Public observation from this process: busy, published by another instance.
      const observer = track(new DataRootLock({ dataRoot: root, heartbeatIntervalMs: 60_000 }));
      const snapshot = observer.snapshot();
      expect(snapshot.state).toBe('busy');
      expect(snapshot.publishedBy).toBe('another-instance');
      expect(snapshot.heldByThisInstance).toBe(false);
      expect(snapshot.publishedLease?.pid).toBe(first.child.pid);

      // A second real process must be refused, not adopted.
      const second = spawnHolder(root, 'try-once');
      const verdict = await second.firstLine;
      expect(verdict).toBe('BUSY');
      expect(await waitForExit(second.child)).toBe(3);

      // A live owner is never taken over.
      expect(snapshot.evidence.some((entry) => entry.kind === 'takeover')).toBe(false);
    } finally {
      first.child.kill('SIGTERM');
      await waitForExit(first.child);
    }
  }, 30_000);

  it('PROC-LOCK-04: the old owner release cannot delete the replacement lock (ABA)', async () => {
    const root = freshRoot();
    let now = new Date('2026-09-20T00:00:00.000Z');
    const clock = (): Date => now;

    const staleAfterMs = 1_000;
    const ownerA = track(
      new DataRootLock({
        dataRoot: root,
        clock,
        staleAfterMs,
        heartbeatIntervalMs: 60_000,
        probeProcess: () => 'alive',
      }),
    );
    expect(await ownerA.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })).toBe(true);
    const lockIdA = ownerA.lockId;
    expect(lockIdA).toBeDefined();

    // A is now stale by heartbeat, and a probe reports its pid as dead, so B may
    // take over under the guard. Deterministic: no sleep involved.
    now = new Date(now.getTime() + 10_000);
    const ownerB = track(
      new DataRootLock({
        dataRoot: root,
        clock,
        staleAfterMs,
        heartbeatIntervalMs: 60_000,
        probeProcess: (pid) => (pid === ownerA.lease?.pid ? 'dead' : 'alive'),
      }),
    );
    expect(await ownerB.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })).toBe(true);
    const lockIdB = ownerB.lockId;
    expect(lockIdB).toBeDefined();
    expect(lockIdB).not.toBe(lockIdA);
    expect(ownerB.lastAttempt?.takeover).toBe(true);

    // A's late release must not remove B's lease.
    const release = await ownerA.release();
    expect(release.released).toBe(false);
    expect(ownerB.readPublishedLease()?.lockId).toBe(lockIdB);
    expect(ownerB.snapshot().state).toBe('held');
  }, 20_000);

  it('PROC-LOCK-04 control: an owner CAN release its own live lease', async () => {
    const root = freshRoot();
    const owner = track(
      new DataRootLock({ dataRoot: root, heartbeatIntervalMs: 60_000, probeProcess: () => 'alive' }),
    );
    expect(await owner.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })).toBe(true);
    const lockId = owner.lockId;
    expect(owner.readPublishedLease()?.lockId).toBe(lockId);
    const release = await owner.release();
    expect(release.released).toBe(true);
    expect(owner.readPublishedLease()).toBeUndefined();
  }, 15_000);

  it('PROC-LOCK-03: a stale observation never archives a newer holder (three-party interleaving)', async () => {
    const root = freshRoot();
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
    const staleLease = leaseFor({
      hostname: hostname(),
      // A pid that is not alive: the stale lease is a legitimate takeover target.
      pid: 2 ** 30,
      heartbeatAt: staleHeartbeat,
    });
    publishLease(root, JSON.stringify(staleLease));

    // A observes synchronously and never takes over in `tryAcquire()`.
    const observer = track(
      new DataRootLock({
        dataRoot: root,
        heartbeatIntervalMs: 60_000,
        staleAfterMs: 1_000,
        probeProcess: (pid) => (pid === staleLease.pid ? 'dead' : 'alive'),
      }),
    );
    expect(observer.tryAcquire()).toBe(false);
    expect(observer.lastAttempt?.outcome).toBe('busy');
    expect(observer.lastAttempt?.takeover).toBe(false);
    expect(observer.lastAttempt?.observedLockId).toBe(staleLease.lockId);

    // B is a real second process that legitimately takes the stale lock over.
    const holder = spawnHolder(root, 'acquire');
    const firstLine = await holder.firstLine;
    expect(firstLine).toBe(`HELD ${String(holder.child.pid)}`);
    const leaseB = observer.readPublishedLease();
    expect(leaseB).toBeDefined();
    expect(leaseB?.lockId).not.toBe(staleLease.lockId);

    // A now re-decides inside the guard and must see B's live lease, not archive it.
    expect(await observer.acquire({ waitTimeoutMs: 200, pollIntervalMs: 20 })).toBe(false);
    expect(observer.lastAttempt?.outcome).toBe('busy');
    expect(observer.lastAttempt?.observedLockId).toBe(leaseB?.lockId);
    expect(observer.readPublishedLease()?.lockId).toBe(leaseB?.lockId);

    // B's lock was never quarantined or removed.
    const quarantine = join(root, 'locks', 'quarantine');
    const entries = (() => {
      try {
        return readdirSync(quarantine);
      } catch {
        return [];
      }
    })();
    expect(entries.some((name) => name.includes(leaseB?.lockId ?? ''))).toBe(false);

    holder.child.kill('SIGTERM');
    await waitForExit(holder.child);
  }, 30_000);

  it('PROC-LOCK-07/08: a displaced owner detects loss and never overwrites the new lease', async () => {
    const root = freshRoot();
    let now = new Date('2026-09-20T00:00:00.000Z');
    const clock = (): Date => now;
    const staleAfterMs = 1_000;

    const ownerA = track(
      new DataRootLock({
        dataRoot: root,
        clock,
        staleAfterMs,
        // Short heartbeat so the displacing write is observed promptly (the
        // invariant itself is timing-free: A can never clobber B).
        heartbeatIntervalMs: 25,
        probeProcess: () => 'alive',
      }),
    );
    expect(await ownerA.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })).toBe(true);
    const lockIdA = ownerA.lockId;

    now = new Date(now.getTime() + 10_000);
    const ownerB = track(
      new DataRootLock({
        dataRoot: root,
        clock,
        staleAfterMs,
        heartbeatIntervalMs: 60_000,
        probeProcess: (pid) => (pid === ownerA.lease?.pid ? 'dead' : 'alive'),
      }),
    );
    expect(await ownerB.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })).toBe(true);
    const lockIdB = ownerB.lockId;
    expect(lockIdB).not.toBe(lockIdA);

    // A observes the loss (bounded gate, not a sleep) and stops owning.
    await waitFor(() => !ownerA.held && ownerA.snapshot().evidence.some((e) => e.kind === 'lost'), {
      timeoutMs: 3_000,
      label: 'owner A observes it lost the lease',
    });
    expect(ownerA.snapshot().heldByThisInstance).toBe(false);
    expect(() => ownerA.assertHeld()).toThrow(DataRootLockLostError);

    // B's lease is intact: A never resurrected or overwrote it.
    expect(ownerB.readPublishedLease()?.lockId).toBe(lockIdB);
    expect(ownerB.snapshot().state).toBe('held');
  }, 20_000);

  it('PROC-LOCK-06: a corrupted canonical lease is conservatively unreadable/unowned', async () => {
    const root = freshRoot();
    publishLease(root, '{ not: json');
    const lock = track(new DataRootLock({ dataRoot: root, heartbeatIntervalMs: 60_000 }));
    expect(await lock.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })).toBe(false);
    const snapshot = lock.snapshot();
    expect(snapshot.publishedBy).toBe('unreadable');
    expect(snapshot.state).toBe('unknown');
    expect(snapshot.lastAttempt?.outcome).toBe('unknown');
  }, 15_000);

  it('PROC-LOCK-06: a foreign-host lease is never adopted', async () => {
    const root = freshRoot();
    publishLease(root, JSON.stringify(leaseFor({ hostname: 'a-different-host', pid: 1 })));
    const lock = track(new DataRootLock({ dataRoot: root, heartbeatIntervalMs: 60_000 }));
    expect(await lock.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })).toBe(false);
    const snapshot = lock.snapshot();
    expect(snapshot.state).toBe('busy');
    expect(snapshot.publishedBy).toBe('another-instance');
    expect(snapshot.evidence.some((entry) => entry.kind === 'takeover')).toBe(false);
  }, 15_000);

  it('PROC-LOCK-06: a stale heartbeat with a live PID is still never taken over', async () => {
    const root = freshRoot();
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    publishLease(
      root,
      JSON.stringify(leaseFor({ hostname: hostname(), pid: process.pid, heartbeatAt: stale })),
    );
    const lock = track(
      new DataRootLock({
        dataRoot: root,
        heartbeatIntervalMs: 60_000,
        staleAfterMs: 1_000,
        probeProcess: (pid) => (pid === process.pid ? 'alive' : 'dead'),
      }),
    );
    expect(await lock.acquire({ waitTimeoutMs: 0, pollIntervalMs: 0 })).toBe(false);
    const snapshot = lock.snapshot();
    expect(snapshot.state).toBe('busy');
    expect(snapshot.evidence.some((entry) => entry.kind === 'takeover')).toBe(false);
    expect(lock.lastAttempt?.outcome).toBe('busy');
  }, 15_000);

  it('PROC-LOCK-03: three concurrent processes yield exactly one valid holder (zero overlap)', async () => {
    const root = freshRoot();
    const contenders = [
      spawnHolder(root, 'try-once'),
      spawnHolder(root, 'try-once'),
      spawnHolder(root, 'try-once'),
    ];
    const lines = await Promise.all(contenders.map((holder) => holder.firstLine));
    const heldCount = lines.filter((line) => /^HELD \d+$/.test(line)).length;
    const busyCount = lines.filter((line) => line === 'BUSY').length;
    // The atomic publish admits exactly one holder; the other two are refused.
    expect(heldCount).toBe(1);
    expect(busyCount).toBe(2);

    const observer = track(new DataRootLock({ dataRoot: root, heartbeatIntervalMs: 60_000 }));
    expect(observer.snapshot().state).toBe('busy');
    expect(observer.snapshot().publishedBy).toBe('another-instance');

    const winnerIndex = lines.findIndex((line) => /^HELD \d+$/.test(line));
    const winner = contenders[winnerIndex];
    expect(winner).toBeDefined();
    for (let index = 0; index < contenders.length; index += 1) {
      if (index === winnerIndex) {
        continue;
      }
      expect(await waitForExit(contenders[index]?.child as ChildProcess)).toBe(3);
    }
    winner?.child.kill('SIGTERM');
    await waitForExit(winner?.child as ChildProcess);
  }, 30_000);
});
