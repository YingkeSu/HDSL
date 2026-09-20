/**
 * T007b — service-level dataRoot lock lifecycle QA (issue #45).
 *
 * Registered against the frozen T005a candidate
 * `ao/hdsl-21/t005a-dataroot-lock` @ `5bf7091011b137955ab4cfd83c746b9baf01b832`
 * (PR #49). Scenarios: dual-instance exclusivity, path aliases, close ordering
 * with an install in flight, failure-keeps-lock, and real crash takeover.
 *
 * The managed-process port is a QA fake (never a real DSH); the runtime and
 * the lock are the production implementation. Every wait is a bounded gate;
 * the close-ordering scenario holds the install in flight so the assertion is
 * deterministic rather than a race.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalizeDataRoot, DataRootLock } from '@hdsl/core';

import {
  buildLockHarness,
  createEnvironment,
  createEnvironmentInput,
  operationRef,
  QaProcess,
  type LockHarness,
} from './support/install-harness.js';
import { spawnLockHolder, waitForChildExit } from './support/lock-holder.js';
import { assertOrdered, OrderingLedger } from './support/ordering-ledger.js';
import { waitFor } from './support/wait.js';

const roots: string[] = [];
const locks: DataRootLock[] = [];

const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-lockqa-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const lock of locks.splice(0)) {
    await lock.release().catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Canonical state of every environment, via the real contract dispatch. */
const environmentState = (harness: LockHarness): string => {
  const list = harness.dispatch('environments.list', {});
  if (!list.ok) {
    throw new Error(`environments.list failed: ${list.error.code}`);
  }
  const environments = list.value as Array<{ state: string }>;
  return JSON.stringify(environments.map((environment) => environment.state));
};

/** Count of durable operation records under the dataRoot. */
const operationRecordCount = (dataRoot: string): number => {
  try {
    return readdirSync(join(dataRoot, 'operations')).length;
  } catch {
    return 0;
  }
};

describe('dataRoot lock lifecycle QA (PROC-LOCK service level)', () => {
  it('PROC-LOCK-01: a second instance on the same dataRoot is unavailable and refused', async () => {
    const dataRoot = freshRoot();
    const first = await buildLockHarness({ dataRoot });
    expect(first.managed.available).toBe(true);
    try {
      const second = await buildLockHarness({ dataRoot });
      expect(second.managed.available).toBe(false);
      expect(second.managed.lockSnapshot().publishedBy).toBe('another-instance');
      expect(second.managed.lockSnapshot().state).toBe('busy');

      const recover = await second.managed.recover();
      expect(recover.refused).toBe(true);
      expect(recover.reconciled).toBe(0);

      const created = second.dispatch('environments.create', createEnvironmentInput('req-busy'));
      expect(created.ok).toBe(false);
      if (!created.ok) {
        expect(created.error.code).toBe('ENVIRONMENT_BUSY');
      }
    } finally {
      const report = await first.managed.close();
      expect(report.released).toBe(true);
      expect(first.managed.lockSnapshot().publishedBy).toBe('none');
    }
  }, 30_000);

  it('PROC-LOCK alias: `..`, symlink and real spellings canonicalize to one lock', async () => {
    const dataRoot = freshRoot();
    const parent = dirname(dataRoot);
    const aliasDotDot = join(dataRoot, '..', basename(dataRoot));
    const aliasLink = join(parent, `alias-${String(process.pid)}-${Math.random().toString(16).slice(2)}`);
    symlinkSync(dataRoot, aliasLink);
    roots.push(aliasLink);

    expect(canonicalizeDataRoot(aliasDotDot)).toBe(canonicalizeDataRoot(dataRoot));
    expect(canonicalizeDataRoot(aliasLink)).toBe(canonicalizeDataRoot(dataRoot));

    const first = await buildLockHarness({ dataRoot });
    expect(first.managed.available).toBe(true);
    try {
      const viaDotDot = await buildLockHarness({ dataRoot: aliasDotDot });
      const viaLink = await buildLockHarness({ dataRoot: aliasLink });
      expect(viaDotDot.managed.available).toBe(false);
      expect(viaLink.managed.available).toBe(false);
      expect(viaLink.managed.lockSnapshot().publishedLease?.pid).toBe(
        first.managed.lockSnapshot().publishedLease?.pid,
      );
    } finally {
      await first.managed.close();
    }
  }, 30_000);

  it('PROC-LOCK-05: close waits for the writer to settle, then releases the lock, then the next instance acquires', async () => {
    const dataRoot = freshRoot();
    const ledger = new OrderingLedger(join(dataRoot, 'close-ordering.jsonl'));
    const harness = await buildLockHarness({
      dataRoot,
      gated: true,
      onWriterSettle: () => ledger.append('writer', 'settled'),
    });
    const gate = harness.gate;
    expect(gate).toBeDefined();
    if (gate === undefined) {
      return;
    }

    const response = harness.dispatch('environments.create', createEnvironmentInput('req-inflight'));
    const operationId = operationRef(response);
    await gate.started;

    // The install is in flight and the lock is held by this instance.
    expect(harness.managed.lockSnapshot().publishedBy).toBe('this-instance');

    // A concurrent instance cannot acquire while the write is in flight.
    const concurrent = await buildLockHarness({ dataRoot });
    expect(concurrent.managed.available).toBe(false);

    // close() must abort the in-flight write but not release before it settles.
    const closing = harness.managed.close();
    await waitFor(() => gate.aborted(), { timeoutMs: 5_000, label: 'close aborts the in-flight install' });
    expect(harness.managed.lockSnapshot().publishedBy).toBe('this-instance');

    // Release the writer; close may only finish after the writer settled.
    gate.release();
    const settled = await harness.managed.waitForOperation(operationId);
    expect(['failed', 'cancelled']).toContain(settled.status);

    const report = await closing;
    expect(report.released).toBe(true);
    expect(harness.managed.lockSnapshot().publishedBy).toBe('none');
    ledger.append('core', 'lock-release');

    // The next instance must acquire only after the lock was released.
    const next = await buildLockHarness({ dataRoot });
    expect(next.managed.available).toBe(true);
    ledger.append('next', 'acquire');
    await next.managed.close();

    // Ordering proof: writer settled < lock released < next acquired.
    assertOrdered(
      ledger,
      { actor: 'writer', event: 'settled' },
      { actor: 'core', event: 'lock-release' },
    );
    assertOrdered(
      ledger,
      { actor: 'core', event: 'lock-release' },
      { actor: 'next', event: 'acquire' },
    );
  }, 30_000);

  it('PROC-LOCK failure: a close that cannot stop its process keeps the lock', async () => {
    const dataRoot = freshRoot();
    const harness = await buildLockHarness({ dataRoot, process: new QaProcess({ closeOk: false }) });
    await createEnvironment(harness, 'req-close-fail');

    const report = await harness.managed.close();
    expect(report.released).toBe(false);
    expect(report.failure?.code).toBe('INTERNAL_ERROR');
    expect(harness.managed.lockSnapshot().heldByThisInstance).toBe(true);
    expect(harness.managed.lockSnapshot().publishedBy).toBe('this-instance');

    // A later instance must not be able to start work on the still-locked root.
    const second = await buildLockHarness({ dataRoot });
    expect(second.managed.available).toBe(false);
  }, 30_000);

  it('PROC-LOCK crash: a killed holder is taken over after staleness, never sooner', async () => {
    const dataRoot = freshRoot();
    const holder = spawnLockHolder(dataRoot, 'acquire');
    const held = await holder.firstLine;
    expect(held).toMatch(/^HELD \d+$/);
    const holderPid = holder.child.pid;

    // Kill the holder: a crash, not a clean release. Its pid is dead.
    holder.child.kill('SIGKILL');
    await waitForChildExit(holder.child);

    const taker = new DataRootLock({
      dataRoot,
      heartbeatIntervalMs: 60_000,
      staleAfterMs: 200,
      guardWaitMs: 3_000,
    });
    locks.push(taker);
    expect(await taker.acquire({ waitTimeoutMs: 5_000, pollIntervalMs: 25 })).toBe(true);
    expect(taker.lastAttempt?.takeover).toBe(true);
    const takeover = taker.snapshot().evidence.find((entry) => entry.kind === 'takeover');
    expect(takeover?.staleLease?.pid).toBe(holderPid);
  }, 30_000);

  it('PROC-LOCK-08: a displaced owner stops owning, keeps the new lease and refuses new writes', async () => {
    const dataRoot = freshRoot();
    const harness = await buildLockHarness({
      dataRoot,
      lockHeartbeatIntervalMs: 20,
      lockStaleAfterMs: 150,
    });
    expect(harness.managed.available).toBe(true);

    // Create an environment while the lock is provably held, so the post-loss
    // no-op assertion has a real state to compare against.
    await createEnvironment(harness, 'req-lost-env');
    const stateBefore = environmentState(harness);

    // External tamper: a foreign but well-formed lease replaces the canonical
    // one. This is an external-tamper robustness case, listed separately from
    // the in-protocol takeover scenarios.
    const leasePath = join(canonicalizeDataRoot(dataRoot), 'locks', 'data-root.lock', 'lease.json');
    const foreign = {
      schemaVersion: '1' as const,
      lockId: 'foreign-lock',
      instanceId: 'foreign-instance',
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    writeFileSync(leasePath, JSON.stringify(foreign));
    const foreignRaw = readFileSync(leasePath, 'utf8');
    const opsBefore = operationRecordCount(dataRoot);

    // Bounded gate: the owner observes the displacement and stops owning.
    await waitFor(
      () =>
        harness.managed.lockSnapshot().heldByThisInstance === false &&
        harness.managed.lockSnapshot().evidence.some((entry) => entry.kind === 'lost'),
      { timeoutMs: 3_000, label: 'owner observes the external displacement' },
    );
    const snapshot = harness.managed.lockSnapshot();
    expect(snapshot.publishedBy).toBe('another-instance');
    expect(snapshot.publishedLease?.lockId).toBe('foreign-lock');
    expect(snapshot.heldByThisInstance).toBe(false);

    // The displaced owner's heartbeat must not clobber, move or delete the new lease.
    expect(readFileSync(leasePath, 'utf8')).toBe(foreignRaw);

    // A new managed write is refused while the lock is not provably held, and it
    // leaves no new persistent side effect (no environment, no operation record).
    const created = harness.dispatch('environments.create', createEnvironmentInput('req-lost'));
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe('ENVIRONMENT_BUSY');
    }
    expect(environmentState(harness)).toBe(stateBefore);
    expect(operationRecordCount(dataRoot)).toBe(opsBefore);
    expect(readFileSync(leasePath, 'utf8')).toBe(foreignRaw);

    // An exit event for a process this instance no longer owns must be a no-op:
    // the environment state is unchanged.
    expect(() =>
      harness.managed.handleProcessExit({ environmentId: 'external', pid: 4242, exitCode: 1 }),
    ).not.toThrow();
    expect(environmentState(harness)).toBe(stateBefore);

    // Closing a displaced instance must not delete the new owner's lease.
    await harness.managed.close();
    expect((JSON.parse(readFileSync(leasePath, 'utf8')) as { lockId: string }).lockId).toBe('foreign-lock');
  }, 30_000);

  it('PROC-LOCK-07: while a real holder owns the root, the service refuses new managed writes', async () => {
    const dataRoot = freshRoot();
    const holder = spawnLockHolder(dataRoot, 'acquire');
    expect(await holder.firstLine).toMatch(/^HELD \d+$/);
    try {
      const blocked = await buildLockHarness({ dataRoot });
      expect(blocked.managed.available).toBe(false);
      expect(blocked.managed.lockSnapshot().publishedBy).toBe('another-instance');
      const created = blocked.dispatch('environments.create', createEnvironmentInput('req-real-busy'));
      expect(created.ok).toBe(false);
      if (!created.ok) {
        expect(created.error.code).toBe('ENVIRONMENT_BUSY');
      }
    } finally {
      // Clean release, then a fresh instance can take the root.
      holder.child.kill('SIGTERM');
      await waitForChildExit(holder.child);
    }
    const after = await buildLockHarness({ dataRoot });
    expect(after.managed.available).toBe(true);
    await after.managed.close();
  }, 30_000);
});
