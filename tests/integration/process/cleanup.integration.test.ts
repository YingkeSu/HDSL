/**
 * QA cleanup-isolation evidence for the lock harness (issue #45).
 *
 * Proves that cleanup closes harness-owned managed instances (so a heartbeat
 * cannot recreate a removed directory) and removes exactly the roots the
 * harness registered — a foreign sentinel is left untouched, so the cleanup is
 * targeted, not a broad glob. Both the normal path and a thrown scenario are
 * covered so a failing test cannot silently leak.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLockHarness,
  cleanupQaRoots,
  registerQaPath,
  registeredQaRoots,
} from './support/install-harness.js';

const sentinels: string[] = [];

afterEach(async () => {
  const report = await cleanupQaRoots();
  for (const sentinel of sentinels.splice(0)) {
    rmSync(sentinel, { recursive: true, force: true });
  }
  if (report.failed.length > 0) {
    throw new Error(`cleanup reported failures: ${JSON.stringify(report.failed)}`);
  }
});

describe('QA cleanup isolation', () => {
  it('PROC-CLEANUP normal: removes exactly the registered harness roots', async () => {
    const harness = await buildLockHarness({});
    const roots = registeredQaRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(existsSync(root)).toBe(true);
    }

    await harness.managed.close();

    const sentinel = mkdtempSync(join(tmpdir(), 'hdsl-foreign-sentinel-'));
    sentinels.push(sentinel);
    const report = await cleanupQaRoots();
    expect(report.failed).toHaveLength(0);

    for (const root of roots) {
      expect(existsSync(root)).toBe(false);
    }
    // A broad glob over `hdsl-*` would have deleted this; targeted cleanup must not.
    expect(existsSync(sentinel)).toBe(true);
    expect(registeredQaRoots()).toHaveLength(0);
  }, 30_000);

  it('PROC-CLEANUP failure: a thrown scenario still removes its roots in finally', async () => {
    let roots: readonly string[] = [];
    try {
      await buildLockHarness({});
      roots = registeredQaRoots();
      expect(roots.length).toBeGreaterThan(0);
      throw new Error('simulated scenario failure before close');
    } catch {
      // expected: the scenario failed before it could close
    } finally {
      const report = await cleanupQaRoots();
      expect(report.failed).toHaveLength(0);
    }
    for (const root of roots) {
      expect(existsSync(root)).toBe(false);
    }
    expect(registeredQaRoots()).toHaveLength(0);
  }, 30_000);

  it('PROC-CLEANUP reports a removal failure instead of swallowing it', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hdsl-foreign-readonly-'));
    sentinels.push(parent);
    const child = join(parent, 'locked-child');
    mkdirSync(child, { recursive: true });
    registerQaPath(child);
    chmodSync(parent, 0o500);
    try {
      const report = await cleanupQaRoots();
      expect(report.failed.map((failure) => failure.path)).toContain(child);
    } finally {
      chmodSync(parent, 0o700);
    }
  }, 30_000);
});
