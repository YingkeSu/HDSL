/**
 * OPT-IN real A2 Tier 2 cross-version evidence (#131).
 *
 * Not part of the default unit run. It performs a REAL managed install of the
 * second supported DSH release (`0.1.7-rc.1`) and of the baseline
 * (`0.1.5-rc.2`) on macOS ARM64, starts each through the real managed process
 * path (SIGTERM stop), and then exercises `generations.restore` across the real
 * data-format boundary to prove the non-blocking `dshCompatibilityWarning`.
 *
 * Run explicitly:
 *
 * ```sh
 * HDSL_REAL_CROSS_VERSION=1 HDSL_EVIDENCE_KEEP=1 \
 * HDSL_REAL_CROSS_VERSION_DATA_ROOT=/tmp/hdsl-131-evidence \
 *   pnpm exec vitest run tests/install/real-cross-version.evidence.test.ts --reporter=verbose
 * ```
 *
 * It downloads the official Node and DSH artifacts, runs the managed Node's
 * `npm ci`, and starts the real DSH WebUI. No model call is made and no personal
 * credential is read: the launch environment is the production credential port
 * with no bindings. The upstream `token=` ready line never reaches this output.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_VERSION, createContractRuntime, type GenerationSummary } from '@hdsl/contracts';
import {
  ChangeApplyService,
  ChangePlanStore,
  EnvironmentStore,
  OperationStore,
  createManagedInstall,
  generationPaths,
} from '@hdsl/core';
import {
  VERIFIED_COMBINATIONS,
  createCredentialInjection,
  createGenerationRuntimeVerifier,
  createLaunchCredentialPort,
  createProcessManager,
  createRuntimePort,
  isProcessAlive,
  type OsCredentialProvider,
  type ProcessManager,
} from '@hdsl/runtime';
import { adaptProcessPort } from '../../apps/desktop/src/main/composition.js';

const enabled = process.env['HDSL_REAL_CROSS_VERSION'] === '1';
const keep = process.env['HDSL_EVIDENCE_KEEP'] === '1';
const dataRoot =
  process.env['HDSL_REAL_CROSS_VERSION_DATA_ROOT'] ??
  mkdtempSync(join(tmpdir(), 'hdsl-131-evidence-'));

const snapshotHome = (): string[] => {
  const dshHome = join(homedir(), '.dsh');
  return existsSync(dshHome) ? readdirSync(dshHome).sort() : [];
};

const combinationFor = (dshVersion: string, nodeVersion: string) => {
  const combination = VERIFIED_COMBINATIONS.find(
    (entry) => entry.dsh.version === dshVersion && entry.node.version === nodeVersion,
  );
  if (combination === undefined) {
    throw new Error(`catalog has no ${dshVersion} + node ${nodeVersion} combination`);
  }
  return combination;
};

describe.skipIf(!enabled)('real cross-version restore evidence (opt-in, #131)', () => {
  it(
    'installs/starts 0.1.7-rc.1 and warns on a real downgrade restore to 0.1.5-rc.2',
    async () => {
      const homeBefore = snapshotHome();
      const runId = String(Date.now());
      const baseline = combinationFor('0.1.5-rc.2', '22.19.0');
      const tier2 = combinationFor('0.1.7-rc.1', '22.19.0');

      let processManager: ProcessManager | undefined;
      const managed = await createManagedInstall({
        dataRoot,
        catalog: VERIFIED_COMBINATIONS,
        // Production profile initialization so each generation carries the
        // immutable declaration source that `restore` re-publishes.
        runtime: createRuntimePort({ profileInit: true }),
        operationTimeoutMs: 30 * 60_000,
        processFactory: (service) => {
          // Disposable, non-functional canary: no model call is made and the
          // real keychain is never read (the OS provider is a stub).
          const provider: OsCredentialProvider = {
            store: 'keychain',
            read: () => Promise.resolve('hdsl-131-canary-no-model-call'),
          };
          const credentials = createLaunchCredentialPort({
            load: async (environmentId) => {
              const environment = service.findEnvironment(environmentId);
              if (!environment.ok || environment.value.activeGenerationId === null) {
                throw new Error('environment has no active generation');
              }
              const paths = generationPaths(
                service.layout,
                environmentId,
                environment.value.activeGenerationId,
              );
              return {
                bindings: [
                  {
                    name: 'DEEPSEEK_API_KEY',
                    reference: {
                      id: 'hdsl-131-evidence',
                      store: 'keychain',
                      key: `hdsl-131-evidence#${environmentId}`,
                    },
                  },
                ],
                baseEnv: {
                  HOME: paths.homeDirectory,
                  DSH_HOME: paths.homeDirectory,
                  DSH_AGENTS_HOME: join(paths.homeDirectory, 'agents'),
                  PATH: [
                    join(paths.generationDirectory, 'node', 'bin'),
                    '/usr/bin',
                    '/bin',
                    '/usr/sbin',
                    '/sbin',
                  ].join(':'),
                  TMPDIR: join(paths.homeDirectory, '.tmp'),
                },
              };
            },
            injection: createCredentialInjection({ provider }),
          });
          processManager = createProcessManager({
            dataRoot,
            credentials,
            isRecoveryPermitted: () => service.available,
            onProcessExit: (info) => {
              service.handleProcessExit(info);
            },
          });
          return adaptProcessPort(processManager);
        },
      });

      const contract = createContractRuntime({ port: managed.port });
      const operations = new OperationStore(managed.service.layout);
      const environments = new EnvironmentStore(managed.service.layout);
      // The managed-install entry does not wire the change-apply adapter; the
      // evidence drives the real restore transaction directly on the same
      // durable layout (same code path as `generations.restore`).
      const changeApply = new ChangeApplyService({
        layout: managed.service.layout,
        plans: new ChangePlanStore(managed.service.layout),
        environments,
        operations,
        compositionDigest: (lock) => JSON.stringify(lock.plugins),
        verifyGenerationRuntime: createGenerationRuntimeVerifier(),
      });

      const dispatch = (method: string, input: unknown): unknown => {
        const result = contract.dispatch({ apiVersion: API_VERSION, method: method as never, input } as never) as
          | { readonly ok: true; readonly value: unknown }
          | { readonly ok: false; readonly code?: string; readonly message?: string };
        expect(result.ok, `${method}: ${JSON.stringify(result)}`).toBe(true);
        if (!result.ok) {
          throw new Error(`${method} rejected with ${String(result.code)}`);
        }
        return result.value;
      };

      const waitOp = async (operationId: string) => {
        const snapshot = await managed.waitForOperation(operationId, { timeoutMs: 30 * 60_000 });
        expect(snapshot.status, JSON.stringify(snapshot)).toBe('succeeded');
        return snapshot;
      };

      const currentEnvironment = () => {
        const listed = managed.service.listEnvironments();
        if (!listed.ok || listed.value.length === 0) {
          throw new Error('no environment was created');
        }
        const environmentId = listed.value[0]?.id;
        if (environmentId === undefined) {
          throw new Error('no environment was created');
        }
        const found = managed.service.findEnvironment(environmentId);
        if (!found.ok) {
          throw new Error('the environment disappeared');
        }
        const record = environments.read(environmentId);
        if (record === undefined) {
          throw new Error('the environment record disappeared');
        }
        return { environmentId, environment: found.value, record };
      };

      const warningOf = (operationId: string): string | null | undefined => {
        const record = operations.read(operationId);
        const output = record?.output as GenerationSummary | undefined;
        return output?.dshCompatibilityWarning;
      };

      const restoreAndWarn = async (targetGenerationId: string): Promise<string | null | undefined> => {
        const { environmentId, environment } = currentEnvironment();
        const outcome = changeApply.restoreGeneration({
          requestId: `evidence-${runId}-restore-${String(Date.now())}-${targetGenerationId.slice(-6)}`,
          environmentId,
          expectedRevision: environment.revision,
          targetGenerationId,
        });
        expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
        if (!outcome.ok) {
          throw new Error(`restore rejected with ${outcome.code}`);
        }
        await waitOp(outcome.value.operationId);
        return warningOf(outcome.value.operationId);
      };

      const startStop = async (label: string) => {
        const { environmentId, environment } = currentEnvironment();
        const start = dispatch('environments.start', {
          requestId: `evidence-${runId}-start-${label}`,
          environmentId,
          expectedRevision: environment.revision,
        }) as { operationId: string };
        await waitOp(start.operationId);
        expect(currentEnvironment().environment.state).toBe('running');

        const origin = processManager?.openWebUI(environmentId);
        expect(origin?.ok, JSON.stringify(origin)).toBe(true);
        const loopbackOrigin = origin?.ok ? origin.value.loopbackOrigin : '';
        expect(loopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const response = await fetch(loopbackOrigin);
        // DSH answers a token-free bootstrap with 401 (T001 R004).
        expect(response.status).toBe(401);

        const afterStart = currentEnvironment();
        expect(afterStart.record.lastStartedDshVersion).toBeDefined();
        const launchRecord = processManager?.readLaunchRecord(environmentId);
        const pid = launchRecord?.identity?.pid ?? -1;

        const stop = dispatch('environments.stop', {
          requestId: `evidence-${runId}-stop-${label}`,
          environmentId,
          expectedRevision: afterStart.environment.revision,
        }) as { operationId: string };
        await waitOp(stop.operationId);
        expect(currentEnvironment().environment.state).toBe('stopped');
        expect(isProcessAlive(pid)).toBe(false);
        await expect(fetch(loopbackOrigin)).rejects.toBeDefined();
        return { loopbackOrigin, pid, dshVersion: afterStart.record.lastStartedDshVersion };
      };

      // --- install the Tier 2 release into a fresh generation -----------------
      const created = dispatch('environments.create', {
        requestId: `evidence-${runId}-create-tier2`,
        name: `evidence-tier2-${runId}`,
        catalogCombinationId: tier2.id,
      }) as { operationId: string };
      await waitOp(created.operationId);
      const first = currentEnvironment();
      const tier2Generation = first.environment.activeGenerationId;
      expect(tier2Generation).not.toBeNull();
      if (tier2Generation === null) {
        return;
      }
      expect(first.environment.state).toBe('stopped');
      const tier2Manifest = managed.service.readInstallManifest(first.environmentId, {
        generationId: tier2Generation,
      });
      expect(tier2Manifest.installMode).toBe('npm-ci');
      expect(tier2Manifest.dsh.version).toBe('0.1.7-rc.1');
      expect(tier2Manifest.closure?.packageCount).toBe(586);

      const tier2Paths = generationPaths(managed.service.layout, first.environmentId, tier2Generation);
      const tier2Node = join(tier2Paths.nodeDirectory, 'bin', 'node');
      const tier2Entry = join(
        tier2Paths.dshDirectory,
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js',
      );
      const reportedVersion = execFileSync(tier2Node, [tier2Entry, '-V'], {
        encoding: 'utf8',
        env: {
          HOME: tier2Paths.homeDirectory,
          DSH_HOME: tier2Paths.homeDirectory,
          PATH: `${join(tier2Paths.nodeDirectory, 'bin')}:/usr/bin:/bin`,
        },
      }).trim();
      expect(reportedVersion).toBe('0.1.7-rc.1');

      // --- switch to the baseline and restore back before any start ------------
      const switched = dispatch('environments.switchCombination', {
        requestId: `evidence-${runId}-switch-baseline`,
        environmentId: first.environmentId,
        expectedRevision: first.environment.revision,
        catalogCombinationId: baseline.id,
      }) as { operationId: string };
      await waitOp(switched.operationId);
      const afterSwitch = currentEnvironment();
      const baselineGeneration = afterSwitch.environment.activeGenerationId;
      expect(baselineGeneration).not.toBeNull();
      if (baselineGeneration === null) {
        return;
      }
      expect(afterSwitch.environment.state).toBe('stopped');
      expect(afterSwitch.environment.revision).toBe(first.environment.revision + 1);
      expect(
        managed.service.readInstallManifest(first.environmentId, { generationId: baselineGeneration })
          .dsh.version,
      ).toBe('0.1.5-rc.2');

      // Unknown last-started version: no warning, restore still moves the pointer.
      const unknownWarning = await restoreAndWarn(tier2Generation);
      expect(unknownWarning ?? null).toBeNull();

      // --- real start of 0.1.7-rc.1 (ready + SIGTERM, no residue) --------------
      const tier2Run = await startStop('tier2');
      expect(tier2Run.dshVersion).toBe('0.1.7-rc.1');

      // Same DSH version as the last start: no warning.
      const sameWarning = await restoreAndWarn(tier2Generation);
      expect(sameWarning ?? null).toBeNull();

      // Real downgrade: target 0.1.5-rc.2 is older than last-started 0.1.7-rc.1.
      const downgradeWarning = await restoreAndWarn(baselineGeneration);
      expect(typeof downgradeWarning).toBe('string');
      expect(downgradeWarning).toContain('0.1.5-rc.2');
      expect(downgradeWarning).toContain('0.1.7-rc.1');
      // Non-blocking: the pointer moved, the revision advanced, both generations survive.
      const afterDowngrade = currentEnvironment();
      expect(afterDowngrade.environment.activeGenerationId).toBe(baselineGeneration);
      expect(afterDowngrade.environment.revision).toBe(afterSwitch.environment.revision + 2);
      expect(existsSync(tier2Paths.generationDirectory)).toBe(true);

      // --- real start of 0.1.5-rc.2, then a real upgrade restore --------------
      const baselineRun = await startStop('baseline');
      expect(baselineRun.dshVersion).toBe('0.1.5-rc.2');

      const upgradeWarning = await restoreAndWarn(tier2Generation);
      expect(upgradeWarning ?? null).toBeNull();

      // --- host isolation ------------------------------------------------------
      expect(snapshotHome()).toEqual(homeBefore);

      // eslint-disable-next-line no-console
      console.log(
        `HDSL_REAL_CROSS_VERSION_EVIDENCE ${JSON.stringify(
          {
            dataRoot,
            environmentId: first.environmentId,
            tier2CombinationId: tier2.id,
            baselineCombinationId: baseline.id,
            tier2Generation,
            baselineGeneration,
            tier2Install: {
              dshVersion: tier2Manifest.dsh.version,
              packageCount: tier2Manifest.closure?.packageCount,
              lockSha256: tier2Manifest.closure?.lockSha256,
              treeDigest: tier2Manifest.dsh.treeDigest,
              reportedVersion,
            },
            runtimeEvidence: {
              tier2: { loopbackOrigin: tier2Run.loopbackOrigin, pid: tier2Run.pid },
              baseline: { loopbackOrigin: baselineRun.loopbackOrigin, pid: baselineRun.pid },
            },
            warnings: {
              unknown: unknownWarning ?? null,
              same: sameWarning ?? null,
              downgrade: downgradeWarning ?? null,
              upgrade: upgradeWarning ?? null,
            },
            homeUntouched: true,
          },
          null,
          2,
        )}`,
      );

      await managed.close();
      if (!keep) {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    3_600_000,
  );
});
