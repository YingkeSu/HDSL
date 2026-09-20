/**
 * Executable install integration tests (T007a / issue #31) over the public T004
 * API: `createRuntimePort` (`@hdsl/runtime`) + `createManagedInstall`
 * (`@hdsl/core`) + `createContractRuntime(...).dispatch(...)`.
 *
 * These are real tests, not skipped placeholders. If the public exports
 * disappear, this file fails to compile; if a scenario regresses, the test
 * fails. The only conditional cases are:
 * - `INST-DISK-02`: a real mounted tiny volume, which needs macOS `hdiutil`
 *   (documented platform gate; the injected variant runs everywhere).
 * - the real-closure group: opt-in via `HDSL_QA_REAL_INSTALL=1` because it
 *   downloads Node/DSH and runs `npm ci` (network + ~1 GB + minutes). It was
 *   executed explicitly for the T004 candidate and its evidence recorded in
 *   `docs/development/install-validation.md`.
 *
 * Re-verified on production candidate `ccaaeb94a691ac943adf7a0ba471285349d1953f`
 * (PR #35), which merged to `main` as
 * `dbf0ef00a4c090f10928ffad5a1d1ac1cdfd7033`. The issue #37/#39 regressions were
 * first reproduced on the earlier candidate
 * `9fb42d2fd78ea2bcb3cc4aacb629851476624175`; INST-RECOVER-01 uses a held
 * download so that regression is deterministic rather than timing-dependent.
 */
import { createManagedInstall } from '@hdsl/core';
import { VERIFIED_COMBINATIONS, createRuntimePort } from '@hdsl/runtime';
import { describe, it } from 'vitest';

import { COMPOSITION_A, COMPOSITION_B, buildComposition } from './support/catalog-fixtures.js';
import {
  scenarioArtifactsOnlyCannotCommit,
  scenarioConcurrentSameCombination,
  scenarioDigestMismatch,
  scenarioDiskFullInjected,
  scenarioDiskFullRealVolume,
  scenarioDownloadInterruption,
  scenarioHostHomeUnchanged,
  scenarioIdempotentReplayAcrossRestart,
  scenarioInconsistentCatalog,
  scenarioJournalRecovery,
  scenarioJournalRecoveryAcrossRestart,
  scenarioPathSafety,
  scenarioRealClosureCompleteness,
  scenarioRecoverDuringInFlightCreate,
  scenarioRequestIdAcrossRestart,
  scenarioTwoEnvironmentIsolation,
  type ArtifactSource,
  type InstallScenarioDeps,
} from './scenarios/install-scenarios.js';

const deps: InstallScenarioDeps = { createManagedInstall, createRuntimePort };

/** Synthetic tarballs + explicit artifacts-only fixture gate. */
const fixtureSource = (): ArtifactSource => {
  const a = buildComposition(COMPOSITION_A);
  const b = buildComposition(COMPOSITION_B);
  return {
    routes: [...a.routes, ...b.routes],
    catalogFor: (origin) => [a.combinationFor(origin), b.combinationFor(origin)],
    mode: 'fixtures',
  };
};

/** Audited real catalog with the default `npm ci` closure (network). */
const realSource = (): ArtifactSource => ({
  routes: [],
  catalogFor: () => VERIFIED_COMBINATIONS,
  mode: 'real',
});

describe('install boundary (synthetic fixtures)', () => {
  it('INST-ISO-01F two distinct compositions stay isolated', () =>
    scenarioTwoEnvironmentIsolation(deps, fixtureSource()), 60_000);

  it('INST-AO-GATE-01 artifacts-only cannot commit on the production path', () =>
    scenarioArtifactsOnlyCannotCommit(deps), 60_000);

  it('INST-DIG-01 digest mismatch is a terminal DIGEST_MISMATCH', () =>
    scenarioDigestMismatch(deps), 60_000);

  it('INST-CAT-01 inconsistent catalog is rejected before any operation', () =>
    scenarioInconsistentCatalog(deps), 60_000);

  it('INST-DL-01 interrupted download is a terminal DOWNLOAD_FAILED', () =>
    scenarioDownloadInterruption(deps), 60_000);

  it('INST-DISK-01 injected disk-full guard is a terminal DISK_FULL', () =>
    scenarioDiskFullInjected(deps), 60_000);

  it('INST-PATH-01 rejects traversal and supports spaces + non-ASCII paths', () =>
    scenarioPathSafety(deps), 60_000);

  it('INST-HOME-01 host HOME and ~/.dsh are untouched', () =>
    scenarioHostHomeUnchanged(deps), 60_000);

  it('INST-JRN-01 journal recovery (in-process)', () => scenarioJournalRecovery(deps), 60_000);

  it('INST-JRN-02 journal recovery across a real restart', () =>
    scenarioJournalRecoveryAcrossRestart(deps), 60_000);

  // Issue #39: intentionally red until recover() guards active transactions.
  it('INST-RECOVER-01 recover() must not roll back an in-flight install', () =>
    scenarioRecoverDuringInFlightCreate(deps), 60_000);

  it('INST-IDEM-01 requestId replay on the same service', () =>
    scenarioIdempotentReplayAcrossRestart(deps, fixtureSource()), 60_000);

  it('INST-IDEM-02 requestId replay across a real restart', () =>
    scenarioRequestIdAcrossRestart(deps), 60_000);

  it('INST-CONC-01 concurrent same-combination create keeps the cache intact', () =>
    scenarioConcurrentSameCombination(deps), 60_000);

  it('INST-CONC-02 concurrent same-combination with one failed transfer', () =>
    scenarioConcurrentSameCombination(deps, { failFirst: true }), 60_000);

  // Platform gate: a real tiny HFS+ volume needs macOS `hdiutil`.
  it.skipIf(process.platform !== 'darwin')(
    'INST-DISK-02 real tiny volume is a terminal DISK_FULL',
    () => scenarioDiskFullRealVolume(deps),
    60_000,
  );
});

const realEnabled = process.env['HDSL_QA_REAL_INSTALL'] === '1';

describe.skipIf(!realEnabled)('install real closure (opt-in, network)', () => {
  it(
    'INST-ISO-01 real two-composition isolation with npm-ci',
    () => scenarioTwoEnvironmentIsolation(deps, realSource()),
    30 * 60_000,
  );

  it(
    'INST-COMP-REAL-01 real closure manifest, lock and preflight binding',
    () => scenarioRealClosureCompleteness(deps, VERIFIED_COMBINATIONS),
    30 * 60_000,
  );
});
