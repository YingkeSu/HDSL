/**
 * dataRoot exclusive lock (issue #43) — in-process tests.
 *
 * Every case runs against the real lock on a real filesystem. Liveness is
 * injected where a deterministic "dead pid" is needed; the cross-process file
 * covers a real killed process.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeDataRoot,
  DataRootLock,
  type DataRootLease,
  type DataRootLockOptions,
} from '@hdsl/core';

const roots: string[] = [];
const locks: DataRootLock[] = [];

const freshRoot = (prefix = 'hdsl-lock-'): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const newLock = (
  dataRoot: string,
  options: Omit<DataRootLockOptions, 'dataRoot'> = {},
): DataRootLock => {
  const lock = new DataRootLock({
    dataRoot,
    heartbeatIntervalMs: 40,
    staleAfterMs: 150,
    guardWaitMs: 1_000,
    ...options,
  });
  locks.push(lock);
  return lock;
};

const lockDirectoryFor = (dataRoot: string): string =>
  join(canonicalizeDataRoot(dataRoot), 'locks', 'data-root.lock');

const writeLease = (dataRoot: string, lease: DataRootLease): void => {
  const directory = lockDirectoryFor(dataRoot);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'lease.json'), `${JSON.stringify(lease, null, 2)}\n`);
};

const staleLease = (overrides: Partial<DataRootLease> = {}): DataRootLease => ({
  schemaVersion: '1',
  lockId: 'stale-lock-0001',
  instanceId: 'stale-instance-0001',
  // Beyond any real pid_max, so the default probe reports `dead`.
  pid: 999_999,
  hostname: hostname(),
  acquiredAt: '2020-01-01T00:00:00.000Z',
  heartbeatAt: '2020-01-01T00:00:00.000Z',
  ...overrides,
});

afterEach(async () => {
  for (const lock of locks.splice(0)) {
    if (lock.held) {
      await lock.release();
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('dataRoot lock acquisition', () => {
  it('acquires a free data root and exposes it in the snapshot', async () => {
    const root = freshRoot();
    const lock = newLock(root);
    expect(await lock.acquire({ waitTimeoutMs: 500 })).toBe(true);
    expect(lock.held).toBe(true);
    const snapshot = lock.snapshot();
    expect(snapshot.state).toBe('held');
    expect(snapshot.publishedBy).toBe('this-instance');
    expect(snapshot.publishedLease?.lockId).toBe(lock.lockId);
    expect(snapshot.lastAttempt?.outcome).toBe('held');
  });

  it('rejects a same-process second instance while the first holds, then allows it after release', async () => {
    const root = freshRoot();
    const first = newLock(root);
    expect(await first.acquire({ waitTimeoutMs: 500 })).toBe(true);
    const second = newLock(root);
    const startedAt = Date.now();
    expect(await second.acquire({ waitTimeoutMs: 200, pollIntervalMs: 20 })).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    const snapshot = second.snapshot();
    expect(snapshot.state).toBe('busy');
    expect(snapshot.publishedBy).toBe('another-instance');
    expect(snapshot.publishedLease?.lockId).toBe(first.lockId);
    expect(snapshot.lastAttempt?.outcome).toBe('busy');

    await first.release();
    expect(await second.acquire({ waitTimeoutMs: 500 })).toBe(true);
  });

  it('fails closed on a stale heartbeat while the owner pid is still alive', async () => {
    const root = freshRoot();
    const holder = newLock(root, { staleAfterMs: 0, heartbeatIntervalMs: 60_000, probeProcess: () => 'alive' });
    expect(await holder.acquire({ waitTimeoutMs: 500 })).toBe(true);
    const holderLockId = holder.lockId;

    const contender = newLock(root, { staleAfterMs: 0, probeProcess: () => 'alive' });
    expect(await contender.acquire({ waitTimeoutMs: 150, pollIntervalMs: 20 })).toBe(false);
    // The live holder's lease was not replaced.
    const published = contender.readPublishedLease();
    expect(published?.lockId).toBe(holderLockId);
    expect(contender.lastAttempt?.reason).toContain('live');
  });

  it('takes over a provably dead stale lease and keeps quarantine evidence', async () => {
    const root = freshRoot();
    writeLease(root, staleLease());
    const lock = newLock(root, { probeProcess: () => 'dead' });
    expect(await lock.acquire({ waitTimeoutMs: 500 })).toBe(true);
    expect(lock.lastAttempt?.takeover).toBe(true);
    expect(lock.lockId).not.toBe('stale-lock-0001');
    expect(lock.lockId).toBeDefined();
    if (lock.lockId === undefined) {
      return;
    }
    const quarantine = join(canonicalizeDataRoot(root), 'locks', 'quarantine');
    const entries = existsSync(quarantine) ? readdirSync(quarantine) : [];
    expect(entries.some((entry) => entry.startsWith('stale-lock-0001-'))).toBe(true);
    const evidence = lock.snapshot().evidence;
    expect(evidence.some((entry) => entry.kind === 'takeover' && entry.lockId === 'stale-lock-0001')).toBe(true);
  });

  it('treats a foreign-host lease as busy and leaves it untouched', async () => {
    const root = freshRoot();
    writeLease(root, staleLease({ hostname: 'some-other-host' }));
    const lock = newLock(root, { probeProcess: () => 'dead' });
    expect(await lock.acquire({ waitTimeoutMs: 150, pollIntervalMs: 20 })).toBe(false);
    const published = lock.readPublishedLease();
    expect(published?.lockId).toBe('stale-lock-0001');
    expect(lock.lastAttempt?.outcome).toBe('unknown');
  });

  it('treats a corrupt lease as busy and never deletes it', async () => {
    const root = freshRoot();
    const directory = lockDirectoryFor(root);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'lease.json'), '{ not json');
    const lock = newLock(root, { probeProcess: () => 'dead' });
    expect(await lock.acquire({ waitTimeoutMs: 150, pollIntervalMs: 20 })).toBe(false);
    expect(readFileSync(join(directory, 'lease.json'), 'utf8')).toBe('{ not json');
    expect(lock.lastAttempt?.outcome).toBe('unknown');
  });

  it('replaces an empty canonical lock directory left by a crash', async () => {
    const root = freshRoot();
    mkdirSync(lockDirectoryFor(root), { recursive: true });
    const lock = newLock(root);
    expect(await lock.acquire({ waitTimeoutMs: 500 })).toBe(true);
    // The atomic publish replaces the empty residue; no live holder can have an
    // empty canonical directory because publication is atomic.
    expect(lock.held).toBe(true);
    expect(lock.readPublishedLease()?.lockId).toBe(lock.lockId);
    expect(lock.snapshot().state).toBe('held');
  });

  it('maps symlink aliases of the same directory to one lock and one guard port', async () => {
    const realRoot = freshRoot('hdsl-lock-real-');
    const aliasParent = freshRoot('hdsl-lock-alias-');
    const alias = join(aliasParent, 'alias');
    symlinkSync(realRoot, alias, 'dir');

    expect(canonicalizeDataRoot(alias)).toBe(canonicalizeDataRoot(realRoot));
    const viaReal = newLock(realRoot);
    const viaAlias = newLock(alias);
    expect(viaAlias.dataRoot).toBe(viaReal.dataRoot);
    expect(viaAlias.guardPort).toBe(viaReal.guardPort);
    expect(await viaReal.acquire({ waitTimeoutMs: 500 })).toBe(true);
    expect(await viaAlias.acquire({ waitTimeoutMs: 150, pollIntervalMs: 20 })).toBe(false);
  });
});

describe('dataRoot lock takeover safety', () => {
  it('never archives the new holder after an old stale observation (three-party interleaving)', async () => {
    const root = freshRoot();
    writeLease(root, staleLease());

    // A observes the stale lease but must not take it over synchronously.
    const observer = newLock(root);
    expect(observer.tryAcquire()).toBe(false);
    expect(observer.lastAttempt?.observedLockId).toBe('stale-lock-0001');

    // B wins the guarded takeover legally.
    const winner = newLock(root, { probeProcess: () => 'dead' });
    expect(await winner.acquire({ waitTimeoutMs: 500 })).toBe(true);
    const winnerLockId = winner.lockId;
    expect(winnerLockId).not.toBe('stale-lock-0001');

    // A now acts on its old observation: the guard re-read sees B live and A yields.
    expect(await observer.acquire({ waitTimeoutMs: 200, pollIntervalMs: 20 })).toBe(false);
    expect(observer.readPublishedLease()?.lockId).toBe(winnerLockId);
    expect(observer.lastAttempt?.outcome).toBe('busy');
    // B's lease is intact and was never quarantined.
    const quarantine = join(canonicalizeDataRoot(root), 'locks', 'quarantine');
    const quarantined = existsSync(quarantine) ? readdirSync(quarantine) : [];
    expect(quarantined.some((entry) => entry.startsWith(`${winnerLockId}-`))).toBe(false);
  });

  it('does not delete a lease it does not own on release (ABA)', async () => {
    const root = freshRoot();
    const holder = newLock(root, { heartbeatIntervalMs: 60_000 });
    expect(await holder.acquire({ waitTimeoutMs: 500 })).toBe(true);
    // Simulate a foreign lock that replaced ours between assertHeld and release.
    const foreign = staleLease({ lockId: 'foreign-lock-0002', instanceId: 'foreign-instance-0002', pid: process.pid });
    writeLease(root, foreign);

    const result = await holder.release();
    expect(result.released).toBe(false);
    expect(result.reason).toContain('did not match');
    expect(holder.readPublishedLease()?.lockId).toBe('foreign-lock-0002');
  });

  it('fails closed instead of taking over on Windows, which is unverified', async () => {
    const root = freshRoot();
    writeLease(root, staleLease());
    const lock = newLock(root, { platform: 'win32', probeProcess: () => 'dead' });
    expect(await lock.acquire({ waitTimeoutMs: 150, pollIntervalMs: 20 })).toBe(false);
    expect(lock.readPublishedLease()?.lockId).toBe('stale-lock-0001');
    expect(lock.lastAttempt?.outcome).toBe('unknown');
  });

  it('negative control: a mkdir-then-write variant permits two holders (why publish is atomic)', async () => {
    const root = freshRoot();
    const lockDir = lockDirectoryFor(root);
    const stamp = new Date().toISOString();
    const lease = (lockId: string): Record<string, unknown> => ({
      schemaVersion: '1',
      lockId,
      instanceId: lockId,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: stamp,
      heartbeatAt: stamp,
    });

    // Test-local WRONG variant (never used by production): create the canonical
    // directory first, then write `lease.json` in a second step. Between the two
    // steps the canonical directory is empty, which the crash-reclaim path would
    // treat as abandoned.
    mkdirSync(lockDir, { recursive: true }); // "A" mkdir
    renameSync(lockDir, `${lockDir}.quarantine`); // "B" reclaims the empty dir
    mkdirSync(lockDir, { recursive: true }); // "B" mkdir
    writeFileSync(join(lockDir, 'lease.json'), JSON.stringify(lease('B'))); // "B" writes
    writeFileSync(join(lockDir, 'lease.json'), JSON.stringify(lease('A'))); // "A" writes late
    const canonical = JSON.parse(readFileSync(join(lockDir, 'lease.json'), 'utf8')) as {
      lockId: string;
    };
    // "B" still believes it holds, yet the canonical lease is "A": two holders.
    expect(canonical.lockId).toBe('A');

    // The production lock never exposes this window: a complete lease is written
    // in a private directory and published with one atomic rename, so a live
    // holder's canonical directory is never empty.
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(`${lockDir}.quarantine`, { recursive: true, force: true });
    const real = newLock(root);
    expect(await real.acquire({ waitTimeoutMs: 500 })).toBe(true);
    expect(real.readPublishedLease()?.lockId).toBe(real.lockId);
  });
});
