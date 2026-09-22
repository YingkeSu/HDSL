// Real production chain probe (opt-in): production GitHub GitProvider + frozen
// managed pnpm executor (real download/execute) + core preview/apply +
// same-env start with the controlled fixture's apply marker.
//
// Own temp data root; verified artifact/npm caches are copied read-only. No
// model, no personal credentials; the only plugin is our reviewed fixture.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

register('../../tests/core/support/a2-window-hook.mjs', import.meta.url);
const core = await import('@hdsl/core');
const runtime = await import('@hdsl/runtime');
const {
  createManagedInstall, resolveLayout, generationPaths, environmentPaths,
  ChangePlanStore, EnvironmentStore, OperationStore, ChangePreviewService, ChangeApplyService,
} = core;
const {
  VERIFIED_COMBINATIONS, createRuntimePort, createProcessManager, createPosixProcessProbe,
  createGitHubPluginSource, createManagedPnpmExecutor, PNPM_EXECUTOR_SPEC,
  createGenerationRuntimeVerifier, createPluginApplyPort, createResolvingPreviewPort,
} = runtime;

if (process.env.HDSL_REAL_PLUGIN !== '1') {
  console.log('SKIP: set HDSL_REAL_PLUGIN=1');
  process.exit(0);
}
const FIXTURE = { owner: 'YingkeSu', name: 'hdsl-plugin-e2e-fixture', ref: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838' };
const CACHE = process.env.HDSL_A2_CACHE;
const NPM_CACHE = process.env.HDSL_A2_NPM_CACHE;
if (CACHE === undefined || NPM_CACHE === undefined) {
  console.log('SKIP: set HDSL_A2_CACHE and HDSL_A2_NPM_CACHE');
  process.exit(0);
}
const combination = VERIFIED_COMBINATIONS.find((c) => c.node.version === '22.19.0');
const work = mkdtempSync(join(tmpdir(), 'hdsl-real-plugin-'));
console.log(`work=${work}`);
const keep = process.env.KEEP === '1';
const log = (m) => console.log(m);
let managed;
try {
  const dataRoot = join(work, 'data');
  cpSync(CACHE, join(work, 'cache'), { recursive: true });
  const runtimePort = createRuntimePort({ profileInit: true, localArtifactDirectory: join(work, 'cache') });
  const credentials = { resolveLaunchEnvironment: async () => ({ ok: true, value: { env: { DSH_QA_CANARY: 'qa-non-secret' }, dispose: () => undefined } }) };
  const processPort = createProcessManager({ dataRoot, credentials, probe: createPosixProcessProbe() });
  managed = await createManagedInstall({ dataRoot, catalog: [combination], runtime: runtimePort, process: processPort });
  cpSync(NPM_CACHE, join(dataRoot, 'npm-cache'), { recursive: true });

  log('install gen1 (real npm-ci + profileInit)…');
  const created = managed.service.createEnvironment({ requestId: 'req-real-1', name: 'real-plugin', combination });
  if (!created.ok) throw new Error(`create rejected ${created.code}`);
  const installed = await managed.waitForOperation(created.value.operationId, { timeoutMs: 15 * 60_000 });
  if (installed.status !== 'succeeded') throw new Error(`install failed ${installed.error?.code ?? ''}`);
  const environment = managed.service.listEnvironments().value[0];
  log(`gen1 active=${environment.activeGenerationId} revision=${environment.revision}`);

  // REAL production adapters.
  const executorIdentity = { id: 'pnpm', version: PNPM_EXECUTOR_SPEC.version, sha256: PNPM_EXECUTOR_SPEC.sha256, entrySha256: PNPM_EXECUTOR_SPEC.entrySha256, treeSha256: PNPM_EXECUTOR_SPEC.treeSha256 };
  const gitProvider = createGitHubPluginSource({ fetch: globalThis.fetch, executor: executorIdentity });
  const executor = createManagedPnpmExecutor({ spec: PNPM_EXECUTOR_SPEC, cacheDirectory: join(dataRoot, 'pnpm-cache'), fetch: globalThis.fetch });
  const applyPort = createPluginApplyPort({ gitProvider, executor });
  const layout = resolveLayout(dataRoot);
  const environments = new EnvironmentStore(layout);
  const operations = new OperationStore(layout);
  const plans = new ChangePlanStore(layout);
  const resolvingPreview = createResolvingPreviewPort({ gitProvider, executor, executorIdentity });
  const previewService = new ChangePreviewService({
    layout, port: resolvingPreview,
    findEnvironment: (id) => { const o = managed.service.findEnvironment(id); return o.ok ? o.value : undefined; },
  });
  const applyService = new ChangeApplyService({
    layout, plans, environments, operations,
    compositionDigest: (lock) => JSON.stringify(lock.plugins),
    port: applyPort,
    verifyGenerationRuntime: createGenerationRuntimeVerifier(),
  });

  log(`preview ${FIXTURE.owner}/${FIXTURE.name}@${FIXTURE.ref.slice(0, 8)}…`);
  const preview = previewService.previewChange({ requestId: 'req-real-preview', environmentId: environment.id, expectedRevision: environment.revision, action: { kind: 'install', source: FIXTURE } });
  if (!preview.ok) throw new Error(`preview rejected ${preview.code}`);
  let plan;
  for (let i = 0; i < 600; i += 1) {
    const op = previewService.findOperation(preview.value.operationId);
    if (op?.ok && ['succeeded', 'failed', 'cancelled'].includes(op.value.status)) { plan = op.value.output; if (op.value.status !== 'succeeded') throw new Error(`preview ${op.value.status} ${op.value.error?.code ?? ''}`); break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (plan === undefined) throw new Error('preview did not terminate');
  log(`plan commit=${plan.sourceLock.commitSha} closure=${String(plan.sourceLock.closureLockSha256).slice(0, 12)}… assessment=${plan.scriptAssessment}`);

  log('apply…');
  const apply = applyService.applyChange({ requestId: 'req-real-apply', environmentId: environment.id, expectedRevision: environment.revision, planId: plan.planId, buildAuthorization: null });
  if (!apply.ok) throw new Error(`apply rejected ${apply.code}`);
  let applied;
  for (let i = 0; i < 3000; i += 1) {
    const op = operations.read(apply.value.operationId);
    if (op !== undefined && ['succeeded', 'failed', 'cancelled'].includes(op.status)) { applied = op; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (applied === undefined) throw new Error('apply did not terminate');
  log(`apply status=${applied.status}${applied.error === undefined ? '' : ` error=${applied.error.code} msg=${applied.error.message}`}`);
  if (applied.status !== 'succeeded') { log('RESULT: FAIL at apply'); }
  else {
    const newGen = environments.read(environment.id).activeGenerationId;
    const env = environments.read(environment.id);
    log(`apply committed; new generation ${newGen} revision=${env.revision}`);
    // Start the new generation and observe the fixture's apply marker.
    const start = managed.service.startEnvironment({ requestId: 'req-real-start', environmentId: environment.id, expectedRevision: env.revision });
    if (!start.ok) throw new Error(`start rejected ${start.code}`);
    const started = await managed.waitForOperation(start.value.operationId, { timeoutMs: 120_000 });
    log(`start status=${started.status}`);
    const marker = join(environmentPaths(layout, environment.id).homeDirectory, 'hdsl-e2e-marker', 'applied');
    for (let i = 0; i < 50 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 200));
    log(`apply marker exists=${String(existsSync(marker))}`);
    if (!existsSync(marker)) { log('RESULT: FAIL at marker'); }
    else { log('RESULT: PASS — real apply committed and the controlled fixture marker appeared on start'); }
  }
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (managed !== undefined) { try { await managed.close(); } catch { /* ignore */ } }
  if (keep && process.exitCode === 1) console.error(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
