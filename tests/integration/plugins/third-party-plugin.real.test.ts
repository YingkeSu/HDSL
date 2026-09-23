/**
 * #98 — real third-party DSH plugin acceptance through the production launcher
 * chain (opt-in, macOS ARM64, no model call).
 *
 * The candidate is FIXED by the #98 Agent Brief and MUST NOT be replaced:
 *
 *   Hisn00w/ASu-skills @ feb77307b45e9c4a9890e385748eebe5a919eb1b
 *   (MIT; queried 2026-09-23, 5,031 stars; codeload archive
 *    sha256 a864cf2786c5e05408e6ce76195b6cb19a2be9fa24490617d220f1451325a663)
 *
 * The test drives the REAL production entry points only:
 *   createManagedInstall -> ChangePreviewService.previewChange ->
 *   ChangeApplyService.applyChange -> start/stop -> removal preview ->
 *   removal apply -> restart. It uses the real GitHub GitProvider, the real
 *   pinned managed pnpm executor, and an isolated temp dataRoot/HOME/DSH_HOME/
 *   TMPDIR. It never writes `allowBuilds`, never authorizes a build script and
 *   never calls a skill.
 *
 * Opt-in only (needs network for the pinned GitHub source + managed Node/DSH
 * artifacts/closure, and downloads the pinned pnpm):
 *
 *   HDSL_REAL_THIRD_PARTY_PLUGIN=1 \
 *     pnpm exec vitest run tests/integration/plugins/third-party-plugin.real.test.ts
 *
 * Set `HDSL_EVIDENCE_KEEP=1` to keep the temporary dataRoot for inspection.
 * Set `HDSL_98_EVIDENCE_FILE=<path>` to write the machine-readable acceptance
 * evidence JSON (the same payload printed as `HDSL_98_THIRD_PARTY_EVIDENCE`).
 *
 * Evidence boundary (see docs/development/plugin-real-third-party-validation.md):
 * - the ASu bundle patch contains exactly one LOAD-TIME `!!js` expression. The
 *   launcher has no public runtime-phase surface (#129 no-go), so this test does
 *   NOT claim to have observed its evaluated value. It records the composed row
 *   (`--dump-config` parses `!!js` as an expression, never evaluating it), the
 *   installed bytes against the pin, the existence of the directory the
 *   expression targets, the ready boot, and a process-level open-file probe.
 * - `install-time scripts == []` is NOT "no third-party code executes": the
 *   load-time `!!js` is a separate axis (see the validation doc).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ChangeApplyService,
  ChangePlanStore,
  ChangePreviewService,
  EnvironmentStore,
  OperationStore,
  createManagedInstall,
  environmentPaths,
  generationPaths,
  resolveLayout,
  type ManagedProcessPort,
} from '@hdsl/core';
import {
  PNPM_EXECUTOR_SPEC,
  VERIFIED_COMBINATIONS,
  computeCompositionDigest,
  createGenerationRuntimeVerifier,
  createGitHubPluginSource,
  createManagedPnpmExecutor,
  createPluginApplyPort,
  createPluginRemovalPort,
  createPosixProcessProbe,
  createProcessManager,
  createResolvingPreviewPort,
  createRuntimePort,
  type ProcessManager,
} from '@hdsl/runtime';

const enabled = process.env['HDSL_REAL_THIRD_PARTY_PLUGIN'] === '1';
const keep = process.env['HDSL_EVIDENCE_KEEP'] === '1';

/** Fixed #98 candidate pin. Any drift is a hard failure, never a re-selection. */
const CANDIDATE = {
  owner: 'Hisn00w',
  name: 'ASu-skills',
  ref: 'feb77307b45e9c4a9890e385748eebe5a919eb1b',
  packageName: 'asu-skills',
  packageVersion: '0.4.0',
  queriedAt: '2026-09-23',
  stars: 5031,
  manifestSha256: '3f97ad14125d544069a4d8f75cf8c233f34679077e0722cc620878e75088c7e2',
  patchSha256: 'd05da6d7fea17a111a59c986e301d3c7d470940f0c6da304a801c0f6bf3b3d56',
  entrySha256: '7ac439fd9c048f4c1ef7a9f5aa70c44e08950f4a433b16ce2cf958703965a45a',
  archiveSha256: 'a864cf2786c5e05408e6ce76195b6cb19a2be9fa24490617d220f1451325a663',
} as const;

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Adapts the runtime `ProcessManager` to core's narrower `ManagedProcessPort`
 * (the two differ only in `onPhase`'s parameter width; mirrors the desktop
 * composition adapter without importing Electron).
 */
const MANAGED_PROCESS_PHASES: ReadonlySet<string> = new Set([
  'spawning',
  'waiting-ready',
  'running',
  'stopping',
]);

const adaptProcessPort = (manager: ProcessManager): ManagedProcessPort => ({
  start: (request) =>
    manager.start({
      ...request,
      onPhase: (phase, progress) => {
        if (MANAGED_PROCESS_PHASES.has(phase)) {
          request.onPhase(phase as Parameters<typeof request.onPhase>[0], progress);
        }
      },
    }),
  stop: (request) =>
    manager.stop({
      ...request,
      onPhase: (phase, progress) => {
        if (MANAGED_PROCESS_PHASES.has(phase)) {
          request.onPhase(phase as Parameters<typeof request.onPhase>[0], progress);
        }
      },
    }),
  openWebUI: (environmentId) => manager.openWebUI(environmentId),
  recover: () => manager.recover(),
  close: () => manager.close(),
});

const waitPreviewOperation = async (
  service: ChangePreviewService,
  operationId: string,
  timeoutMs: number,
): Promise<{ readonly status: string; readonly output?: unknown; readonly error?: { readonly code?: string } }> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = service.findOperation(operationId);
    if (outcome !== undefined && outcome.ok) {
      const snapshot = outcome.value;
      if (['succeeded', 'failed', 'cancelled'].includes(snapshot.status)) {
        return snapshot as { readonly status: string; readonly output?: unknown; readonly error?: { readonly code?: string } };
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`preview operation ${operationId} did not terminate`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const waitApplyOperation = async (
  store: OperationStore,
  operationId: string,
  timeoutMs: number,
): Promise<{ readonly status: string; readonly error?: { readonly code?: string } }> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = store.read(operationId);
    if (record !== undefined && ['succeeded', 'failed', 'cancelled'].includes(record.status)) {
      return record as { readonly status: string; readonly error?: { readonly code?: string } };
    }
    if (Date.now() > deadline) {
      throw new Error(`apply operation ${operationId} did not terminate`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

describe.skipIf(!enabled)('real third-party DSH plugin acceptance (opt-in, #98)', () => {
  it(
    'previews, installs, boots, stops, removes and restarts the pinned ASu-skills candidate',
    async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-98-'));
      const notes: string[] = [];
      let managed: Awaited<ReturnType<typeof createManagedInstall>> | undefined;
      try {
        const combination = VERIFIED_COMBINATIONS.find((entry) => entry.node.version === '22.19.0');
        if (combination === undefined) {
          throw new Error('the verified catalog has no Node 22.19.0 combination');
        }

        // The managed runtime downloads the audited Node/DSH artifacts into its
        // own dataRoot cache; the host npm cache is deliberately not reused.
        const runtimePort = createRuntimePort({ profileInit: true });
        const credentials = {
          resolveLaunchEnvironment: async () => ({
            ok: true as const,
            value: { env: { DSH_QA_CANARY: 'qa-non-secret' }, dispose: () => undefined },
          }),
        };
        const processManager = createProcessManager({
          dataRoot,
          credentials,
          probe: createPosixProcessProbe(),
        });
        const processPort = adaptProcessPort(processManager);
        managed = await createManagedInstall({
          dataRoot,
          catalog: [combination],
          runtime: runtimePort,
          process: processPort,
          operationTimeoutMs: 40 * 60_000,
        });
        const service = managed.service;
        expect(managed.available).toBe(true);

        // ---- phase: create + managed install (baseline generation) ----
        const created = managed.service.createEnvironment({
          requestId: 'req-98-create',
          name: 'third-party-plugin',
          combination,
        });
        expect(created.ok, JSON.stringify(created)).toBe(true);
        if (!created.ok) {
          return;
        }
        const installed = await managed.waitForOperation(created.value.operationId, {
          timeoutMs: 40 * 60_000,
        });
        expect(installed.status, JSON.stringify(installed)).toBe('succeeded');
        const listedAfterInstall = service.listEnvironments();
        expect(listedAfterInstall.ok, JSON.stringify(listedAfterInstall)).toBe(true);
        if (!listedAfterInstall.ok) {
          return;
        }
        let environment = listedAfterInstall.value[0];
        const baselineGeneration = environment?.activeGenerationId;
        expect(baselineGeneration, JSON.stringify(environment)).toBeTruthy();
        if (environment === undefined || baselineGeneration == null) {
          return;
        }

        // ---- production adapters (real GitHub + real pinned pnpm executor) ----
        const executorIdentity = {
          id: 'pnpm',
          version: PNPM_EXECUTOR_SPEC.version,
          sha256: PNPM_EXECUTOR_SPEC.sha256,
          entrySha256: PNPM_EXECUTOR_SPEC.entrySha256,
          treeSha256: PNPM_EXECUTOR_SPEC.treeSha256,
        };
        const gitProvider = createGitHubPluginSource({ fetch: globalThis.fetch, executor: executorIdentity });
        const executor = createManagedPnpmExecutor({
          spec: PNPM_EXECUTOR_SPEC,
          cacheDirectory: join(dataRoot, 'pnpm-cache'),
          fetch: globalThis.fetch,
        });
        const layout = resolveLayout(dataRoot);
        const environments = new EnvironmentStore(layout);
        const requireEnvironment = (id: string) => {
          const record = environments.read(id);
          if (record === undefined) {
            throw new Error(`environment ${id} disappeared from the store`);
          }
          return record;
        };
        const operations = new OperationStore(layout);
        const plans = new ChangePlanStore(layout);
        const resolvingPreview = createResolvingPreviewPort({ gitProvider, executor, executorIdentity });
        const removalPort = createPluginRemovalPort({ executor });
        const previewService = new ChangePreviewService({
          layout,
          port: resolvingPreview,
          removalPort,
          findEnvironment: (id) => {
            const outcome = service.findEnvironment(id);
            return outcome.ok ? outcome.value : undefined;
          },
        });
        const applyService = new ChangeApplyService({
          layout,
          plans,
          environments,
          operations,
          compositionDigest: computeCompositionDigest,
          port: createPluginApplyPort({ gitProvider, executor }),
          removalPort,
          verifyGenerationRuntime: createGenerationRuntimeVerifier(),
        });

        // ---- phase 1: source-locked preview ----
        const source = { owner: CANDIDATE.owner, name: CANDIDATE.name, ref: CANDIDATE.ref };
        const preview = previewService.previewChange({
          requestId: 'req-98-preview',
          environmentId: environment.id,
          expectedRevision: environment.revision,
          action: { kind: 'install', source },
        });
        expect(preview.ok, JSON.stringify(preview)).toBe(true);
        if (!preview.ok) {
          return;
        }
        const previewOperation = await waitPreviewOperation(previewService, preview.value.operationId, 10 * 60_000);
        expect(previewOperation.status, JSON.stringify(previewOperation)).toBe('succeeded');
        const plan = previewOperation.output as {
          readonly planId: string;
          readonly sourceLock: {
            readonly commitSha: string;
            readonly packageName: string;
            readonly packageVersion: string;
            readonly manifestSha256: string;
            readonly closureLockSha256: string | null;
          };
          readonly scripts: readonly unknown[];
          readonly scriptAssessment: string;
          readonly requiresBuildAuthorization: boolean;
          readonly riskItems: readonly string[];
          readonly planInputsDigest: string;
        };

        // Pin lock: the exact commit and manifest digest must match, and the
        // source must be a plugin (never a `NOT_A_PLUGIN` fallback).
        expect(plan.sourceLock.commitSha).toBe(CANDIDATE.ref);
        expect(plan.sourceLock.packageName).toBe(CANDIDATE.packageName);
        expect(plan.sourceLock.packageVersion).toBe(CANDIDATE.packageVersion);
        expect(plan.sourceLock.manifestSha256).toBe(CANDIDATE.manifestSha256);
        // The source repo has no lockfile; the plan's closure digest is the
        // resolved TARGET profile lock (a real 64-hex SHA-256), not a source lock.
        expect(plan.sourceLock.closureLockSha256).toMatch(/^[0-9a-f]{64}$/);
        // install-time script set is empty and no build authorization is asked.
        expect(plan.scripts).toEqual([]);
        expect(plan.scriptAssessment).toBe('none-detected');
        expect(plan.requiresBuildAuthorization).toBe(false);

        // ---- phase 2: apply install (no build authorization) ----
        const applied = applyService.applyChange({
          requestId: 'req-98-apply',
          environmentId: environment.id,
          expectedRevision: environment.revision,
          planId: plan.planId,
          buildAuthorization: null,
        });
        expect(applied.ok, JSON.stringify(applied)).toBe(true);
        if (!applied.ok) {
          return;
        }
        const appliedOperation = await waitApplyOperation(operations, applied.value.operationId, 15 * 60_000);
        expect(appliedOperation.status, JSON.stringify(appliedOperation)).toBe('succeeded');
        environment = requireEnvironment(environment.id);
        const installedGeneration = environment.activeGenerationId;
        expect(installedGeneration).toBeTruthy();
        expect(installedGeneration).not.toBe(baselineGeneration);
        if (installedGeneration == null) {
          return;
        }

        const home = environmentPaths(layout, environment.id).homeDirectory;
        const publishedProfile = join(home, 'profiles', `hdsl-${installedGeneration}`);
        const installedPackage = join(publishedProfile, 'node_modules', CANDIDATE.packageName);

        // The composed profile is declared as a dependency + an enabled bundle.
        const profileDeclaration = JSON.parse(readFileSync(join(publishedProfile, 'package.json'), 'utf8')) as {
          readonly dependencies?: Record<string, string>;
          readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } };
        };
        expect(profileDeclaration.dependencies?.[CANDIDATE.packageName]).toBe(
          `github:${CANDIDATE.owner}/${CANDIDATE.name}#${CANDIDATE.ref}`,
        );
        expect(profileDeclaration.dsh?.profile?.bundles).toContain(CANDIDATE.packageName);
        // No build authorization / allowBuilds may exist anywhere in the applied
        // declaration (the default-deny path must not leave one behind).
        expect(readFileSync(join(publishedProfile, 'package.json'), 'utf8')).not.toContain('allowBuilds');

        // Installed bytes still match the pinned manifest/patch/entry.
        expect(existsSync(join(installedPackage, 'package.json'))).toBe(true);
        expect(existsSync(join(installedPackage, 'cordis.patch.yml'))).toBe(true);
        expect(existsSync(join(installedPackage, 'lib', 'index.js'))).toBe(true);
        expect(sha256File(join(installedPackage, 'package.json'))).toBe(CANDIDATE.manifestSha256);
        expect(sha256File(join(installedPackage, 'cordis.patch.yml'))).toBe(CANDIDATE.patchSha256);
        expect(sha256File(join(installedPackage, 'lib', 'index.js'))).toBe(CANDIDATE.entrySha256);

        // The bundle only mounts the in-box skill-filesystem provider; the path
        // the `!!js` expression targets exists in the installed package.
        const skillsDir = join(installedPackage, 'skills');
        expect(existsSync(skillsDir)).toBe(true);
        expect(statSync(skillsDir).isDirectory()).toBe(true);

        // Recorded lock: exact source + bundle identity for the active generation.
        const installedLock = JSON.parse(
          readFileSync(generationPaths(layout, environment.id, installedGeneration).lockPath, 'utf8'),
        ) as {
          readonly pluginSources?: Record<string, { readonly commitSha?: string; readonly manifestSha256?: string }>;
          readonly plugins?: readonly { readonly id?: string; readonly enabledBundle?: boolean }[];
        };
        expect(installedLock.pluginSources?.[CANDIDATE.packageName]?.commitSha).toBe(CANDIDATE.ref);
        expect(installedLock.pluginSources?.[CANDIDATE.packageName]?.manifestSha256).toBe(CANDIDATE.manifestSha256);
        expect(installedLock.plugins?.some((plugin) => plugin.id === CANDIDATE.packageName)).toBe(true);

        // ---- phase 3: offline `--dump-config` (EXPECTED composition) ----
        const generation = generationPaths(layout, environment.id, installedGeneration);
        const dump = spawnSync(
          join(generation.generationDirectory, 'node', 'bin', 'node'),
          [
            join(generation.generationDirectory, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
            '--profile',
            `hdsl-${installedGeneration}`,
            '--dump-config',
          ],
          {
            cwd: generation.generationDirectory,
            env: {
              HOME: home,
              DSH_HOME: home,
              TMPDIR: join(home, '.tmp'),
              PATH: '/usr/bin:/bin',
              DSH_TELEMETRY_DISABLED: '1',
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        expect(dump.status, String(dump.stderr).slice(0, 2000)).toBe(0);
        const dumpText = String(dump.stdout);
        // The row and the raw load-time expression are composed; dump-config
        // parses `!!js` into an expression node but never evaluates it.
        expect(dumpText).toContain('asu-skill-filesystem');
        expect(dumpText).toContain('@deepseek-ai/dsh-skill-filesystem');
        expect(dumpText).toContain('bundledSkillDir');
        expect(dumpText).toContain('!!js');

        // ---- phase 4: start to ready + stop with a bounded exit ----
        const start = service.startEnvironment({
          requestId: 'req-98-start',
          environmentId: environment.id,
          expectedRevision: environment.revision,
        });
        expect(start.ok, JSON.stringify(start)).toBe(true);
        if (!start.ok) {
          return;
        }
        const started = await managed.waitForOperation(start.value.operationId, { timeoutMs: 3 * 60_000 });
        expect(started.status, JSON.stringify(started)).toBe('succeeded');
        const launchRecord = processManager.readLaunchRecord(environment.id);
        expect(launchRecord?.state).toBe('running');
        const runningPid = launchRecord?.identity?.pid;
        expect(typeof runningPid).toBe('number');

        // Process-level probe: does the running DSH hold anything under the
        // installed plugin directory (a chokidar watcher would)? Recorded, not
        // asserted: HDSL has no public runtime-phase surface (#129 no-go).
        if (typeof runningPid === 'number') {
          const lsof = spawnSync('/usr/sbin/lsof', ['-nP', '-p', String(runningPid)], { encoding: 'utf8' });
          const lsofText = `${lsof.stdout ?? ''}${lsof.stderr ?? ''}`;
          notes.push(`lsof_mentions_asu_skills=${String(lsofText.includes('asu-skills'))}`);
        }

        const stop = service.stopEnvironment({
          requestId: 'req-98-stop',
          environmentId: environment.id,
          expectedRevision: environment.revision,
        });
        expect(stop.ok, JSON.stringify(stop)).toBe(true);
        if (!stop.ok) {
          return;
        }
        const stopped = await managed.waitForOperation(stop.value.operationId, { timeoutMs: 2 * 60_000 });
        expect(stopped.status, JSON.stringify(stopped)).toBe('succeeded');
        expect(processManager.readLaunchRecord(environment.id)?.state).not.toBe('running');

        // ---- phase 5: B1 declarative removal (profile dependency + bundles) ----
        const removePreview = previewService.previewChange({
          requestId: 'req-98-remove-preview',
          environmentId: environment.id,
          expectedRevision: environment.revision,
          action: { kind: 'remove', pluginId: CANDIDATE.packageName },
        });
        expect(removePreview.ok, JSON.stringify(removePreview)).toBe(true);
        if (!removePreview.ok) {
          return;
        }
        const removeOperation = await waitPreviewOperation(
          previewService,
          removePreview.value.operationId,
          10 * 60_000,
        );
        expect(removeOperation.status, JSON.stringify(removeOperation)).toBe('succeeded');
        const removePlan = removeOperation.output as {
          readonly planId: string;
          readonly removals: readonly string[];
          readonly retention: readonly string[];
          readonly riskItems: readonly string[];
          readonly blockingReferences: readonly unknown[];
        };
        // #112 superseded the D21 unknown-service block: an unregistered real
        // plugin is NOT statically blocked. There is also no fabricated
        // known-empty claim here; the unknown service axis is informational only.
        expect(removePlan.blockingReferences).toEqual([]);
        expect(removePlan.removals.length).toBeGreaterThan(0);

        const removeApply = applyService.applyChange({
          requestId: 'req-98-remove-apply',
          environmentId: environment.id,
          expectedRevision: environment.revision,
          planId: removePlan.planId,
          buildAuthorization: null,
        });
        expect(removeApply.ok, JSON.stringify(removeApply)).toBe(true);
        if (!removeApply.ok) {
          return;
        }
        const removedOperation = await waitApplyOperation(operations, removeApply.value.operationId, 15 * 60_000);
        expect(removedOperation.status, JSON.stringify(removedOperation)).toBe('succeeded');
        environment = requireEnvironment(environment.id);
        const removedGeneration = environment.activeGenerationId;
        expect(removedGeneration).toBeTruthy();
        expect(removedGeneration).not.toBe(installedGeneration);
        if (removedGeneration == null) {
          return;
        }

        const removedLock = JSON.parse(
          readFileSync(generationPaths(layout, environment.id, removedGeneration).lockPath, 'utf8'),
        ) as {
          readonly pluginSources?: Record<string, unknown>;
          readonly plugins?: readonly { readonly id?: string }[];
        };
        expect(removedLock.plugins?.some((plugin) => plugin.id === CANDIDATE.packageName)).toBe(false);
        expect(removedLock.pluginSources?.[CANDIDATE.packageName]).toBeUndefined();
        const removedProfile = join(home, 'profiles', `hdsl-${removedGeneration}`);
        const removedDeclaration = JSON.parse(readFileSync(join(removedProfile, 'package.json'), 'utf8')) as {
          readonly dependencies?: Record<string, string>;
          readonly dsh?: { readonly profile?: { readonly bundles?: readonly string[] } };
        };
        expect(removedDeclaration.dependencies?.[CANDIDATE.packageName]).toBeUndefined();
        expect(removedDeclaration.dsh?.profile?.bundles ?? []).not.toContain(CANDIDATE.packageName);

        // ---- phase 6: restart the removed generation and re-check DSH ----
        const startAgain = service.startEnvironment({
          requestId: 'req-98-start-again',
          environmentId: environment.id,
          expectedRevision: environment.revision,
        });
        expect(startAgain.ok, JSON.stringify(startAgain)).toBe(true);
        if (!startAgain.ok) {
          return;
        }
        const startedAgain = await managed.waitForOperation(startAgain.value.operationId, {
          timeoutMs: 3 * 60_000,
        });
        expect(startedAgain.status, JSON.stringify(startedAgain)).toBe('succeeded');

        const removedGenerationPaths = generationPaths(layout, environment.id, removedGeneration);
        const dumpAfter = spawnSync(
          join(removedGenerationPaths.generationDirectory, 'node', 'bin', 'node'),
          [
            join(
              removedGenerationPaths.generationDirectory,
              'dsh',
              'node_modules',
              '@deepseek-ai',
              'dsh',
              'lib',
              'bin.js',
            ),
            '--profile',
            `hdsl-${removedGeneration}`,
            '--dump-config',
          ],
          {
            cwd: removedGenerationPaths.generationDirectory,
            env: {
              HOME: home,
              DSH_HOME: home,
              TMPDIR: join(home, '.tmp'),
              PATH: '/usr/bin:/bin',
              DSH_TELEMETRY_DISABLED: '1',
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        expect(dumpAfter.status, String(dumpAfter.stderr).slice(0, 2000)).toBe(0);
        expect(String(dumpAfter.stdout)).not.toContain(CANDIDATE.packageName);

        const stopAgain = service.stopEnvironment({
          requestId: 'req-98-stop-again',
          environmentId: environment.id,
          expectedRevision: environment.revision,
        });
        expect(stopAgain.ok, JSON.stringify(stopAgain)).toBe(true);
        if (!stopAgain.ok) {
          return;
        }
        const stoppedAgain = await managed.waitForOperation(stopAgain.value.operationId, { timeoutMs: 2 * 60_000 });
        expect(stoppedAgain.status, JSON.stringify(stoppedAgain)).toBe('succeeded');

        // DSH-behavior residual boundary (recorded, never a lossless-uninstall
        // promise): the pruned profile directory may keep the old package bytes.
        notes.push(
          `removed_profile_package_node_modules_present=${String(existsSync(join(removedProfile, 'node_modules', CANDIDATE.packageName)))}`,
        );
        notes.push(`baseline_generation=${baselineGeneration}`);
        notes.push(`installed_generation=${installedGeneration}`);
        notes.push(`removed_generation=${removedGeneration}`);

        // eslint-disable-next-line no-console
        console.log(
          `HDSL_98_THIRD_PARTY_EVIDENCE ${JSON.stringify({
            candidate: `${CANDIDATE.owner}/${CANDIDATE.name}@${CANDIDATE.ref}`,
            queriedAt: CANDIDATE.queriedAt,
            stars: CANDIDATE.stars,
            archiveSha256: CANDIDATE.archiveSha256,
            manifestSha256: CANDIDATE.manifestSha256,
            patchSha256: CANDIDATE.patchSha256,
            entrySha256: CANDIDATE.entrySha256,
            scriptAssessment: plan.scriptAssessment,
            requiresBuildAuthorization: plan.requiresBuildAuthorization,
            planInputsDigest: plan.planInputsDigest,
            sourceClosureLockSha256: plan.sourceLock.closureLockSha256,
            baselineGeneration,
            installedGeneration,
            removedGeneration,
            riskItemsDuringPreview: plan.riskItems,
            removalRiskItems: removePlan.riskItems,
            notes,
          })}`,
        );
        const evidenceFile = process.env['HDSL_98_EVIDENCE_FILE'];
        if (evidenceFile !== undefined && evidenceFile !== '') {
          writeFileSync(
            evidenceFile,
            `${JSON.stringify(
              {
                candidate: `${CANDIDATE.owner}/${CANDIDATE.name}@${CANDIDATE.ref}`,
                queriedAt: CANDIDATE.queriedAt,
                stars: CANDIDATE.stars,
                archiveSha256: CANDIDATE.archiveSha256,
                manifestSha256: CANDIDATE.manifestSha256,
                patchSha256: CANDIDATE.patchSha256,
                entrySha256: CANDIDATE.entrySha256,
                scriptAssessment: plan.scriptAssessment,
                requiresBuildAuthorization: plan.requiresBuildAuthorization,
                planInputsDigest: plan.planInputsDigest,
                sourceClosureLockSha256: plan.sourceLock.closureLockSha256,
                baselineGeneration,
                installedGeneration,
                removedGeneration,
                riskItemsDuringPreview: plan.riskItems,
                removalRiskItems: removePlan.riskItems,
                notes,
              },
              null,
              2,
            )}\n`,
            'utf8',
          );
        }
      } finally {
        await managed?.close().catch(() => undefined);
        if (keep && process.exitCode === 1) {
          // eslint-disable-next-line no-console
          console.error(`kept ${dataRoot}`);
        } else {
          rmSync(dataRoot, { recursive: true, force: true });
        }
      }
    },
    55 * 60_000,
  );
});
