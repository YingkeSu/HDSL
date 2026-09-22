// A2 full real chain probe (own temp root; read-only verified caches):
//   verified DSH rc.2 + Node 22.19.0 artifacts -> real npm-ci dependency closure
//   + preflight + profileInit (stages <gen>/profile) -> core publishes the
//   generation profile and records name/digest -> real managed process boots with
//   `--profile hdsl-<gen>` through the real runtime process manager -> ready ->
//   stop -> cleanup.
//
// Constraints: no model requests, no personal credentials (a fake non-secret
// credential port), no third-party plugins. The source caches must be provided
// explicitly via HDSL_A2_CACHE / HDSL_A2_NPM_CACHE, are copied into an own temp
// root and never modified. Opt-in only (HDSL_A2_REAL=1); never runs in default
// CI and does not require network when the npm cache is complete.
//
// This is a lifecycle/install probe, not a release gate.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

register('../../tests/core/support/a2-window-hook.mjs', import.meta.url);

const { createManagedInstall, environmentPaths, generationPaths, profileDeclarationFingerprint, readProfileProvenance, resolveLayout } =
  await import('@hdsl/core');
const { VERIFIED_COMBINATIONS, createProcessManager, createPosixProcessProbe, createRuntimePort } = await import(
  '@hdsl/runtime'
);

if (process.env.HDSL_A2_REAL !== '1') {
  console.log('SKIP: set HDSL_A2_REAL=1 to run the real install/boot chain');
  process.exit(0);
}

const CACHE = process.env.HDSL_A2_CACHE;
const NPM_CACHE = process.env.HDSL_A2_NPM_CACHE;
if (CACHE === undefined || NPM_CACHE === undefined) {
  console.log('SKIP: set HDSL_A2_CACHE and HDSL_A2_NPM_CACHE to the verified artifact and npm cache directories');
  process.exit(0);
}
const combination = VERIFIED_COMBINATIONS.find((entry) => entry.node.version === '22.19.0');
if (combination === undefined) {
  throw new Error('the verified catalog has no Node 22.19.0 combination');
}

const work = mkdtempSync(join(tmpdir(), 'hdsl-a2-real-'));
const keepOnFailure = process.env.KEEP === '1';
const log = (message) => console.log(message);
let managed;
try {
  const cacheCopy = join(work, 'cache');
  cpSync(CACHE, cacheCopy, { recursive: true });
  const dataRoot = join(work, 'data');

  const runtime = createRuntimePort({ profileInit: true, localArtifactDirectory: cacheCopy });
  const credentials = {
    resolveLaunchEnvironment: async () => ({
      ok: true,
      value: { env: { DSH_QA_CANARY: 'qa-non-secret' }, dispose: () => undefined },
    }),
  };
  const processManager = createProcessManager({
    dataRoot,
    credentials,
    probe: createPosixProcessProbe(),
  });
  managed = await createManagedInstall({ dataRoot, catalog: [combination], runtime, process: processManager });
  // Seed the managed npm cache from the verified cache to bound the registry use.
  cpSync(NPM_CACHE, join(dataRoot, 'npm-cache'), { recursive: true });

  log(`install: real npm-ci closure + profileInit for ${combination.id}`);
  const created = managed.service.createEnvironment({
    requestId: 'req-a2-real',
    name: 'a2-real',
    combination,
  });
  if (!created.ok) {
    throw new Error(`create rejected: ${created.code}`);
  }
  const snapshot = await managed.waitForOperation(created.value.operationId, { timeoutMs: 15 * 60_000 });
  log(`install operation: ${snapshot.status}`);
  if (snapshot.status !== 'succeeded') {
    throw new Error(`install failed: ${snapshot.error?.code ?? 'unknown'}`);
  }

  const listed = managed.service.listEnvironments();
  if (!listed.ok) {
    throw new Error('could not list environments');
  }
  const environment = listed.value[0];
  const generationId = environment?.activeGenerationId ?? null;
  if (environment === undefined || generationId === null) {
    throw new Error('no active generation after install');
  }
  const layout = resolveLayout(dataRoot);
  const paths = generationPaths(layout, environment.id, generationId);
  const profileName = `hdsl-${generationId}`;
  const published = join(environmentPaths(layout, environment.id).profilesDirectory, profileName);
  const record = JSON.parse(readFileSync(paths.generationRecordPath, 'utf8'));
  const manifest = managed.service.readInstallManifest(environment.id);
  const stagedDigest = profileDeclarationFingerprint(join(paths.generationDirectory, 'profile'));
  log(`staged source: ${String(existsSync(join(paths.generationDirectory, 'profile', 'package.json')))}`);
  log(`published profile: ${String(existsSync(published))}`);
  log(`record profileName/digest: ${String(record.profileName)} / ${String((record.profileDigest ?? '').slice(0, 16))}…`);
  log(`manifest.profile: ${JSON.stringify(manifest.profile)}`);
  log(`staged<->manifest digest equal: ${String(stagedDigest === manifest.profile?.digest)}`);
  log(`record<->manifest digest equal: ${String(record.profileDigest === manifest.profile?.digest)}`);
  const provenance = readProfileProvenance(published);
  log(`provenance: ${JSON.stringify(provenance)}`);
  if (
    !existsSync(published) ||
    record.profileName !== profileName ||
    typeof record.profileDigest !== 'string' ||
    manifest.profile?.name !== profileName ||
    stagedDigest === undefined ||
    stagedDigest !== manifest.profile.digest ||
    record.profileDigest !== manifest.profile.digest ||
    provenance?.generationId !== generationId ||
    provenance.profileName !== profileName ||
    provenance.digest !== manifest.profile.digest ||
    typeof provenance.transactionId !== 'string'
  ) {
    throw new Error('profile publication/record/manifest/provenance binding is incomplete or inconsistent');
  }

  log('start: real managed process with --profile (readiness from the process manager)');
  const start = managed.service.startEnvironment({
    requestId: 'req-a2-real-start',
    environmentId: environment.id,
    expectedRevision: environment.revision,
  });
  if (!start.ok) {
    throw new Error(`start rejected: ${start.code}`);
  }
  const started = await managed.waitForOperation(start.value.operationId, { timeoutMs: 120_000 });
  log(`start operation: ${started.status}`);
  if (started.status !== 'succeeded') {
    throw new Error(`start failed: ${started.error?.code ?? 'unknown'}`);
  }
  const running = managed.service.listEnvironments();
  log(`environment state after start: ${running.ok ? running.value[0]?.state : 'unknown'}`);

  log('stop: real managed process stop');
  const current = running.ok ? running.value[0] : undefined;
  const stop = managed.service.stopEnvironment({
    requestId: 'req-a2-real-stop',
    environmentId: environment.id,
    expectedRevision: current?.revision ?? environment.revision,
  });
  if (!stop.ok) {
    throw new Error(`stop rejected: ${stop.code}`);
  }
  const stopped = await managed.waitForOperation(stop.value.operationId, { timeoutMs: 120_000 });
  log(`stop operation: ${stopped.status}`);

  log('RESULT: PASS — real npm-ci install -> profile publish -> managed --profile start -> stop');
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (managed !== undefined) {
    try {
      await managed.close();
    } catch {
      // best effort
    }
  }
  if (keepOnFailure && process.exitCode === 1) {
    console.error(`kept own temp root for redacted evidence: ${work}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}
