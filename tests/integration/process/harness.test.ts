/**
 * Fixture-harness self-check for `tests/integration/process`.
 *
 * These tests do NOT exercise the launcher and do NOT validate T005. The T005
 * candidate public interface does not exist yet (see
 * `docs/development/process-validation.md`), so no scenario is registered. What
 * is proven here is that the QA fixtures themselves are real, deterministic and
 * safe: controlled child/grandchild processes with verifiable identity, crash
 * orphaning, SIGTERM/SIGKILL escalation, a real loopback listener and port
 * conflict, a dual-instance dataRoot with separate canary credentials, and a
 * host-HOME guard that can actually fail.
 *
 * Green here means "the harness is trustworthy", never "process lifecycle
 * works". Run: `pnpm exec vitest run tests/integration/process/harness.test.ts`
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createDualInstanceFixture } from './support/data-root.js';
import {
  isProcessAlive,
  killGuarded,
  OwnershipError,
  readProcessTableEntry,
  verifyOwnership,
} from './support/identity.js';
import {
  captureHostDefaults,
  createTempRoot,
  diffHostDefaults,
  GateTimeoutError,
  waitFor,
} from './support/isolation.js';
import {
  getFreeLoopbackPort,
  httpProbe,
  isLoopbackPortBound,
  occupyLoopbackPort,
} from './support/loopback.js';
import {
  CORRUPT_LOCK_BYTES,
  hasForeignHost,
  isStale,
  LockFixture,
} from './support/lock-fixture.js';
import {
  assertNoConcurrentWriters,
  assertOrdered,
  OrderingLedger,
  OrderViolationError,
} from './support/ordering-ledger.js';
import { FixtureProcess, spawnControlProcess } from './support/spawn-fixture.js';
import {
  candidateBlockers,
  PROCESS_SCENARIOS,
  REQUIRED_CAPABILITIES,
} from './scenarios/process-scenario-plan.js';

const withRoot = async (label: string, body: (root: string) => Promise<void>): Promise<void> => {
  const temp = createTempRoot(label);
  try {
    await body(temp.path);
  } finally {
    temp.cleanup();
  }
};

describe('process fixture harness', () => {
  it('records a verifiable parent and grandchild, and stops the tree on SIGTERM', async () => {
    await withRoot('tree', async (root) => {
      const proc = FixtureProcess.spawn({ label: 'tree', mode: 'hold', grandchild: true }, root);
      try {
        await proc.waitForReady();
        const parent = await proc.waitForRecord();
        const grandchild = await proc.waitForGrandchildRecord();
        expect(parent.pid).toBeGreaterThan(0);
        expect(grandchild.ppid).toBe(parent.pid);
        expect(grandchild.token).toBe(parent.token);
        // Identity is provable while both are alive.
        expect(() => verifyOwnership(parent)).not.toThrow();
        expect(() => verifyOwnership(grandchild)).not.toThrow();
        expect(isProcessAlive(grandchild.pid)).toBe(true);

        // Parent stops itself and its grandchild; SIGTERM is the ordinary stop.
        proc.kill('SIGTERM');
        const info = await proc.waitForExit(5_000);
        expect(info.code).toBe(0);
        await waitFor(() => readProcessTableEntry(grandchild.pid) === undefined, {
          timeoutMs: 3_000,
          label: 'grandchild gone after SIGTERM',
        });
      } finally {
        await proc.cleanup();
      }
    });
  }, 15_000);

  it('crash mode orphans its grandchild (the real failure the launcher must handle)', async () => {
    await withRoot('crash', async (root) => {
      const proc = FixtureProcess.spawn(
        { label: 'crash', mode: 'crash', exitCode: 7, grandchild: true },
        root,
      );
      const grandchild = await proc.waitForGrandchildRecord();
      try {
        await proc.waitForReady();
        const info = await proc.waitForExit(5_000);
        expect(info.code).toBe(7);
        // The grandchild is still a live orphan, with verifiable identity.
        expect(readProcessTableEntry(grandchild.pid)).toBeDefined();
        expect(() => verifyOwnership(grandchild)).not.toThrow();
      } finally {
        await proc.reapGrandchild('SIGKILL');
        await proc.cleanup();
      }
      await waitFor(() => readProcessTableEntry(grandchild.pid) === undefined, {
        timeoutMs: 3_000,
        label: 'orphan grandchild reaped',
      });
    });
  }, 15_000);

  it('stubborn mode ignores SIGTERM and is only stopped by SIGKILL', async () => {
    await withRoot('stubborn', async (root) => {
      const proc = FixtureProcess.spawn({ label: 'stubborn', mode: 'stubborn' }, root);
      try {
        await proc.waitForReady();
        const record = await proc.waitForRecord();
        proc.kill('SIGTERM');
        await proc.waitForSignal('SIGTERM');
        // It recorded the signal but stayed alive; a bounded wait proves the
        // escalation is required instead of assuming a sleep duration.
        await expect(proc.waitForExit(400)).rejects.toBeInstanceOf(GateTimeoutError);
        expect(() => verifyOwnership(record)).not.toThrow();
        proc.kill('SIGKILL');
        const info = await proc.waitForExit(5_000);
        expect(info.signal).toBe('SIGKILL');
      } finally {
        await proc.cleanup();
      }
    });
  }, 15_000);

  it('refuses to signal a PID whose token or start time does not match (negative control)', async () => {
    await withRoot('identity', async (root) => {
      const control = spawnControlProcess('unrelated-control', root);
      try {
        const record = await control.waitForRecord();
        // Wrong token: refuse, do not kill the unrelated process.
        expect(() => killGuarded({ ...record, token: 'not-the-token' })).toThrow(OwnershipError);
        expect(readProcessTableEntry(record.pid)).toBeDefined();
        // Stale start time (PID-reuse shape): refuse.
        expect(() =>
          verifyOwnership({ ...record, startTime: 'Thu Jan  1 00:00:00 1970' }),
        ).toThrow(OwnershipError);
        // Gone PID: refuse.
        expect(() =>
          verifyOwnership({ pid: 2 ** 30, token: record.token, startTime: record.startTime }),
        ).toThrow(OwnershipError);
        // The control process is still alive after every refusal.
        expect(isProcessAlive(record.pid)).toBe(true);
        expect(() => verifyOwnership(record)).not.toThrow();
      } finally {
        await control.cleanup();
      }
    });
  }, 15_000);

  it('binds a real loopback endpoint, answers a probe and releases the port on stop', async () => {
    await withRoot('loopback', async (root) => {
      const proc = FixtureProcess.spawn({ label: 'bind', mode: 'bind', port: 0 }, root);
      try {
        const ready = await proc.waitForReady();
        expect(ready.port).toBeGreaterThan(0);
        const port = ready.port as number;
        const probe = await httpProbe(`http://127.0.0.1:${port}/`);
        expect(probe.status).toBe(200);
        expect(probe.body).toBe('ok');
        expect(await isLoopbackPortBound(port)).toBe(true);

        proc.kill('SIGTERM');
        await proc.waitForExit(5_000);
        await waitFor(async () => !(await isLoopbackPortBound(port)), {
          timeoutMs: 3_000,
          label: 'port released after stop',
        });
      } finally {
        await proc.cleanup();
      }
    });
  }, 15_000);

  it('reports a real EADDRINUSE for a conflicting port without killing the occupant', async () => {
    await withRoot('conflict', async (root) => {
      const occupied = await occupyLoopbackPort();
      const proc = FixtureProcess.spawn(
        { label: 'conflict', mode: 'bind', port: occupied.port },
        root,
      );
      try {
        const info = await proc.waitForExit(5_000);
        expect(info.code).toBe(40);
        // The occupant we allocated is not the fixture; it must be untouched.
        expect(await isLoopbackPortBound(occupied.port)).toBe(true);
      } finally {
        await proc.cleanup();
        await occupied.close();
      }
    });
  }, 15_000);

  it('times out a never-ready fixture with a bounded gate error instead of hanging', async () => {
    await withRoot('never-ready', async (root) => {
      const proc = FixtureProcess.spawn({ label: 'never-ready', mode: 'never-ready' }, root);
      try {
        await expect(proc.waitForReady(300)).rejects.toBeInstanceOf(GateTimeoutError);
        // The process is alive but not ready: the gate, not the process, timed out.
        expect(readProcessTableEntry((await proc.waitForRecord()).pid)).toBeDefined();
      } finally {
        await proc.cleanup();
      }
    });
  }, 15_000);

  it('keeps two instances on one dataRoot with separate canaries and an untouched host HOME', async () => {
    const before = captureHostDefaults();
    const fixture = createDualInstanceFixture('dual');
    try {
      expect(fixture.instanceA.canaryValue).not.toBe(fixture.instanceB.canaryValue);
      expect(fixture.instanceA.canaryFile).not.toBe(fixture.instanceB.canaryFile);
      expect(fixture.readCanary(fixture.instanceA)).toContain(fixture.instanceA.canaryValue);
      expect(fixture.readCanary(fixture.instanceB)).toContain(fixture.instanceB.canaryValue);

      const a = FixtureProcess.spawn(
        { label: 'inst-a', mode: 'hold', env: fixture.envFor(fixture.instanceA) },
        fixture.root.path,
      );
      const b = FixtureProcess.spawn(
        { label: 'inst-b', mode: 'hold', env: fixture.envFor(fixture.instanceB) },
        fixture.root.path,
      );
      try {
        const recordA = await a.waitForRecord();
        const recordB = await b.waitForRecord();
        expect(recordA.env?.HOME).toBe(fixture.instanceA.home);
        expect(recordB.env?.HOME).toBe(fixture.instanceB.home);
        expect(recordA.env?.DSH_HOME).toBe(fixture.instanceA.dshHome);
        expect(recordB.env?.DSH_HOME).toBe(fixture.instanceB.dshHome);
        // Both instances point at the *same* dataRoot.
        expect(recordA.env?.HDSL_DATA_ROOT).toBe(fixture.sharedDataRoot);
        expect(recordB.env?.HDSL_DATA_ROOT).toBe(fixture.sharedDataRoot);
      } finally {
        await a.cleanup();
        await b.cleanup();
      }

      const after = captureHostDefaults();
      expect(diffHostDefaults(before, after).equal).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 15_000);

  it('manufactures adversarial lock inputs and refuses PID reuse without killing an unrelated process', async () => {
    await withRoot('lock', async (root) => {
      const fixture = new LockFixture({ directory: join(root, 'locks'), host: 'qa-host' });
      expect(isStale(fixture.staleOwner())).toBe(true);
      expect(isStale(fixture.freshOwner())).toBe(false);
      expect(hasForeignHost(fixture.foreignHostOwner(), 'qa-host')).toBe(true);

      // A live unrelated process plus a PID-reuse-shaped owner record. The
      // guard must refuse the record and the process must survive.
      const control = spawnControlProcess('lock-control', root);
      try {
        const live = await control.waitForRecord();
        const reuse = fixture.pidReuseRecord(live);
        expect(reuse.pid).toBe(live.pid);
        expect(reuse.startTime).not.toBe(live.startTime);
        expect(() =>
          verifyOwnership({ pid: reuse.pid, token: live.token, startTime: reuse.startTime }),
        ).toThrow(OwnershipError);
        expect(readProcessTableEntry(live.pid)).toBeDefined();
      } finally {
        await control.cleanup();
      }

      const corruptPath = fixture.writeRaw('lock.json', CORRUPT_LOCK_BYTES);
      expect(readFileSync(corruptPath, 'utf8')).toBe(CORRUPT_LOCK_BYTES);
      const gate = fixture.contentionGate('race');
      expect(gate.isOpen()).toBe(false);
      gate.open();
      expect(gate.isOpen()).toBe(true);
    });
  }, 15_000);

  it('detects a wrong close/lock/writer order and accepts the canonical one (negative control)', async () => {
    await withRoot('ledger', async (root) => {
      const wrong = new OrderingLedger(join(root, 'wrong.jsonl'));
      wrong.append('writer', 'lock-held');
      wrong.append('writer', 'lock-released');
      wrong.append('writer', 'writer-exit');
      // Releasing the lock before the writer exited is exactly the M1 hole.
      expect(() =>
        assertOrdered(
          wrong,
          { actor: 'writer', event: 'writer-exit' },
          { actor: 'writer', event: 'lock-released' },
        ),
      ).toThrow(OrderViolationError);
      // A missing observable event fails rather than skipping.
      expect(() =>
        assertOrdered(
          wrong,
          { actor: 'next', event: 'next-acquire' },
          { actor: 'writer', event: 'writer-exit' },
        ),
      ).toThrow(OrderViolationError);

      const good = new OrderingLedger(join(root, 'good.jsonl'));
      good.append('writer', 'writer-exit');
      good.append('core', 'lock-release');
      good.append('next', 'next-acquire');
      expect(() =>
        assertOrdered(good, { actor: 'writer', event: 'writer-exit' }, { actor: 'core', event: 'lock-release' }),
      ).not.toThrow();
      expect(() =>
        assertOrdered(good, { actor: 'core', event: 'lock-release' }, { actor: 'next', event: 'next-acquire' }),
      ).not.toThrow();
    });
  });

  it('detects overlapping writers (three-party lock risk) and accepts a serialized order', async () => {
    await withRoot('writers', async (root) => {
      const overlap = new OrderingLedger(join(root, 'overlap.jsonl'));
      overlap.append('A', 'writer-enter');
      overlap.append('B', 'writer-enter');
      overlap.append('B', 'writer-exit');
      overlap.append('A', 'writer-exit');
      expect(() => assertNoConcurrentWriters(overlap)).toThrow(OrderViolationError);

      const neverExited = new OrderingLedger(join(root, 'open.jsonl'));
      neverExited.append('A', 'writer-enter');
      neverExited.append('B', 'writer-enter');
      expect(() => assertNoConcurrentWriters(neverExited)).toThrow(OrderViolationError);

      const serialized = new OrderingLedger(join(root, 'serialized.jsonl'));
      for (const id of ['A', 'B', 'C']) {
        serialized.append(id, 'writer-enter');
        serialized.append(id, 'writer-exit');
      }
      expect(() => assertNoConcurrentWriters(serialized)).not.toThrow();
    });
  });

  it('has a complete, labelled, gated scenario plan that is still blocked on the candidate', () => {
    const ids = PROCESS_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of PROCESS_SCENARIOS) {
      expect(scenario.determinismGate.length).toBeGreaterThan(0);
      expect(scenario.requirements.length).toBeGreaterThan(0);
      expect(scenario.requires.length).toBeGreaterThan(0);
      if (scenario.status === 'blocked') {
        expect(scenario.blocker).toBeDefined();
      } else {
        expect(scenario.blocker).toBeUndefined();
      }
    }
    const covered = new Set(PROCESS_SCENARIOS.flatMap((scenario) => scenario.requires));
    for (const capability of REQUIRED_CAPABILITIES) {
      expect(covered.has(capability)).toBe(true);
    }
    // Current state: the blockers are concrete, unique and non-empty.
    const blockers = candidateBlockers();
    expect(blockers.length).toBeGreaterThan(0);
    expect(new Set(blockers).size).toBe(blockers.length);
  });

  it('allocates a genuinely free loopback port', async () => {
    const port = await getFreeLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(await isLoopbackPortBound(port)).toBe(false);
  });
});
