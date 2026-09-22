// AC8 (offline): after a PRE-COMMIT apply failure, the OLD generation must still
// be really startable, with the composition digest unchanged and no plugin
// marker. Uses the verified cached artifacts and a real managed process start;
// the apply failure is injected and no network/GitHub is used. This is offline
// failure acceptance and does NOT replace new-network evidence.
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

register('../../tests/core/support/a2-window-hook.mjs', import.meta.url);
const core = await import('@hdsl/core');
const runtime = await import('@hdsl/runtime');
const { createManagedInstall, resolveLayout, ChangePlanStore, EnvironmentStore, OperationStore, ChangeApplyService } = core;
const { VERIFIED_COMBINATIONS, createRuntimePort, createProcessManager, createPosixProcessProbe, createGenerationRuntimeVerifier } = runtime;

if (process.env.HDSL_OFFLINE_APPLY_FAILURE !== '1') { console.log('SKIP: set HDSL_OFFLINE_APPLY_FAILURE=1'); process.exit(0); }
const CACHE = process.env.HDSL_A2_CACHE;
const NPM_CACHE = process.env.HDSL_A2_NPM_CACHE;
if (CACHE === undefined || NPM_CACHE === undefined) { console.log('SKIP: set HDSL_A2_CACHE and HDSL_A2_NPM_CACHE'); process.exit(0); }
const combination = VERIFIED_COMBINATIONS.find((c) => c.node.version === '22.19.0');
const work = mkdtempSync(join(tmpdir(), 'hdsl-offline-apply-failure-'));
let managed;
try {
  const dataRoot = join(work, 'data');
  cpSync(CACHE, join(work, 'cache'), { recursive: true });
  const runtimePort = createRuntimePort({ profileInit: true, localArtifactDirectory: join(work, 'cache') });
  const credentials = { resolveLaunchEnvironment: async () => ({ ok: true, value: { env: { DSH_QA_CANARY: 'qa-non-secret' }, dispose: () => undefined } }) };
  const processPort = createProcessManager({ dataRoot, credentials, probe: createPosixProcessProbe() });
  managed = await createManagedInstall({ dataRoot, catalog: [combination], runtime: runtimePort, process: processPort });
  cpSync(NPM_CACHE, join(dataRoot, 'npm-cache'), { recursive: true });
  const created = managed.service.createEnvironment({ requestId: 'req-offline-1', name: 'offline-failure', combination });
  const installed = await managed.waitForOperation(created.value.operationId, { timeoutMs: 15 * 60_000 });
  if (installed.status !== 'succeeded') throw new Error(`install failed ${installed.error?.code ?? ''}`);
  const environment = managed.service.listEnvironments().value[0];
  const before = managed.service.findEnvironment(environment.id).value;
  console.log(`gen1 active=${before.activeGenerationId} digest=${before.compositionDigest}`);

  const layout = resolveLayout(dataRoot);
  const plans = new ChangePlanStore(layout);
  const clock = '2026-09-22T00:05:00.000Z';
  plans.write({ schemaVersion: '1', plan: {
    planId: 'plan-0000000000000001', environmentId: environment.id, baseRevision: before.revision,
    action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    createdAt: clock, expiresAt: '2026-09-22T00:15:00.000Z', sourceLock: null,
    scriptAssessment: 'none-detected', scripts: [], requiresBuildAuthorization: false,
    riskItems: [], removals: [], retention: [], blockingReferences: [], executor: null, planInputsDigest: 'd'.repeat(64),
  }, consumedBy: null });
  const fakePort = { stage: async (command) => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const profile = join(command.generationDirectory, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['b'] } } }));
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
    return { ok: true, value: { compositionLock: { schemaVersion: '1', node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) }, dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) }, plugins: [], sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } } }, sourceLock: null, stagedProfileDirectory: profile } };
  } };
  const applyService = new ChangeApplyService({ layout, plans, environments: new EnvironmentStore(layout), operations: new OperationStore(layout), compositionDigest: (l) => JSON.stringify(l.plugins), port: fakePort, verifyGenerationRuntime: createGenerationRuntimeVerifier(), faults: { failAt: 'verified' }, now: () => new Date(clock) });
  const applied = applyService.applyChange({ requestId: 'req-offline-apply', environmentId: environment.id, expectedRevision: before.revision, planId: 'plan-0000000000000001', buildAuthorization: null });
  if (!applied.ok) throw new Error(`apply rejected ${applied.code}`);
  for (let i = 0; i < 300; i += 1) { const op = new OperationStore(layout).read(applied.value.operationId); if (op !== undefined && ['succeeded', 'failed', 'cancelled'].includes(op.status)) { console.log(`apply status=${op.status} error=${op.error?.code ?? ''}`); break; } await new Promise((r) => setTimeout(r, 100)); }
  const after = managed.service.findEnvironment(environment.id).value;
  console.log(`pointer unchanged=${String(after.activeGenerationId === before.activeGenerationId)} digest unchanged=${String(after.compositionDigest === before.compositionDigest)} revision unchanged=${String(after.revision === before.revision)}`);

  const start = managed.service.startEnvironment({ requestId: 'req-offline-start', environmentId: environment.id, expectedRevision: after.revision });
  if (!start.ok) throw new Error(`old-generation start rejected ${start.code}`);
  const started = await managed.waitForOperation(start.value.operationId, { timeoutMs: 120_000 });
  const marker = join(layout.environments, environment.id, 'home', 'hdsl-e2e-marker', 'applied');
  console.log(`old-generation start status=${started.status} pluginMarkerPresent=${String(existsSync(marker))}`);
  const pass = started.status === 'succeeded'
    && after.activeGenerationId === before.activeGenerationId
    && after.compositionDigest === before.compositionDigest
    && !existsSync(marker);
  console.log(pass
    ? 'RESULT: PASS — pre-commit apply failure left the old generation startable with an unchanged composition'
    : 'RESULT: FAIL');
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (managed !== undefined) { try { await managed.close(); } catch { /* ignore */ } }
  if (process.env.KEEP === '1' && process.exitCode === 1) console.error(`kept ${work}`); else rmSync(work, { recursive: true, force: true });
}
