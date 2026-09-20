/**
 * Shared installation scenarios for issue #31 / T007a.
 *
 * These functions drive the **public** T004 surface only:
 * `createRuntimePort` (`@hdsl/runtime`) + `createManagedInstall` (`@hdsl/core`)
 * + `createContractRuntime(...).dispatch(...)`. They never import an internal
 * module. They are plain async functions (not `*.test.ts`), so the vitest run
 * stays green until T004 lands a runnable interface. A thin runner later maps
 * each function to an `it()` case.
 *
 * Fault-labeling policy (issue #31): every injected fault is named in the case
 * id and asserted through the observable contract (`operation` terminal code /
 * environment state), never through the fault flag itself. A scenario must
 * never claim "real disk" while using `forceDiskFull`, and synthetic tarballs
 * must never be cited as proof that a real DSH is runnable.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { EnvironmentSummary, RuntimeCombination } from '@hdsl/contracts';
import { createContractRuntime } from '@hdsl/contracts';

import { buildComposition, COMPOSITION_A } from '../support/catalog-fixtures.js';
import { buildPathTraversalArtifact } from '../support/artifacts.js';
import { expectedCompositionDigest } from '../support/composition.js';
import { createInjectedEnospcSink } from '../support/disk-fault.js';
import { sha256Hex } from '../support/hash.js';
import type {
  CreationFaults,
  CreateManagedInstall,
  CreateRuntimePort,
  EnvironmentService,
  HostPlatform,
  ManagedInstall,
  RuntimePortOptions,
} from '../support/managed-install-api.js';
import {
  assertManifestArtifactsOnly,
  assertManifestRealClosure,
  readManifest,
} from '../support/manifest.js';
import type { LocalEndpoint, RouteFixture } from '../support/local-endpoint.js';
import { startLocalEndpoint } from '../support/local-endpoint.js';
import { call, pollTerminalOperation, requireError, requireOk, waitForJournalPhase, walkFiles, type InstallRuntime } from '../support/scenario.js';
import {
  captureHostDefaults,
  createTempRoot,
  diffHostDefaults,
  type HostDefaults,
  type TempRoot,
  withIsolatedEnv,
} from '../support/temp-env.js';
import { mountTinyVolume } from '../support/tiny-volume.js';

export interface InstallScenarioDeps {
  readonly createManagedInstall: CreateManagedInstall;
  readonly createRuntimePort: CreateRuntimePort;
}

export interface HarnessOptions {
  readonly label: string;
  readonly routes: readonly RouteFixture[];
  readonly catalogFor: (origin: string) => readonly RuntimeCombination[];
  readonly creationFaults?: CreationFaults;
  readonly runtimeOptions?: RuntimePortOptions;
  /** Explicit fixture gate; absent means the production create gate applies. */
  readonly fixtures?: { readonly allowArtifactsOnly?: boolean };
  /** Fixture/runtime host; defaults to the only verified host (darwin/arm64). */
  readonly host?: HostPlatform;
  /** Override the data root, e.g. a mounted tiny volume. */
  readonly dataRootFor?: (root: TempRoot) => string;
  /** Bounded operation/terminal timeout; real npm-ci installs need minutes. */
  readonly operationTimeoutMs?: number;
}

export interface InstallHarness {
  readonly root: TempRoot;
  readonly dataRoot: string;
  readonly endpoint: LocalEndpoint;
  readonly install: ManagedInstall;
  readonly service: EnvironmentService;
  readonly api: InstallRuntime;
  readonly catalog: readonly RuntimeCombination[];
  readonly hostBefore: HostDefaults;
  findEnvironmentIdByName(name: string): string;
  assertHostDefaultsUnchanged(): void;
}

/**
 * Opens a real install service over a real temporary root and loopback
 * endpoint, runs `body`, then closes the service/endpoint and removes the temp
 * root. HOME/DSH_HOME are redirected for the whole lifetime so any default-root
 * bug lands in the sandbox.
 */
export const withInstallHarness = async (
  deps: InstallScenarioDeps,
  options: HarnessOptions,
  body: (harness: InstallHarness) => Promise<void>,
): Promise<void> => {
  const root = createTempRoot(options.label);
  const dataRoot = options.dataRootFor?.(root) ?? join(root.path, 'data');
  try {
    await withIsolatedEnv(root.path, async () => {
      const endpoint = await startLocalEndpoint(options.routes);
      const catalog = options.catalogFor(endpoint.origin);
      const hostBefore = captureHostDefaults();
      const host = options.host ?? { platform: 'darwin', arch: 'arm64' };
      const runtimePort = deps.createRuntimePort({
        host,
        // Synthetic artifacts are never a complete closure; T004 records
        // `installMode: artifacts-only` so it cannot be mistaken for a real
        // install (confirmed by hdsl-15). Real scenarios override this.
        closureInstall: false,
        ...options.runtimeOptions,
      });
      let install: ManagedInstall | undefined;
      try {
        install = await deps.createManagedInstall({
          dataRoot,
          catalog,
          runtime: runtimePort,
          host,
          ...(options.creationFaults === undefined ? {} : { faults: options.creationFaults }),
          ...(options.fixtures === undefined ? {} : { fixtures: options.fixtures }),
          limits: { operationTimeoutMs: options.operationTimeoutMs ?? 20_000 },
        });
        const api: InstallRuntime = {
          port: install.port,
          runtime: createContractRuntime({ port: install.port }),
        };
        const findEnvironmentIdByName = (name: string): string => {
          const environments = requireOk(
            call(api, 'environments.list', {}),
            'environments.list',
          ) as readonly EnvironmentSummary[];
          const match = environments.find((environment) => environment.name === name);
          assert.ok(match !== undefined, `environment ${name} must exist`);
          return match.id;
        };
        const harness: InstallHarness = {
          root,
          dataRoot,
          endpoint,
          install,
          service: install.service,
          api,
          catalog,
          hostBefore,
          findEnvironmentIdByName,
          assertHostDefaultsUnchanged: () => {
            const diff = diffHostDefaults(hostBefore, captureHostDefaults());
            assert.ok(
              diff.equal,
              `host HOME/default dirs changed: ${JSON.stringify(diff.added.concat(diff.changed, diff.removed))}`,
            );
          },
        };
        await body(harness);
      } finally {
        await install?.close();
        await endpoint.close();
      }
    });
  } finally {
    root.cleanup();
  }
};

const createEnvironment = async (
  harness: InstallHarness,
  name: string,
  combinationId: string,
  requestId: string,
): Promise<string> => {
  const reference = requireOk(
    call(harness.api, 'environments.create', { requestId, name, catalogCombinationId: combinationId }),
    'environments.create',
  ) as { readonly operationId: string };
  return reference.operationId;
};

const listEnvironments = (harness: InstallHarness): readonly EnvironmentSummary[] =>
  requireOk(call(harness.api, 'environments.list', {}), 'environments.list') as readonly EnvironmentSummary[];

/** Shared shape for scenarios whose success depends on real or fixture artifacts. */
export interface ArtifactSource {
  readonly routes: readonly RouteFixture[];
  readonly catalogFor: (origin: string) => readonly RuntimeCombination[];
  /** `real` runs npm-ci; `fixtures` uses the explicit artifacts-only gate. */
  readonly mode: 'real' | 'fixtures';
}

/**
 * FR-001 / FR-002 / SC-001: two distinct exact compositions create two isolated
 * environments; digests match the frozen rule; no data or artifact crosses
 * over; the host home is untouched.
 *
 * Two modes:
 * - `fixtures`: synthetic tarballs with the explicit artifacts-only gate
 *   (`allowArtifactsOnly: true`); create succeeds and must record
 *   `installMode: artifacts-only` + `preflight.skipped`.
 * - `real`: the audited catalog with the default `npm ci` closure; create must
 *   record `installMode: npm-ci` + passing preflight. Network required.
 *
 * The production gate itself (an artifacts-only generation must NOT commit as
 * usable) is covered by {@link scenarioArtifactsOnlyCannotCommit}.
 */
export const scenarioTwoEnvironmentIsolation = async (
  deps: InstallScenarioDeps,
  source: ArtifactSource,
): Promise<void> => {
  const fixtureMode = source.mode === 'fixtures';
  await withInstallHarness(
    deps,
    {
      label: 'isolation',
      routes: source.routes,
      catalogFor: source.catalogFor,
      ...(fixtureMode
        ? {
            fixtures: { allowArtifactsOnly: true },
            runtimeOptions: { closureInstall: false, precheck: 'none' as const },
          }
        : { runtimeOptions: { closureInstall: true } }),
      // Real `npm ci` exceeds the fixture default; the service aborts the
      // operation once its own timeout elapses.
      operationTimeoutMs: fixtureMode ? 20_000 : 30 * 60_000,
    },
    async (harness) => {
      const [combinationA, combinationB] = harness.catalog;
      assert.ok(combinationA !== undefined && combinationB !== undefined, 'two catalog combinations are required');
      // Real `npm ci` installs take minutes; fixture installs are sub-second.
      const terminalTimeoutMs = fixtureMode ? 30_000 : 30 * 60_000;
      // Sequential: this case proves isolation, not concurrent installation
      // (concurrency is INST-CONC-01/02).
      const opA = await createEnvironment(harness, 'alpha', combinationA.id, 'req-iso-a');
      const a = await pollTerminalOperation(harness.api, opA, { label: 'create alpha', timeoutMs: terminalTimeoutMs });
      const opB = await createEnvironment(harness, 'beta', combinationB.id, 'req-iso-b');
      const b = await pollTerminalOperation(harness.api, opB, { label: 'create beta', timeoutMs: terminalTimeoutMs });
      assert.equal(a.status, 'succeeded', `alpha create status: ${JSON.stringify(a.error ?? null)}`);
      assert.equal(b.status, 'succeeded', `beta create status: ${JSON.stringify(b.error ?? null)}`);

      const environments = listEnvironments(harness);
      assert.equal(environments.length, 2);
      const summaryA = environments.find((environment) => environment.name === 'alpha');
      const summaryB = environments.find((environment) => environment.name === 'beta');
      assert.ok(summaryA !== undefined && summaryB !== undefined, 'both environments must be listed');
      assert.equal(summaryA.state, 'stopped');
      assert.equal(summaryB.state, 'stopped');
      assert.ok(summaryA.activeGenerationId !== null && summaryB.activeGenerationId !== null);
      assert.notEqual(summaryA.id, summaryB.id);

      assert.equal(summaryA.compositionDigest, expectedCompositionDigest(combinationA));
      assert.equal(summaryB.compositionDigest, expectedCompositionDigest(combinationB));

      // The persisted manifest must bind each environment to its own verified
      // root tarball. Real mode must prove a complete npm-ci closure + preflight;
      // fixture mode must be honestly labelled artifacts-only with preflight
      // skipped.
      const manifestA = await readManifest(harness.service, summaryA.id);
      const manifestB = await readManifest(harness.service, summaryB.id);
      if (fixtureMode) {
        assertManifestArtifactsOnly(manifestA, combinationA);
        assertManifestArtifactsOnly(manifestB, combinationB);
      } else {
        assertManifestRealClosure(manifestA, combinationA);
        assertManifestRealClosure(manifestB, combinationB);
      }

      harness.assertHostDefaultsUnchanged();
    },
  );
};

/** FR-002: a digest mismatch is a terminal failure, never a runnable env. */
export const scenarioDigestMismatch = async (deps: InstallScenarioDeps): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const routes = fixture.routes;
  // The catalog must advertise a digest that the downloaded bytes cannot match
  // (both the lock ref and the artifact source), otherwise `resolveComposition`
  // correctly fails the request before an operation exists.
  const catalogFor = (origin: string): readonly RuntimeCombination[] => {
    const combination = fixture.combinationFor(origin);
    const corrupt = corruptFirstNibble(combination.dsh.sha256);
    return [
      {
        ...combination,
        dsh: { ...combination.dsh, sha256: corrupt },
        artifactLocations: {
          ...combination.artifactLocations,
          dsh: { ...combination.artifactLocations.dsh, sha256: corrupt },
        },
      },
    ];
  };
  await withInstallHarness(deps, { label: 'digest', routes, catalogFor }, async (harness) => {
    const operationId = await createEnvironment(harness, 'bad-digest', COMPOSITION_A.id, 'req-digest');
    const snapshot = await pollTerminalOperation(harness.api, operationId);
    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.error?.code, 'DIGEST_MISMATCH');
    assert.equal(snapshot.error?.retryable, false, 'digest mismatch is deterministic, not retryable');
    const summary = listEnvironments(harness).find((environment) => environment.name === 'bad-digest');
    assert.ok(summary !== undefined);
    assert.equal(summary.state, 'error');
    assert.equal(summary.activeGenerationId, null);
    assert.equal(summary.compositionDigest, null);
    harness.assertHostDefaultsUnchanged();
  });
};

/** FR-002 / FR-006: a mid-stream download interruption is a terminal failure. */
export const scenarioDownloadInterruption = async (deps: InstallScenarioDeps): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const routes = fixture.routesWith({ dsh: 'truncate' });
  const catalogFor = (origin: string): readonly RuntimeCombination[] => [fixture.combinationFor(origin)];
  await withInstallHarness(deps, { label: 'download', routes, catalogFor }, async (harness) => {
    const operationId = await createEnvironment(harness, 'cut', COMPOSITION_A.id, 'req-cut');
    const snapshot = await pollTerminalOperation(harness.api, operationId);
    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.error?.code, 'DOWNLOAD_FAILED');
    const summary = listEnvironments(harness).find((environment) => environment.name === 'cut');
    assert.ok(summary !== undefined);
    assert.equal(summary.state, 'error');
    assert.equal(summary.activeGenerationId, null);
    const dshRequest = harness.endpoint.requests.find((request) => request.path.includes('dsh-'));
    assert.ok(dshRequest !== undefined, 'the dsh artifact must have been requested');
    assert.equal(dshRequest.completed, false, 'the truncated response must not look complete');
    harness.assertHostDefaultsUnchanged();
  });
};

/**
 * FR-002 guard: an internally inconsistent catalog (lock ref digest differs
 * from the artifact-source digest) must be rejected before any operation or
 * environment is created, not silently installed.
 */
export const scenarioInconsistentCatalog = async (deps: InstallScenarioDeps): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const catalogFor = (origin: string): readonly RuntimeCombination[] => {
    const combination = fixture.combinationFor(origin);
    return [
      {
        ...combination,
        dsh: { ...combination.dsh, sha256: corruptFirstNibble(combination.dsh.sha256) },
      },
    ];
  };
  await withInstallHarness(
    deps,
    { label: 'inconsistent-catalog', routes: fixture.routes, catalogFor },
    async (harness) => {
      const response = call(harness.api, 'environments.create', {
        requestId: 'req-inconsistent',
        name: 'inconsistent',
        catalogCombinationId: COMPOSITION_A.id,
      });
      assert.equal(requireError(response, 'environments.create').code, 'INTERNAL_ERROR');
      assert.deepEqual(listEnvironments(harness), [], 'no environment may be created');
      harness.assertHostDefaultsUnchanged();
    },
  );
};

/** Edge case / SC-003: injected disk-full guard terminates as DISK_FULL. */
export const scenarioDiskFullInjected = async (deps: InstallScenarioDeps): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const catalogFor = (origin: string): readonly RuntimeCombination[] => [fixture.combinationFor(origin)];
  await withInstallHarness(
    deps,
    {
      label: 'disk-injected',
      routes: fixture.routes,
      catalogFor,
      runtimeOptions: { faults: { forceDiskFull: true } },
    },
    async (harness) => {
      const operationId = await createEnvironment(harness, 'nospace', COMPOSITION_A.id, 'req-disk');
      const snapshot = await pollTerminalOperation(harness.api, operationId);
      assert.equal(snapshot.status, 'failed');
      assert.equal(snapshot.error?.code, 'DISK_FULL');
      const summary = listEnvironments(harness).find((environment) => environment.name === 'nospace');
      assert.ok(summary !== undefined);
      assert.equal(summary.state, 'error');
      harness.assertHostDefaultsUnchanged();
    },
  );
};

/**
 * Real disk pressure on a mounted tiny volume (macOS) with a `minFreeBytes`
 * threshold above the volume's free space. This measures real `statfs`, unlike
 * {@link scenarioDiskFullInjected}; the case id records which was used.
 */
export const scenarioDiskFullRealVolume = async (
  deps: InstallScenarioDeps,
  sizeMb = 2,
): Promise<void> => {
  const probe = createTempRoot('disk-probe');
  try {
    const volume = mountTinyVolume(probe.path, sizeMb);
    assert.ok(volume !== undefined, 'scenarioDiskFullRealVolume requires macOS hdiutil');
    const fixture = buildComposition(COMPOSITION_A);
    const catalogFor = (origin: string): readonly RuntimeCombination[] => [fixture.combinationFor(origin)];
    const dataRoot = join(volume.mountPath, 'hdsl-data');
    try {
      await withInstallHarness(
        deps,
        {
          label: 'disk-real',
          routes: fixture.routes,
          catalogFor,
          dataRootFor: () => dataRoot,
          runtimeOptions: { limits: { minFreeBytes: sizeMb * 1024 * 1024 * 4 } },
        },
        async (harness) => {
          const operationId = await createEnvironment(harness, 'real-nospace', COMPOSITION_A.id, 'req-realenospc');
          const snapshot = await pollTerminalOperation(harness.api, operationId);
          assert.equal(snapshot.status, 'failed');
          assert.equal(snapshot.error?.code, 'DISK_FULL');
        },
      );
    } finally {
      volume.detach();
    }
  } finally {
    probe.cleanup();
  }
};

/** Documents the injected ENOSPC sink used where a mounted volume is unavailable. */
export const scenarioInjectedEnospcSinkIsRealError = (): void => {
  const sink = createInjectedEnospcSink(2);
  sink.write(Buffer.alloc(2));
  assert.throws(() => sink.write(Buffer.alloc(1)));
};

/**
 * FR-001 / path safety: hostile archive entries must not write outside the
 * managed data root, and a path with spaces + non-ASCII characters must still
 * install inside its own root.
 */
export const scenarioPathSafety = async (deps: InstallScenarioDeps): Promise<void> => {
  const hostile = buildPathTraversalArtifact({
    kind: 'dsh',
    version: COMPOSITION_A.dshVersion,
    platform: 'darwin',
    arch: 'arm64',
    scope: 'env-hostile',
  });
  const nodeFixture = buildComposition(COMPOSITION_A).node;
  const catalogFor = (_origin: string): readonly RuntimeCombination[] => [
    {
      id: COMPOSITION_A.id,
      platform: 'darwin',
      arch: 'arm64',
      node: {
        version: nodeFixture.version,
        platform: nodeFixture.platform,
        arch: nodeFixture.arch,
        sha256: nodeFixture.sha256,
      },
      dsh: {
        version: hostile.version,
        platform: hostile.platform,
        arch: hostile.arch,
        sha256: hostile.sha256,
      },
      compatibility: { status: 'verified', evidenceRef: 'docs/research/dsh-compatibility.md' },
      artifactLocations: {
        node: {
          version: nodeFixture.version,
          platform: nodeFixture.platform,
          arch: nodeFixture.arch,
          url: '',
          sha256: nodeFixture.sha256,
        },
        dsh: {
          version: hostile.version,
          platform: hostile.platform,
          arch: hostile.arch,
          url: '',
          sha256: hostile.sha256,
        },
      },
    },
  ];
  const routes: RouteFixture[] = [
    { path: '/hostile-node.tgz', body: nodeFixture.bytes, mode: 'full' },
    { path: '/hostile-dsh.tgz', body: hostile.bytes, mode: 'full' },
  ];
  await withInstallHarness(
    deps,
    {
      label: 'path-safety',
      routes,
      // Rewrite the placeholder URLs to the live endpoint.
      catalogFor: (origin) => {
        const combinations = catalogFor(origin);
        return combinations.map((combination) => ({
          ...combination,
          artifactLocations: {
            node: { ...combination.artifactLocations.node, url: `${origin}/hostile-node.tgz` },
            dsh: { ...combination.artifactLocations.dsh, url: `${origin}/hostile-dsh.tgz` },
          },
        }));
      },
      dataRootFor: (root) => join(root.path, '中文 环境', '数据 根'),
    },
    async (harness) => {
      const operationId = await createEnvironment(harness, 'hostile', COMPOSITION_A.id, 'req-path');
      const snapshot = await pollTerminalOperation(harness.api, operationId);
      assert.equal(snapshot.status, 'failed', 'traversal entries must be rejected');
      // The escape targets: one level up from dataRoot, two levels up, and an
      // absolute /tmp path. None may exist.
      assert.equal(existsSync(join(harness.root.path, '中文 环境', 'hdsl-qa-escape.txt')), false);
      assert.equal(existsSync(join(harness.root.path, 'hdsl-qa-escape.txt')), false);
      assert.equal(existsSync('/tmp/hdsl-qa-absolute-escape.txt'), false);
    },
  );
};

/** FR-001: a successful (fixture-gated) install leaves the host HOME and ~/.dsh byte-identical. */
export const scenarioHostHomeUnchanged = async (deps: InstallScenarioDeps): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const catalogFor = (origin: string): readonly RuntimeCombination[] => [fixture.combinationFor(origin)];
  await withInstallHarness(
    deps,
    {
      label: 'host-home',
      routes: fixture.routes,
      catalogFor,
      fixtures: { allowArtifactsOnly: true },
      runtimeOptions: { closureInstall: false, precheck: 'none' },
    },
    async (harness) => {
      const operationId = await createEnvironment(harness, 'home-check', COMPOSITION_A.id, 'req-home');
      const snapshot = await pollTerminalOperation(harness.api, operationId);
      assert.equal(snapshot.status, 'succeeded', 'the fixture install must succeed before HOME is judged');
      harness.assertHostDefaultsUnchanged();
    },
  );
};

/**
 * FR-008: an interrupted (uncommitted) create is reconciled on the next start.
 * Requires `CreationFaults.pauseBeforeCommit`; the operation stays unfinished,
 * the journal is left for reconciliation, and `recover()` must terminate the
 * environment as `error` with no active generation.
 */
export const scenarioJournalRecovery = async (deps: InstallScenarioDeps): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const catalogFor = (origin: string): readonly RuntimeCombination[] => [fixture.combinationFor(origin)];
  await withInstallHarness(
    deps,
    {
      label: 'journal',
      routes: fixture.routes,
      catalogFor,
      creationFaults: { pauseBeforeCommit: true },
      // The fixture gate is required for the create to reach the commit pause
      // at all; the production gate would reject artifacts-only first.
      fixtures: { allowArtifactsOnly: true },
      runtimeOptions: { closureInstall: false, precheck: 'none' },
    },
    async (harness) => {
      const operationId = await createEnvironment(harness, 'paused', COMPOSITION_A.id, 'req-pause');
      // Wait for the durable `artifacts-installed` phase: the point is a paused
      // transaction left for reconciliation, not an in-flight install.
      await waitForJournalPhase(harness.dataRoot, 'artifacts-installed');
      const before = listEnvironments(harness).find((environment) => environment.name === 'paused');
      assert.ok(before !== undefined, 'a paused create must still be recorded');
      assert.equal(before.activeGenerationId, null, 'no generation pointer before commit');

      const transactions = join(harness.dataRoot, 'transactions');
      assert.equal(existsSync(transactions), true, 'journal directory must exist');
      assert.ok(
        countEntries(transactions) > 0,
        'an uncommitted journal entry must be present for reconciliation',
      );

      const report = await harness.install.recover();
      assert.notEqual(report, undefined, 'recover() must return a report');

      const after = listEnvironments(harness).find((environment) => environment.name === 'paused');
      assert.ok(after !== undefined);
      assert.equal(after.state, 'error');
      assert.equal(after.activeGenerationId, null);
      assert.equal(countEntries(transactions), 0, 'reconciled journal entries must be cleared');
      void operationId;
    },
  );
};

/** FR-008 / idempotency: a replayed requestId after restart keeps one operation. */
export const scenarioIdempotentReplayAcrossRestart = async (
  deps: InstallScenarioDeps,
  source: ArtifactSource,
): Promise<void> => {
  const fixtureMode = source.mode === 'fixtures';
  await withInstallHarness(
    deps,
    {
      label: 'idempotency',
      routes: source.routes,
      catalogFor: source.catalogFor,
      ...(fixtureMode
        ? {
            fixtures: { allowArtifactsOnly: true },
            runtimeOptions: { closureInstall: false, precheck: 'none' as const },
          }
        : {}),
    },
    async (harness) => {
      const first = requireOk(
        call(harness.api, 'environments.create', {
          requestId: 'req-replay',
          name: 'replay',
          catalogCombinationId: COMPOSITION_A.id,
        }),
        'environments.create(first)',
      ) as { readonly operationId: string };
      await pollTerminalOperation(harness.api, first.operationId);
      const requestCountAfterFirst = harness.endpoint.requests.length;

      const replay = requireOk(
        call(harness.api, 'environments.create', {
          requestId: 'req-replay',
          name: 'replay',
          catalogCombinationId: COMPOSITION_A.id,
        }),
        'environments.create(replay)',
      ) as { readonly operationId: string };
      assert.equal(replay.operationId, first.operationId, 'replay must return the original operation');
      assert.equal(
        harness.endpoint.requests.length,
        requestCountAfterFirst,
        'replay must not re-download artifacts',
      );
      harness.assertHostDefaultsUnchanged();
    },
  );
};

/**
 * Orchestrator ruling (2026-09-20, hdsl-2): T004 production create must not
 * commit an `artifacts-only` generation as a complete usable active
 * environment. This case forces the synthetic `closureInstall: false` mode and
 * asserts the public invariant: either the operation fails and no active
 * generation is written, or (defect) it commits as usable — never "artifacts-only
 * but fully successful". The T005 start-time re-check is defense in depth and
 * is tracked separately.
 */
export const scenarioArtifactsOnlyCannotCommit = async (deps: InstallScenarioDeps): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const catalogFor = (origin: string): readonly RuntimeCombination[] => [fixture.combinationFor(origin)];
  await withInstallHarness(
    deps,
    {
      label: 'artifacts-only-gate',
      routes: fixture.routes,
      catalogFor,
      runtimeOptions: { closureInstall: false, precheck: 'none' },
    },
    async (harness) => {
      const operationId = await createEnvironment(harness, 'artifacts-only', COMPOSITION_A.id, 'req-ao');
      const snapshot = await pollTerminalOperation(harness.api, operationId);
      const summary = listEnvironments(harness).find((environment) => environment.name === 'artifacts-only');
      assert.ok(summary !== undefined, 'the environment row must exist after the attempt');
      const usable =
        snapshot.status === 'succeeded' &&
        summary.activeGenerationId !== null &&
        (summary.state === 'stopped' || summary.state === 'running');
      assert.equal(
        usable,
        false,
        'artifacts-only must never commit as a complete usable active generation',
      );
      if (snapshot.status === 'failed') {
        assert.equal(summary.state, 'error');
        assert.equal(summary.activeGenerationId, null);
      }
      harness.assertHostDefaultsUnchanged();
    },
  );
};

/**
 * Real closure completeness (network required). Uses the audited real
 * `VERIFIED_COMBINATIONS` and the default `npm ci` closure, then checks the
 * manifest's lock digest, package count, npm version and preflight stdout.
 * This is the only case that may be reported as real `version`/`help` evidence;
 * it is `unmeasured` until run with network access on macOS ARM64.
 */
export const scenarioRealClosureCompleteness = async (
  deps: InstallScenarioDeps,
  combinations: readonly RuntimeCombination[],
): Promise<void> => {
  assert.ok(combinations.length > 0, 'need at least one verified catalog combination');
  const runs = combinations.slice(0, 2);
  await withInstallHarness(
    deps,
    {
      label: 'completeness-real',
      routes: [],
      catalogFor: () => combinations,
      runtimeOptions: { closureInstall: true },
      operationTimeoutMs: 30 * 60_000,
    },
    async (harness) => {
      for (const [index, combination] of runs.entries()) {
        const name = `real-${index}`;
        const operationId = await createEnvironment(harness, name, combination.id, `req-real-${index}`);
        const snapshot = await pollTerminalOperation(harness.api, operationId, {
          label: `real create ${combination.id}`,
          timeoutMs: 30 * 60_000,
        });
        assert.equal(snapshot.status, 'succeeded', `real install failed: ${JSON.stringify(snapshot.error ?? null)}`);
        const environmentId = harness.findEnvironmentIdByName(name);
        const manifest = await readManifest(harness.service, environmentId);
        assertManifestRealClosure(manifest, combination);
      }
      harness.assertHostDefaultsUnchanged();
    },
  );
};

/**
 * Issue #39 regression (correct behavior, intentionally red on 9fb42d2):
 * `recover()` must not roll back an operation whose install is still in flight
 * on the same instance. After the dust settles the operation and environment
 * must be consistent — never `operation failed` together with a usable
 * `stopped` environment that has an active generation.
 */
export const scenarioRecoverDuringInFlightCreate = async (
  deps: InstallScenarioDeps,
): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const routes = fixture.routesWith({ node: 'slow' });
  await withInstallHarness(
    deps,
    {
      label: 'recover-inflight',
      routes,
      catalogFor: (origin) => [fixture.combinationFor(origin)],
      fixtures: { allowArtifactsOnly: true },
      runtimeOptions: { closureInstall: false, precheck: 'none' },
    },
    async (harness) => {
      const operationId = await createEnvironment(harness, 'inflight', COMPOSITION_A.id, 'req-inflight');
      let recoverThrew = false;
      let report: unknown;
      try {
        report = await Promise.resolve(harness.install.recover());
      } catch (error) {
        recoverThrew = true;
        report = error instanceof Error ? error.message : String(error);
      }
      const snapshot = await pollTerminalOperation(harness.api, operationId, {
        label: 'in-flight create',
        timeoutMs: 30_000,
      });
      const environment = listEnvironments(harness).find((entry) => entry.name === 'inflight');
      assert.ok(environment !== undefined, 'the environment row must exist');
      const usable =
        (environment.state === 'stopped' || environment.state === 'running') &&
        environment.activeGenerationId !== null;
      const consistent =
        (snapshot.status === 'succeeded' && usable) ||
        (snapshot.status === 'failed' && environment.state === 'error' && environment.activeGenerationId === null);
      assert.ok(
        consistent,
        `recover() during an in-flight create left a split state: operation=${snapshot.status}(${snapshot.error?.code ?? 'none'}) environment=${environment.state} activeGenerationId=${String(environment.activeGenerationId)} recoverThrew=${String(recoverThrew)} report=${JSON.stringify(report)}`,
      );
      harness.assertHostDefaultsUnchanged();
    },
  );
};

const corruptFirstNibble = (digest: string): string => {
  const first = digest.slice(0, 1);
  return `${first === '0' ? '1' : '0'}${digest.slice(1)}`;
};

const countEntries = (dir: string): number => readdirSync(dir).length;

interface OpenInstallOptions {
  readonly dataRoot: string;
  readonly catalog: readonly RuntimeCombination[];
  readonly runtimeOptions?: RuntimePortOptions;
  readonly creationFaults?: CreationFaults;
  readonly fixtures?: { readonly allowArtifactsOnly?: boolean };
  readonly operationTimeoutMs?: number;
  readonly host?: HostPlatform;
}

const openInstall = async (
  deps: InstallScenarioDeps,
  options: OpenInstallOptions,
): Promise<{ readonly install: ManagedInstall; readonly api: InstallRuntime }> => {
  const host = options.host ?? { platform: 'darwin', arch: 'arm64' };
  const runtime = deps.createRuntimePort({ host, ...options.runtimeOptions });
  const install = await deps.createManagedInstall({
    dataRoot: options.dataRoot,
    catalog: options.catalog,
    runtime,
    host,
    ...(options.creationFaults === undefined ? {} : { faults: options.creationFaults }),
    ...(options.fixtures === undefined ? {} : { fixtures: options.fixtures }),
    limits: { operationTimeoutMs: options.operationTimeoutMs ?? 20_000 },
  });
  return { install, api: { port: install.port, runtime: createContractRuntime({ port: install.port }) } };
};

const listEnvironmentsOf = (api: InstallRuntime): readonly EnvironmentSummary[] =>
  requireOk(call(api, 'environments.list', {}), 'environments.list') as readonly EnvironmentSummary[];

const findByName = (api: InstallRuntime, name: string): EnvironmentSummary => {
  const match = listEnvironmentsOf(api).find((environment) => environment.name === name);
  assert.ok(match !== undefined, `environment ${name} must exist`);
  return match;
};

/**
 * FR-008 journal recovery across a real process restart: a paused (uncommitted)
 * create is left in the durable journal; a fresh service over the same
 * `dataRoot` reconciles it to `error` with no active generation and clears the
 * journal. Complements the in-process variant above.
 */
export const scenarioJournalRecoveryAcrossRestart = async (
  deps: InstallScenarioDeps,
): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const root = createTempRoot('journal-restart');
  try {
    await withIsolatedEnv(root.path, async () => {
      const endpoint = await startLocalEndpoint(fixture.routes);
      try {
        const catalog = [fixture.combinationFor(endpoint.origin)];
        const dataRoot = join(root.path, 'data');
        const runtimeOptions: RuntimePortOptions = { closureInstall: false, precheck: 'none' };
        const fixtures = { allowArtifactsOnly: true };

        const first = await openInstall(deps, {
          dataRoot,
          catalog,
          runtimeOptions,
          fixtures,
          creationFaults: { pauseBeforeCommit: true },
        });
        const created = requireOk(
          call(first.api, 'environments.create', {
            requestId: 'req-jrn-restart',
            name: 'paused',
            catalogCombinationId: COMPOSITION_A.id,
          }),
          'environments.create',
        ) as { readonly operationId: string };
        const transactions = join(dataRoot, 'transactions');
        // Wait for the durable pause before closing; closing an in-flight
        // install would abort and clean the journal instead of simulating a
        // crash between install and commit.
        await waitForJournalPhase(dataRoot, 'artifacts-installed');
        assert.ok(countEntries(transactions) > 0, 'uncommitted journal must be durable before restart');
        await first.install.close();

        const second = await openInstall(deps, { dataRoot, catalog, runtimeOptions, fixtures });
        const report = await Promise.resolve(second.install.recover());
        assert.ok(report.reconciled >= 1, 'restart recovery must reconcile the paused create');
        assert.ok(report.rolledBack >= 1, 'the paused create must roll back');
        assert.ok(report.details.some((detail) => detail.operationId === created.operationId));

        const environment = findByName(second.api, 'paused');
        assert.equal(environment.state, 'error');
        assert.equal(environment.activeGenerationId, null);
        assert.equal(countEntries(transactions), 0, 'reconciled journal must be cleared');
        await second.install.close();
      } finally {
        await endpoint.close();
      }
    });
  } finally {
    root.cleanup();
  }
};

/**
 * FR-008 idempotency across a real restart: the same `requestId` replayed by a
 * fresh service over the same `dataRoot` returns the original operation and
 * does not re-download artifacts.
 */
export const scenarioRequestIdAcrossRestart = async (
  deps: InstallScenarioDeps,
): Promise<void> => {
  const fixture = buildComposition(COMPOSITION_A);
  const root = createTempRoot('requestid-restart');
  try {
    await withIsolatedEnv(root.path, async () => {
      const endpoint = await startLocalEndpoint(fixture.routes);
      try {
        const catalog = [fixture.combinationFor(endpoint.origin)];
        const dataRoot = join(root.path, 'data');
        const runtimeOptions: RuntimePortOptions = { closureInstall: false, precheck: 'none' };
        const fixtures = { allowArtifactsOnly: true };

        const first = await openInstall(deps, { dataRoot, catalog, runtimeOptions, fixtures });
        const created = requireOk(
          call(first.api, 'environments.create', {
            requestId: 'req-idem-restart',
            name: 'replay',
            catalogCombinationId: COMPOSITION_A.id,
          }),
          'environments.create',
        ) as { readonly operationId: string };
        await pollTerminalOperation(first.api, created.operationId);
        const requestsAfterFirst = endpoint.requests.length;
        await first.install.close();

        const second = await openInstall(deps, { dataRoot, catalog, runtimeOptions, fixtures });
        const replay = requireOk(
          call(second.api, 'environments.create', {
            requestId: 'req-idem-restart',
            name: 'replay',
            catalogCombinationId: COMPOSITION_A.id,
          }),
          'environments.create(replay)',
        ) as { readonly operationId: string };
        assert.equal(replay.operationId, created.operationId, 'restart replay must return the original operation');
        assert.equal(
          endpoint.requests.length,
          requestsAfterFirst,
          'restart replay must not re-download artifacts',
        );
        const report = await Promise.resolve(second.install.recover());
        assert.ok(report.reconciled >= 0);
        const environment = findByName(second.api, 'replay');
        assert.equal(environment.state, 'stopped');
        assert.notEqual(environment.activeGenerationId, null);
        await second.install.close();
      } finally {
        await endpoint.close();
      }
    });
  } finally {
    root.cleanup();
  }
};

/**
 * Issue #37 regression: the content-addressed cache is immutable. Two creates
 * of the SAME combination run concurrently; the final cache file for each
 * artifact must still hash to the catalog digest, no `.part` staging file may
 * survive, and both generations must carry the same extracted tree digest.
 *
 * `failFirst: true` makes the first download of the node artifact truncate, so
 * one create fails while the other succeeds; a failed transfer must not corrupt
 * the cache or leave staging behind, and the failed operation must stay a clean
 * `DOWNLOAD_FAILED` terminal state.
 */
export const scenarioConcurrentSameCombination = async (
  deps: InstallScenarioDeps,
  options: { readonly failFirst?: boolean } = {},
): Promise<void> => {
  const failFirst = options.failFirst ?? false;
  const fixture = buildComposition(COMPOSITION_A);
  const routes = failFirst
    ? fixture.routesWith({ node: 'fail-first' })
    : fixture.routesWith({ node: 'slow' });
  await withInstallHarness(
    deps,
    {
      label: failFirst ? 'concurrent-fail' : 'concurrent',
      routes,
      catalogFor: (origin) => [fixture.combinationFor(origin)],
      fixtures: { allowArtifactsOnly: true },
      runtimeOptions: { closureInstall: false, precheck: 'none' },
    },
    async (harness) => {
      const combination = harness.catalog[0];
      assert.ok(combination !== undefined);
      const first = call(harness.api, 'environments.create', {
        requestId: 'req-conc-1',
        name: 'conc-1',
        catalogCombinationId: COMPOSITION_A.id,
      });
      const second = call(harness.api, 'environments.create', {
        requestId: 'req-conc-2',
        name: 'conc-2',
        catalogCombinationId: COMPOSITION_A.id,
      });
      const op1 = (requireOk(first, 'create conc-1') as { readonly operationId: string }).operationId;
      const op2 = (requireOk(second, 'create conc-2') as { readonly operationId: string }).operationId;
      const [snap1, snap2] = await Promise.all([
        pollTerminalOperation(harness.api, op1, { label: 'conc-1' }),
        pollTerminalOperation(harness.api, op2, { label: 'conc-2' }),
      ]);

      const succeeded = [snap1, snap2].filter((snapshot) => snapshot.status === 'succeeded');
      const failed = [snap1, snap2].filter((snapshot) => snapshot.status !== 'succeeded');
      assert.ok(succeeded.length >= 1, 'at least one concurrent create must succeed');
      if (!failFirst) {
        assert.equal(succeeded.length, 2, `both creates must succeed: ${JSON.stringify([snap1.error, snap2.error])}`);
      } else {
        for (const snapshot of failed) {
          assert.equal(snapshot.error?.code, 'DOWNLOAD_FAILED', 'a failed concurrent download must stay DOWNLOAD_FAILED');
        }
      }

      const environments = listEnvironmentsOf(harness.api);
      for (const snapshot of failed) {
        const environment = environments.find((entry) => entry.id === snapshot.environmentId);
        assert.ok(environment !== undefined);
        assert.equal(environment.state, 'error');
        assert.equal(environment.activeGenerationId, null);
      }

      // The final content-addressed cache must be intact for every artifact.
      for (const artifact of [combination.node, combination.dsh]) {
        const url = artifact === combination.node
          ? combination.artifactLocations.node.url
          : combination.artifactLocations.dsh.url;
        const fileName = basename(new URL(url).pathname);
        const cached = walkFiles(join(harness.dataRoot, 'artifacts')).filter((rel) => rel.endsWith(fileName));
        assert.ok(cached.length >= 1, `cached artifact ${fileName} must exist`);
        for (const rel of cached) {
          assert.equal(
            sha256Hex(readFileSync(join(harness.dataRoot, 'artifacts', rel))),
            artifact.sha256,
            `cached artifact ${rel} is polluted`, 
          );
        }
      }

      // No `.part`/staging leftovers under the data root, and the scratch dir is empty.
      const leftovers = walkFiles(harness.dataRoot).filter((rel) => rel.endsWith('.part'));
      assert.deepEqual(leftovers, [], 'no .part staging file may survive');
      assert.deepEqual(walkFiles(join(harness.dataRoot, 'tmp')), [], 'download scratch must be cleaned');

      // Successful generations must carry identical extracted trees (same artifact).
      if (succeeded.length === 2) {
        const names = ['conc-1', 'conc-2'];
        const manifests = names.map((name) => readManifest(harness.service, findByName(harness.api, name).id));
        assert.equal(manifests[0]?.dsh.treeDigest, manifests[1]?.dsh.treeDigest, 'concurrent generations must install identical DSH trees');
      }
      harness.assertHostDefaultsUnchanged();
    },
  );
};
