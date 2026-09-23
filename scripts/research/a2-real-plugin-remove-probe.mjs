// Real production removal chain probe (opt-in, #77 S3).
//
// Own temp data root; verified artifact/npm caches are copied read-only; no
// model calls, no personal credentials; the only plugin is the reviewed fixture
// at an EXACT commit. It reuses the S2 real install/apply chain, then:
//
//   1. install the fixture via the REAL GitHub + frozen managed pnpm executors,
//   2. start the new generation and observe the fixture's apply marker,
//   3. stop, then remove-preview + apply the removal (REAL removal port),
//   4. move the test's own OLD marker away, start the removed generation and
//      prove no NEW marker appears (the removed bundle is no longer loaded),
//   5. prove the active-generation record + lock + offline `--dump-config`
//      composition tree no longer contain the package, and the user patch
//      bytes / home+data are preserved,
//   6. run the builtin and unknown-service NEGATIVE CONTROLS separately.
//
// It is NOT a desktop acceptance and NOT an E9 equivalence proof.
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  createPluginRemovalPort, computeCompositionDigest,
} = runtime;

if (process.env.HDSL_REAL_PLUGIN !== '1') {
  console.log('SKIP: set HDSL_REAL_PLUGIN=1');
  process.exit(0);
}
const FIXTURE = { owner: 'YingkeSu', name: 'hdsl-plugin-e2e-fixture', ref: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838' };
const FIXTURE_COMMIT = 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838';
const CACHE = process.env.HDSL_A2_CACHE;
const NPM_CACHE = process.env.HDSL_A2_NPM_CACHE;
if (CACHE === undefined || NPM_CACHE === undefined) {
  console.log('SKIP: set HDSL_A2_CACHE and HDSL_A2_NPM_CACHE');
  process.exit(0);
}
const combination = VERIFIED_COMBINATIONS.find((c) => c.node.version === '22.19.0');
const work = mkdtempSync(join(tmpdir(), 'hdsl-real-remove-'));
console.log(`work=${work}`);
const keep = process.env.KEEP === '1';
const log = (m) => console.log(m);
let managed;
const results = [];
const record = (name, pass) => {
  results.push([name, pass]);
  log(`CHECK ${pass ? 'PASS' : 'FAIL'} ${name}`);
};
const waitOperation = async (store, id, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = store.read(id);
    if (op !== undefined && ['succeeded', 'failed', 'cancelled'].includes(op.status)) return op;
    if (Date.now() > deadline) throw new Error(`operation ${id} did not terminate`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const waitPreviewOperation = async (service, id, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = service.findOperation(id);
    if (op?.ok && ['succeeded', 'failed', 'cancelled'].includes(op.value.status)) return op.value;
    if (Date.now() > deadline) throw new Error(`preview operation ${id} did not terminate`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const waitServiceOperation = async (id, timeoutMs) => managed.waitForOperation(id, { timeoutMs });

try {
  const dataRoot = join(work, 'data');
  cpSync(CACHE, join(work, 'cache'), { recursive: true });
  const runtimePort = createRuntimePort({ profileInit: true, localArtifactDirectory: join(work, 'cache') });
  const credentials = { resolveLaunchEnvironment: async () => ({ ok: true, value: { env: { DSH_QA_CANARY: 'qa-non-secret' }, dispose: () => undefined } }) };
  const processPort = createProcessManager({ dataRoot, credentials, probe: createPosixProcessProbe() });
  managed = await createManagedInstall({ dataRoot, catalog: [combination], runtime: runtimePort, process: processPort });
  cpSync(NPM_CACHE, join(dataRoot, 'npm-cache'), { recursive: true });

  log('install gen1 (real npm-ci + profileInit)…');
  const created = managed.service.createEnvironment({ requestId: 'req-remove-1', name: 'real-remove', combination });
  if (!created.ok) throw new Error(`create rejected ${created.code}`);
  const installed = await waitServiceOperation(created.value.operationId, 15 * 60_000);
  if (installed.status !== 'succeeded') throw new Error(`install failed ${installed.error?.code ?? ''}`);
  let environment = managed.service.listEnvironments().value[0];
  log(`gen1 active=${environment.activeGenerationId} revision=${environment.revision}`);

  const executorIdentity = { id: 'pnpm', version: PNPM_EXECUTOR_SPEC.version, sha256: PNPM_EXECUTOR_SPEC.sha256, entrySha256: PNPM_EXECUTOR_SPEC.entrySha256, treeSha256: PNPM_EXECUTOR_SPEC.treeSha256 };
  const gitProvider = createGitHubPluginSource({ fetch: globalThis.fetch, executor: executorIdentity });
  const executor = createManagedPnpmExecutor({ spec: PNPM_EXECUTOR_SPEC, cacheDirectory: join(dataRoot, 'pnpm-cache'), fetch: globalThis.fetch });
  const removalPort = createPluginRemovalPort({ executor });
  const layout = resolveLayout(dataRoot);
  const environments = new EnvironmentStore(layout);
  const operations = new OperationStore(layout);
  const plans = new ChangePlanStore(layout);
  const resolvingPreview = createResolvingPreviewPort({ gitProvider, executor, executorIdentity });
  const previewService = new ChangePreviewService({
    layout, port: resolvingPreview, removalPort,
    findEnvironment: (id) => { const o = managed.service.findEnvironment(id); return o.ok ? o.value : undefined; },
  });
  const applyService = new ChangeApplyService({
    layout, plans, environments, operations,
    compositionDigest: computeCompositionDigest,
    port: createPluginApplyPort({ gitProvider, executor }),
    removalPort,
    verifyGenerationRuntime: createGenerationRuntimeVerifier(),
  });

  // ---- real install of the fixture ----
  log(`install preview ${FIXTURE.owner}/${FIXTURE.name}@${FIXTURE_COMMIT.slice(0, 8)}…`);
  const preview = previewService.previewChange({ requestId: 'req-remove-preview', environmentId: environment.id, expectedRevision: environment.revision, action: { kind: 'install', source: FIXTURE } });
  if (!preview.ok) throw new Error(`install preview rejected ${preview.code}`);
  const previewOp = await waitPreviewOperation(previewService, preview.value.operationId, 5 * 60_000);
  if (previewOp.status !== 'succeeded') throw new Error(`install preview ${previewOp.status} ${previewOp.error?.code ?? ''}`);
  const installPlan = previewOp.output;
  const apply = applyService.applyChange({ requestId: 'req-remove-apply', environmentId: environment.id, expectedRevision: environment.revision, planId: installPlan.planId, buildAuthorization: null });
  if (!apply.ok) throw new Error(`install apply rejected ${apply.code}`);
  const applied = await waitOperation(operations, apply.value.operationId, 10 * 60_000);
  if (applied.status !== 'succeeded') throw new Error(`install apply ${applied.status} ${applied.error?.code ?? ''}`);
  environment = environments.read(environment.id);
  const installedGeneration = environment.activeGenerationId;
  log(`fixture installed; generation=${installedGeneration} revision=${environment.revision}`);
  const installedLock = JSON.parse(readFileSync(generationPaths(layout, environment.id, installedGeneration).lockPath, 'utf8'));
  record('install recorded pluginSources for the exact fixture commit', installedLock.pluginSources?.['hdsl-plugin-e2e-fixture']?.commitSha === FIXTURE_COMMIT);

  // ---- start installed generation: marker MUST appear ----
  const start1 = managed.service.startEnvironment({ requestId: 'req-remove-start1', environmentId: environment.id, expectedRevision: environment.revision });
  if (!start1.ok) throw new Error(`start1 rejected ${start1.code}`);
  const started1 = await waitServiceOperation(start1.value.operationId, 180_000);
  record('installed generation starts', started1.status === 'succeeded');
  const home = environmentPaths(layout, environment.id).homeDirectory;
  const marker = join(home, 'hdsl-e2e-marker', 'applied');
  for (let i = 0; i < 60 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 250));
  record('before removal: fixture apply marker appears', existsSync(marker));
  const stop1 = managed.service.stopEnvironment({ requestId: 'req-remove-stop1', environmentId: environment.id, expectedRevision: environment.revision });
  if (!stop1.ok) throw new Error(`stop1 rejected ${stop1.code}`);
  const stopped1 = await waitServiceOperation(stop1.value.operationId, 120_000);
  record('stop before removal succeeds', stopped1.status === 'succeeded');

  // ---- user patch + home/data to prove preservation ----
  const userPatchPath = join(home, 'cordis.patch.yml');
  const userPatchBytes = `# user patch (probe)\n- id: probe-user-row\n  config:\n    note: do-not-touch\n`;
  writeFileSync(userPatchPath, userPatchBytes);
  const homeDataPath = join(home, 'probe-user-data.txt');
  writeFileSync(homeDataPath, 'user data bytes\n');

  // ---- removal preview ----
  log('remove preview…');
  const removePreview = previewService.previewChange({ requestId: 'req-remove-preview2', environmentId: environment.id, expectedRevision: environment.revision, action: { kind: 'remove', pluginId: 'hdsl-plugin-e2e-fixture' } });
  if (!removePreview.ok) throw new Error(`remove preview rejected ${removePreview.code}`);
  const removeOp = await waitPreviewOperation(previewService, removePreview.value.operationId, 5 * 60_000);
  if (removeOp.status !== 'succeeded') throw new Error(`remove preview ${removeOp.status} ${removeOp.error?.code ?? ''}`);
  const removePlan = removeOp.output;
  log(`remove plan: removals=${JSON.stringify(removePlan.removals)}`);
  log(`remove plan: retention=${JSON.stringify(removePlan.retention.slice(0, 6))}`);
  record('remove preview is unblocked for the reviewed fixture (known empty providers)', removePlan.blockingReferences.length === 0);
  record('remove preview lists the dependency entry + enabled reference', removePlan.removals.some((e) => e.includes('dependency entry')) && removePlan.removals.some((e) => e.includes('enabled bundle reference')));
  record('remove preview retains the user patch layer + environment data', removePlan.retention.some((e) => e.includes('user patch layer')) && removePlan.retention.some((e) => e.includes('environment data')));

  // ---- negative control: unknown service axis is informational, NOT a blocker ----
  const lockPathInstalled = generationPaths(layout, environment.id, installedGeneration).lockPath;
  const originalLockBytes = readFileSync(lockPathInstalled, 'utf8');
  const tampered = JSON.parse(originalLockBytes);
  tampered.pluginSources['hdsl-plugin-e2e-fixture'].commitSha = '0'.repeat(40);
  writeFileSync(lockPathInstalled, `${JSON.stringify(tampered)}\n`);
  const unknownPreview = previewService.previewChange({ requestId: 'req-remove-unknown', environmentId: environment.id, expectedRevision: environment.revision, action: { kind: 'remove', pluginId: 'hdsl-plugin-e2e-fixture' } });
  const unknownOp = unknownPreview.ok ? await waitPreviewOperation(previewService, unknownPreview.value.operationId, 5 * 60_000) : undefined;
  const unknownBlocks = (unknownOp?.output?.blockingReferences ?? []).some((r) => r.detail.includes('service dependencies for this plugin are not verified'));
  const unknownIsRiskInfo = (unknownOp?.output?.riskItems ?? []).some((r) => r.includes('not verified'));
  record('negative control: unverified service binding does NOT block (unknown != danger, #112)', unknownOp?.status === 'succeeded' && unknownBlocks === false);
  record('negative control: unverified service binding is reported as risk information', unknownIsRiskInfo === true);
  writeFileSync(lockPathInstalled, originalLockBytes);

  // ---- negative control: real in-box bundle name ----
  // The installed generation's immutable declaration preserves the profileInit
  // bundles (the shipped `web` template), so the REAL in-box set is present.
  const installedDeclaration = JSON.parse(
    readFileSync(join(generationPaths(layout, environment.id, installedGeneration).generationDirectory, 'profile', 'package.json'), 'utf8'),
  );
  const declaredBundles = installedDeclaration?.dsh?.profile?.bundles ?? [];
  const builtinName = declaredBundles.find((id) => typeof id === 'string' && id.startsWith('@deepseek-ai/dsh-'));
  log(`negative control bundles=${JSON.stringify(declaredBundles)} chosen=${String(builtinName)}`);
  if (builtinName === undefined) {
    record('negative control: REAL in-box bundle name is BUILTIN_BUNDLE_PROTECTED', false);
  } else {
    const builtinPreview = previewService.previewChange({ requestId: 'req-remove-builtin', environmentId: environment.id, expectedRevision: environment.revision, action: { kind: 'remove', pluginId: builtinName } });
    const builtinOp = builtinPreview.ok ? await waitPreviewOperation(previewService, builtinPreview.value.operationId, 2 * 60_000) : undefined;
    log(`builtin negative control target=${builtinName} status=${builtinOp?.status} error=${builtinOp?.error?.code}`);
    record('negative control: REAL in-box bundle name is BUILTIN_BUNDLE_PROTECTED', builtinOp?.status === 'failed' && builtinOp.error?.code === 'BUILTIN_BUNDLE_PROTECTED');
  }

  // ---- apply removal ----
  log('apply removal…');
  const removeApply = applyService.applyChange({ requestId: 'req-remove-apply2', environmentId: environment.id, expectedRevision: environment.revision, planId: removePlan.planId, buildAuthorization: null });
  if (!removeApply.ok) throw new Error(`remove apply rejected ${removeApply.code}`);
  const removed = await waitOperation(operations, removeApply.value.operationId, 10 * 60_000);
  if (removed.status !== 'succeeded') throw new Error(`remove apply ${removed.status} ${removed.error?.code ?? ''}`);
  environment = environments.read(environment.id);
  const removedGeneration = environment.activeGenerationId;
  log(`removal committed; generation=${removedGeneration} revision=${environment.revision}`);
  record('removal committed a NEW active generation', removedGeneration !== installedGeneration);
  const removedLock = JSON.parse(readFileSync(generationPaths(layout, environment.id, removedGeneration).lockPath, 'utf8'));
  record('active generation lock no longer enables the package', !removedLock.plugins.some((p) => p.id === 'hdsl-plugin-e2e-fixture'));
  record('active generation lock drops the package source binding', removedLock.pluginSources?.['hdsl-plugin-e2e-fixture'] === undefined);
  record('user patch bytes are unchanged (never written back)', readFileSync(userPatchPath, 'utf8') === userPatchBytes);
  record('environment home data preserved', readFileSync(homeDataPath, 'utf8') === 'user data bytes\n');

  // ---- move OUR old marker away, then start the removed generation ----
  if (existsSync(marker)) renameSync(marker, `${marker}.before-removal`);
  const start2 = managed.service.startEnvironment({ requestId: 'req-remove-start2', environmentId: environment.id, expectedRevision: environment.revision });
  if (!start2.ok) throw new Error(`start2 rejected ${start2.code}`);
  const started2 = await waitServiceOperation(start2.value.operationId, 180_000);
  record('removed generation starts and becomes running', started2.status === 'succeeded');
  // Bounded observation window for a NEW marker.
  for (let i = 0; i < 40 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 250));
  record('after removal: removed generation writes NO new fixture marker', !existsSync(marker));
  const stop2 = managed.service.stopEnvironment({ requestId: 'req-remove-stop2', environmentId: environment.id, expectedRevision: environment.revision });
  if (!stop2.ok) throw new Error(`stop2 rejected ${stop2.code}`);
  await waitServiceOperation(stop2.value.operationId, 120_000);

  // ---- offline composition tree (active generation + dump-config) ----
  const genPaths = generationPaths(layout, environment.id, removedGeneration);
  const dump = (await import('node:child_process')).spawnSync(
    join(genPaths.generationDirectory, 'node', 'bin', 'node'),
    [join(genPaths.generationDirectory, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--profile', `hdsl-${removedGeneration}`, '--dump-config'],
    { cwd: genPaths.generationDirectory, env: { HOME: home, DSH_HOME: home, TMPDIR: join(home, '.tmp'), PATH: '/usr/bin:/bin' }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const dumpMentions = typeof dump.stdout === 'string' && dump.stdout.includes('hdsl-plugin-e2e-fixture');
  log(`offline dump-config exit=${String(dump.status)} mentionsFixture=${String(dumpMentions)}`);
  record('offline composition tree no longer contains the package', dump.status === 0 && dumpMentions === false);

  const failed = results.filter(([, pass]) => !pass);
  log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length} checks`);
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (managed !== undefined) { try { await managed.close(); } catch { /* ignore */ } }
  if (keep && process.exitCode === 1) console.error(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
