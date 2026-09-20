/**
 * Fixture-harness self-check for `tests/e2e` (T007c, parent #7).
 *
 * These tests do **not** exercise the launcher. The `#6` candidate does not
 * exist yet (`apps/desktop/src/main/index.ts` still throws the T006
 * placeholder), so every desktop scenario in
 * `scenarios/desktop-e2e-scenario-plan.ts` is `blocked` and no Electron window
 * is driven here.
 *
 * What is proven is that the QA harness itself is real, deterministic and safe:
 * registered-resource cleanup that reports failures instead of swallowing them,
 * a host-HOME guard whose diff can actually fail, canary planting/scanning with
 * a working positive control, reference-config secret oracles, deterministic
 * gates with a bounded failure path, and a candidate-readiness detector that
 * reacts to each missing capability.
 *
 * Green here means "the harness is trustworthy", never "the desktop flow works".
 * Run: `pnpm exec vitest run tests/e2e/harness.test.ts`
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildReferenceOnlyConfig,
  createCanary,
  CREDENTIAL_CONFIG_MAX_BYTES_EXPECTED,
  DEFAULT_DIAGNOSTICS_EXCLUSIONS,
  findForbiddenConfigKeys,
  findSecretHits,
  isDefaultExcluded,
  isWithinCredentialConfigLimit,
  plantUpstreamCredentialArtifacts,
} from './support/canary.js';
import {
  assessDesktopCandidate,
  isExactVersion,
  probeDesktopCandidate,
} from './support/desktop-candidate.js';
import { createFileGate, GateTimeoutError, OrderingLedger, waitFor } from './support/gates.js';
import {
  captureHostGuard,
  createIsolatedDataRootFixture,
  HOST_GUARD_PATHS,
} from './support/isolated-data-root.js';
import {
  assertCleanupSucceeded,
  assertRunCleaned,
  CleanupFailureError,
  DuplicateResourceError,
  QaResourceRegistry,
  RunResidueError,
} from './support/resources.js';
import { diffTrees, snapshotTree } from './support/tree.js';
import {
  DESKTOP_E2E_SCENARIOS,
  type PlannedScenario,
  uncoveredRequirements,
  validateScenarioPlan,
} from './scenarios/desktop-e2e-scenario-plan.js';

const withRegistry = async (body: (registry: QaResourceRegistry) => Promise<void>): Promise<void> => {
  const registry = new QaResourceRegistry();
  try {
    await body(registry);
  } finally {
    const report = await registry.cleanup();
    assertCleanupSucceeded(report);
  }
};

describe('desktop E2E harness: registered resources', () => {
  it('removes this run\'s roots and preserves an unregistered sentinel outside them', async () => {
    const sentinel = mkdtempSync(join(tmpdir(), 'hdsl-external-sentinel-'));
    const registry = new QaResourceRegistry();
    const base = registry.baseDirectory;
    try {
      const first = registry.registerTempRoot('iso-a');
      const second = registry.registerTempRoot('iso-b');
      writeFileSync(join(first, 'canary.txt'), 'temp only\n');
      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(true);
      expect(first.startsWith(base)).toBe(true);
      expect(sentinel.startsWith(base)).toBe(false);

      const report = await registry.cleanup();
      assertCleanupSucceeded(report);
      // Only this run's own base directory is checked and removed.
      expect(existsSync(base)).toBe(false);
      assertRunCleaned(base);
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      rmSync(sentinel, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports a failing disposer instead of swallowing it, and still runs the rest', async () => {
    const registry = new QaResourceRegistry();
    registry.register('good-first', () => undefined);
    registry.register('bad', () => {
      throw new Error('registered cleanup exploded');
    });
    registry.register('good-last', () => undefined);

    const report = await registry.cleanup();

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.label).toBe('bad');
    expect(report.failed[0]?.message).toContain('exploded');
    expect(report.disposed).toEqual(['good-last', 'good-first']);
    expect(() => assertCleanupSucceeded(report)).toThrow(CleanupFailureError);
  });

  it('refuses duplicate labels so a resource cannot be silently dropped', () => {
    const registry = new QaResourceRegistry();
    registry.register('dup', () => undefined);
    expect(() => registry.register('dup', () => undefined)).toThrow(DuplicateResourceError);
  });

  it('detects this run\'s residue instead of reporting a clean run', () => {
    const registry = new QaResourceRegistry();
    const base = registry.baseDirectory;
    try {
      writeFileSync(join(base, 'left-behind.txt'), 'residue\n');
      expect(() => assertRunCleaned(base)).toThrow(RunResidueError);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    assertRunCleaned(base);
  });
});

describe('desktop E2E harness: host-HOME guard', () => {
  it('reacts to added, changed and removed entries (the guard can fail)', async () => {
    await withRegistry(async (registry) => {
      const root = registry.registerTempRoot('guard');
      const guarded = join(root, 'guarded');
      mkdirSync(guarded);
      const file = join(guarded, 'marker.txt');
      writeFileSync(file, 'one\n');

      const baseline = snapshotTree(guarded);
      expect(diffTrees(baseline, snapshotTree(guarded)).equal).toBe(true);

      writeFileSync(join(guarded, 'added.txt'), 'new\n');
      const afterAdd = diffTrees(baseline, snapshotTree(guarded));
      expect(afterAdd.equal).toBe(false);
      expect(afterAdd.added).toContain('added.txt');

      writeFileSync(file, 'two\n');
      const afterChange = diffTrees(baseline, snapshotTree(guarded));
      expect(afterChange.changed).toContain('marker.txt');

      rmSync(file);
      const afterRemove = diffTrees(baseline, snapshotTree(guarded));
      expect(afterRemove.removed).toContain('marker.txt');

      // A symlink is recorded as a symlink, not as its target (lstatSync).
      const target = join(guarded, 'target.txt');
      writeFileSync(target, 'target\n');
      const link = join(guarded, 'link.txt');
      symlinkSync(target, link);
      const symlinkEntry = snapshotTree(guarded).find((entry) => entry.relPath === 'link.txt');
      expect(symlinkEntry?.kind).toBe('symlink');
      expect(existsSync(link)).toBe(true);
    });
  });

  it('lists the real default locations the launcher must not write', () => {
    expect(HOST_GUARD_PATHS.length).toBeGreaterThan(0);
    expect(HOST_GUARD_PATHS.some((path) => path.endsWith('.dsh'))).toBe(true);
    expect(captureHostGuard().map((snapshot) => snapshot.path)).toEqual([...HOST_GUARD_PATHS]);
  });
});

describe('desktop E2E harness: canary and secret oracles', () => {
  it('plants upstream credential artifacts and finds the canary, but never invents a hit', async () => {
    await withRegistry(async (registry) => {
      const root = registry.registerTempRoot('canary');
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      const canary = createCanary('positive');
      const planted = plantUpstreamCredentialArtifacts(home, canary);

      const hits = findSecretHits(root, canary);
      expect(hits).toContain('home/.credentials.yaml');
      expect(hits).toContain('home/logs/boot.log');
      expect(existsSync(planted.credentialFile)).toBe(true);

      expect(findSecretHits(root, createCanary('absent'))).toEqual([]);
      rmSync(planted.credentialFile);
      rmSync(planted.logFile);
      expect(findSecretHits(root, canary)).toEqual([]);
    });
  });

  it('excludes the upstream secret artifacts and credential reference store by default', () => {
    expect(DEFAULT_DIAGNOSTICS_EXCLUSIONS.length).toBeGreaterThan(0);
    expect(isDefaultExcluded('environments/env-1/home/.credentials.yaml')).toBe(true);
    expect(isDefaultExcluded('environments/env-1/home/logs/boot.log')).toBe(true);
    expect(isDefaultExcluded('environments/env-1/home/logs/nested/deep.log')).toBe(true);
    expect(isDefaultExcluded('environments/env-1/credentials.json')).toBe(true);
    // Negative control: the policy must not exclude everything.
    expect(isDefaultExcluded('environments/env-1/home/config/settings.json')).toBe(false);
    expect(isDefaultExcluded('environments/env-1/generations/g1/composition.lock.json')).toBe(false);
  });

  it('accepts a reference-only config and rejects secret-bearing or oversized ones', () => {
    const referenceOnly = buildReferenceOnlyConfig([
      {
        name: 'MODEL_API_KEY',
        reference: { id: 'ref-1', store: 'keychain', key: 'hdsl/env-1/model-api' },
      },
    ]);
    expect(findForbiddenConfigKeys(referenceOnly)).toEqual([]);
    expect(isWithinCredentialConfigLimit(referenceOnly)).toBe(true);

    const withValue = JSON.stringify({ references: [{ id: 'r', store: 'keychain', key: 'k' }], value: 'sk-live-value' });
    expect(findForbiddenConfigKeys(withValue)).toEqual(['value']);

    const withToken = JSON.stringify({ token: 'sk-live-value' });
    expect(findForbiddenConfigKeys(withToken)).toEqual(['token']);

    const oversized = 'x'.repeat(CREDENTIAL_CONFIG_MAX_BYTES_EXPECTED + 1);
    expect(isWithinCredentialConfigLimit(oversized)).toBe(false);
    // Still a reference-only key set: size, not keys, is what fails here.
    expect(findForbiddenConfigKeys(oversized)).toEqual([]);
  });
});

describe('desktop E2E harness: deterministic gates', () => {
  it('blocks until a file gate opens, then resolves and records order', async () => {
    await withRegistry(async (registry) => {
      const root = registry.registerTempRoot('gate');
      const gate = createFileGate(join(root, 'release'));
      const ledger = new OrderingLedger();

      const waiting = waitFor(() => gate.isOpen(), { timeoutMs: 2_000, label: 'release gate' });
      ledger.mark('qa', 'wait-started');
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(gate.isOpen()).toBe(false);

      gate.open();
      ledger.mark('qa', 'gate-opened');
      await waiting;
      ledger.mark('qa', 'wait-resolved');

      expect(() => ledger.assertOrdered('qa:gate-opened', 'qa:wait-resolved')).not.toThrow();
      expect(() => ledger.assertOrdered('qa:wait-resolved', 'qa:gate-opened')).toThrow();
    });
  });

  it('fails closed and bounded on a gate that never opens', async () => {
    const startedAtIndex = Date.now();
    await expect(
      waitFor(() => false, { timeoutMs: 200, intervalMs: 20, label: 'never-opens' }),
    ).rejects.toBeInstanceOf(GateTimeoutError);
    expect(Date.now() - startedAtIndex).toBeLessThan(2_000);

    await expect(
      waitFor(() => false, { timeoutMs: 100, intervalMs: 10, label: 'labelled-gate' }),
    ).rejects.toThrow(/labelled-gate/);
  });
});

describe('desktop E2E harness: candidate readiness detector', () => {
  it('reports ready only when window, IPC and preload wiring all exist', () => {
    const wired = { windowBootstrap: true, ipcHandlers: true, preloadBridge: true, placeholderMarker: false };
    expect(assessDesktopCandidate(wired)).toEqual({ ready: true, blockers: [] });

    expect(assessDesktopCandidate({ ...wired, windowBootstrap: false }).ready).toBe(false);
    expect(assessDesktopCandidate({ ...wired, ipcHandlers: false }).blockers).toEqual([
      'main entry registers no ipcMain handler for the whitelisted contract methods',
    ]);
    expect(assessDesktopCandidate({ ...wired, preloadBridge: false }).blockers).toEqual([
      'preload entry does not expose the narrow bridge via contextBridge',
    ]);
    // The placeholder alone blocks even if some wiring appears.
    expect(
      assessDesktopCandidate({ ...wired, placeholderMarker: true, windowBootstrap: false }).ready,
    ).toBe(false);
  });

  it('probes the real workspace and reports the wired candidate honestly', () => {
    const probe = probeDesktopCandidate();
    // Concrete observation, not a tautology: the candidate at this branch's base
    // wires the window, IPC handlers and the sandboxed contextBridge, and the
    // T006 placeholder is gone. A regression here must turn this red.
    expect(probe.descriptor).toEqual({
      windowBootstrap: true,
      ipcHandlers: true,
      preloadBridge: true,
      placeholderMarker: false,
    });
    expect(probe.assessment).toEqual({ ready: true, blockers: [] });
    expect(probe.electronVersion).not.toBeNull();
    expect(probe.electronVersion).toBe('44.4.3');
    expect(isExactVersion(probe.electronVersion ?? '')).toBe(true);
    expect(isExactVersion('44.4.3-beta')).toBe(false);
    expect(isExactVersion('^44.4.3')).toBe(false);
  });
});

describe('desktop E2E harness: isolated dataRoot fixture', () => {
  it('keeps two instances separate, isolates env, and leaves the host guard unchanged', async () => {
    const hostBefore = captureHostGuard();
    await withRegistry(async (registry) => {
      const fixture = createIsolatedDataRootFixture(registry, 'iso');
      expect(fixture.instances).toHaveLength(2);
      const [first, second] = fixture.instances;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (first === undefined || second === undefined) {
        return;
      }

      expect(first.canaryValue).not.toBe(second.canaryValue);
      expect(findSecretHits(first.dshHome, first.canaryValue)).toHaveLength(2);
      expect(findSecretHits(first.dshHome, second.canaryValue)).toEqual([]);
      expect(existsSync(first.markerFile)).toBe(true);

      const env = fixture.envFor(first.id);
      expect(env['HDSL_DATA_ROOT']).toBe(fixture.dataRoot);
      expect(env['HOME']?.startsWith(fixture.root)).toBe(true);
      expect(env['DSH_HOME']?.startsWith(fixture.root)).toBe(true);
    });

    expect(captureHostGuard()).toEqual(hostBefore);
  });
});

describe('desktop E2E harness: scenario plan consistency', () => {
  it('has no violations and covers every FR-001..FR-008', () => {
    expect(validateScenarioPlan(DESKTOP_E2E_SCENARIOS)).toEqual([]);
    expect(uncoveredRequirements(DESKTOP_E2E_SCENARIOS)).toEqual([]);
  });

  it('rejects an inconsistent plan entry (validator negative control)', () => {
    const broken: PlannedScenario = {
      id: 'E2E-BROKEN',
      title: 'deliberately invalid',
      requirements: ['nope'],
      lane: 'ssr-markup',
      evidence: 'fixture',
      realUi: true,
      determinismGate: '',
      negativeControl: '',
      requires: [],
      status: 'blocked',
      // blocker intentionally omitted
    };
    const problems = validateScenarioPlan([broken]).map((violation) => violation.problem);
    expect(problems).toContain('malformed requirement id: nope');
    expect(problems).toContain('must declare a determinism gate');
    expect(problems).toContain('must declare a negative control');
    expect(problems).toContain('blocked scenario must state a blocker');
    expect(
      problems.some((problem) => problem.startsWith('realUi scenario must run the real Electron window')),
    ).toBe(true);
    expect(problems).toContain('must declare required capabilities');
  });

  it('never accepts SSR or the demo as a substitute for a real UI scenario', () => {
    const substitute: PlannedScenario = {
      id: 'E2E-SUBSTITUTE',
      title: 'SSR pretending to be the real window',
      requirements: ['FR-001'],
      lane: 'ssr-markup',
      evidence: 'fixture',
      realUi: true,
      determinismGate: 'static markup',
      negativeControl: 'none',
      requires: ['electron.window'],
      status: 'ready',
    };
    const problems = validateScenarioPlan([substitute]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain('must run the real Electron window');
  });
});
