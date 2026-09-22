// Issue #76 / AC-restore (offline): an EXPLICIT `generations.restore` to a
// RETAINED older generation must switch the active pointer and then really start
// that old generation with its own re-published composition. This is distinct
// from AC8 (old generation after a FAILED apply): here the new generation is
// committed first, then restored away from. Offline: cached artifacts + a
// test-only stage port; no network/GitHub. Does NOT replace new-network evidence.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

register('../../tests/core/support/a2-window-hook.mjs', import.meta.url);
const core = await import('@hdsl/core');
const runtime = await import('@hdsl/runtime');
const { createManagedInstall, resolveLayout, ChangePlanStore, EnvironmentStore, OperationStore, ChangeApplyService, generationPaths, environmentPaths, profileDeclarationFingerprint } = core;
const { VERIFIED_COMBINATIONS, createRuntimePort, createProcessManager, createPosixProcessProbe, createGenerationRuntimeVerifier } = runtime;

if (process.env.HDSL_RESTORE_OLDGEN !== '1') { console.log('SKIP: set HDSL_RESTORE_OLDGEN=1'); process.exit(0); }
const CACHE = process.env.HDSL_A2_CACHE;
const NPM_CACHE = process.env.HDSL_A2_NPM_CACHE;
if (CACHE === undefined || NPM_CACHE === undefined) { console.log('SKIP: set HDSL_A2_CACHE and HDSL_A2_NPM_CACHE'); process.exit(0); }
const combination = VERIFIED_COMBINATIONS.find((c) => c.node.version === '22.19.0');
const work = mkdtempSync(join(tmpdir(), 'hdsl-restore-oldgen-'));
const waitTerminal = async (layout, operationId, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const op = new OperationStore(layout).read(operationId);
    if (op !== undefined && ['succeeded', 'failed', 'cancelled'].includes(op.status)) return op;
    if (Date.now() > deadline) throw new Error(`operation ${operationId} did not terminate`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
let managed;
try {
  const dataRoot = join(work, 'data');
  cpSync(CACHE, join(work, 'cache'), { recursive: true });
  const runtimePort = createRuntimePort({ profileInit: true, localArtifactDirectory: join(work, 'cache') });
  const credentials = { resolveLaunchEnvironment: async () => ({ ok: true, value: { env: { DSH_QA_CANARY: 'qa-non-secret' }, dispose: () => undefined } }) };
  const processPort = createProcessManager({ dataRoot, credentials, probe: createPosixProcessProbe() });
  managed = await createManagedInstall({ dataRoot, catalog: [combination], runtime: runtimePort, process: processPort });
  cpSync(NPM_CACHE, join(dataRoot, 'npm-cache'), { recursive: true });
  const created = managed.service.createEnvironment({ requestId: 'req-restore-1', name: 'restore-oldgen', combination });
  const installed = await managed.waitForOperation(created.value.operationId, { timeoutMs: 15 * 60_000 });
  if (installed.status !== 'succeeded') throw new Error(`install failed ${installed.error?.code ?? ''}`);
  const environmentId = managed.service.listEnvironments().value[0].id;
  const layout = resolveLayout(dataRoot);
  const gen1 = managed.service.findEnvironment(environmentId).value;
  const gen1Paths = generationPaths(layout, environmentId, gen1.activeGenerationId);
  // A shared-home sentinel: restore must preserve shared home/data.
  const sentinel = join(gen1Paths.homeDirectory, 'shared-sentinel.txt');
  writeFileSync(sentinel, 'shared-home-preserved');
  const gen1ProfileFingerprint = JSON.parse(readFileSync(gen1Paths.generationRecordPath, 'utf8')).profileDigest;
  console.log(`gen1=${gen1.activeGenerationId} revision=${gen1.revision} digest=${gen1.compositionDigest}`);

  // Commit a NEW generation (gen2) offline.
  const plans = new ChangePlanStore(layout);
  const clock = '2026-09-22T00:05:00.000Z';
  plans.write({ schemaVersion: '1', plan: {
    planId: 'plan-0000000000000001', environmentId, baseRevision: gen1.revision,
    action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    createdAt: clock, expiresAt: '2026-09-22T00:15:00.000Z', sourceLock: null,
    scriptAssessment: 'none-detected', scripts: [], requiresBuildAuthorization: false,
    riskItems: [], removals: [], retention: [], blockingReferences: [], executor: null, planInputsDigest: 'd'.repeat(64),
  }, consumedBy: null });
  const stagePort = { stage: async (command) => {
    const { mkdirSync } = await import('node:fs');
    const profile = join(command.generationDirectory, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'gen2-detached', dsh: { profile: { bundles: ['gen2-only'] } } }));
    writeFileSync(join(profile, 'cordis.patch.yml'), '# gen2 patch\n');
    return { ok: true, value: { compositionLock: { schemaVersion: '1', node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) }, dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) }, plugins: [{ id: 'gen2-plugin', version: '9.9.9' }], sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } } }, sourceLock: null, stagedProfileDirectory: profile } };
  } };
  const applyService = new ChangeApplyService({ layout, plans, environments: new EnvironmentStore(layout), operations: new OperationStore(layout), compositionDigest: (l) => JSON.stringify(l.plugins), port: stagePort, verifyGenerationRuntime: createGenerationRuntimeVerifier(), now: () => new Date(clock) });
  const applied = applyService.applyChange({ requestId: 'req-restore-apply', environmentId, expectedRevision: gen1.revision, planId: 'plan-0000000000000001', buildAuthorization: null });
  if (!applied.ok) throw new Error(`apply rejected ${applied.code}`);
  const applyOp = await waitTerminal(layout, applied.value.operationId, 120_000);
  if (applyOp.status !== 'succeeded') throw new Error(`apply did not commit: ${applyOp.error?.code ?? ''}`);
  const afterApply = managed.service.findEnvironment(environmentId).value;
  const gen2 = afterApply.activeGenerationId;
  console.log(`committed gen2=${gen2} revision=${afterApply.revision} digestChanged=${String(afterApply.compositionDigest !== gen1.compositionDigest)}`);

  // EXPLICIT restore to the retained gen1.
  const restored = applyService.restoreGeneration({ requestId: 'req-restore-explicit', environmentId, expectedRevision: afterApply.revision, targetGenerationId: gen1.activeGenerationId });
  if (!restored.ok) throw new Error(`restore rejected ${restored.code}`);
  const restoreOp = await waitTerminal(layout, restored.value.operationId, 120_000);
  if (restoreOp.status !== 'succeeded') throw new Error(`restore did not commit: ${restoreOp.error?.code ?? ''}`);
  const afterRestore = managed.service.findEnvironment(environmentId).value;
  const activePath = join(environmentPaths(layout, environmentId).profilesDirectory, `hdsl-${gen1.activeGenerationId}`);
  const republished = existsSync(activePath) ? profileDeclarationFingerprint(activePath) : undefined;
  const oldCompositionRepublished = republished === gen1ProfileFingerprint && typeof gen1ProfileFingerprint === 'string';
  console.log(`after restore pointer=${afterRestore.activeGenerationId} revision=${afterRestore.revision} digestRestored=${String(afterRestore.compositionDigest === gen1.compositionDigest)} oldCompositionRepublished=${String(oldCompositionRepublished)}`);

  // Really start the restored old generation.
  const start = managed.service.startEnvironment({ requestId: 'req-restore-start', environmentId, expectedRevision: afterRestore.revision });
  if (!start.ok) throw new Error(`restored-generation start rejected ${start.code}`);
  const started = await waitTerminal(layout, start.value.operationId, 120_000);
  const marker = join(gen1Paths.homeDirectory, 'hdsl-e2e-marker', 'applied');
  const gen2Retained = existsSync(generationPaths(layout, environmentId, gen2).generationDirectory);
  const sharedPreserved = existsSync(sentinel) && readFileSync(sentinel, 'utf8') === 'shared-home-preserved';
  console.log(`restored-generation start status=${started.status} gen2Retained=${String(gen2Retained)} sharedHomePreserved=${String(sharedPreserved)} pluginMarkerPresent=${String(existsSync(marker))}`);
  const pass = started.status === 'succeeded'
    && afterRestore.activeGenerationId === gen1.activeGenerationId
    && afterRestore.compositionDigest === gen1.compositionDigest
    && oldCompositionRepublished
    && gen2Retained
    && sharedPreserved
    && !existsSync(marker);
  console.log(pass
    ? 'RESULT: PASS — explicit restore switched to the retained old generation, re-published its composition and really started it; new generation retained, shared home preserved'
    : 'RESULT: FAIL');
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (managed !== undefined) { try { await managed.close(); } catch { /* ignore */ } }
  if (process.env.KEEP === '1' && process.exitCode === 1) console.error(`kept ${work}`); else rmSync(work, { recursive: true, force: true });
}
