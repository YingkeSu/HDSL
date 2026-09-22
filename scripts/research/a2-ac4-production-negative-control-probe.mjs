// AC4 route (a), opt-in: wire the controlled malicious-lifecycle fixture through
// the ACTUAL production boundary and observe EXTERNAL marker files (never the
// executor's self-reported `executedInstallScripts`).
//
// Production boundary used here:
//   - `createManagedPnpmExecutor` (frozen pnpm 11.7.0, identity re-verified);
//   - `createPluginApplyPort` (production apply adapter: S4 refusal, exact-commit
//     binding, target-profile `--frozen-lockfile --ignore-scripts` install).
//
// Columns (refusal paths are separated from executed negative controls):
//   A. root refusal        : a plugin manifest declaring root lifecycle scripts
//                            is refused at the apply boundary (S4 closed); the
//                            executor never runs -> 0 markers, no install.
//   B. executor closure    : a plugin with NO scripts whose TRANSITIVE dependency
//                            declares lifecycle scripts; the production executor
//                            installs it with default deny -> install succeeds,
//                            the closure IS present, and 0 markers appear.
//   C. apply closure       : the production apply port installs a frozen target
//                            profile (declaration + lock) whose dependency declares
//                            lifecycle scripts -> `--frozen-lockfile
//                            --ignore-scripts` -> install succeeds, dep present,
//                            0 markers.
//   E. apply closure refuse: a plugin whose dependency closure is NOT enumerated
//                            is refused at the apply boundary (no install, 0
//                            markers) — the S4-closed path.
//   D. isolated positive   : test-only `--ignore-scripts=false` + a precise
//                            allowBuilds entry proves the sentinel is live. NOT an
//                            S4 authorization and never used by production.
//
// Offline-capable: fixtures are `git+file://`; the frozen pnpm artifact is read
// from the local freeze output (no registry/GitHub fetch). This does NOT claim
// generic run-time monitoring of arbitrary code.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

register('../../tests/core/support/a2-window-hook.mjs', import.meta.url);
const runtime = await import('@hdsl/runtime');
const { PNPM_EXECUTOR_SPEC, createManagedPnpmExecutor, createPluginApplyPort, buildPreviewResolution, DEFAULT_INSTALL_ARGS } = runtime;

if (process.env.HDSL_AC4_NEGATIVE !== '1') { console.log('SKIP: set HDSL_AC4_NEGATIVE=1'); process.exit(0); }
const NODE = process.env.HDSL_AC4_NODE;
const EXTRACT = process.env.HDSL_AC4_PNPM_EXTRACT;
const TGZ = process.env.HDSL_AC4_PNPM_TGZ;
if (NODE === undefined || EXTRACT === undefined || TGZ === undefined || !existsSync(NODE)) {
  console.log('SKIP: set HDSL_AC4_NODE (managed node), HDSL_AC4_PNPM_EXTRACT, HDSL_AC4_PNPM_TGZ'); process.exit(0);
}
const WORK = mkdtempSync(join(tmpdir(), 'hdsl-ac4-negative-'));
const MARKERS = join(WORK, 'markers');
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const markerNames = () => (existsSync(MARKERS) ? readdirSync(MARKERS) : []);
const clearMarkers = () => { for (const name of markerNames()) rmSync(join(MARKERS, name)); };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const script = (name) => `node -e "require('fs').writeFileSync('${MARKERS}/${name}','x')"`;
const lifecycle = { preinstall: script('dep-preinstall'), install: script('dep-install'), postinstall: script('dep-postinstall'), prepare: script('dep-prepare') };
const CURRENT_LOCK = { schemaVersion: '1', node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) }, dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) }, plugins: [], sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } } };
const makeRepo = (directory, manifest, extraFiles = {}) => {
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, 'package.json'), manifest);
  for (const [name, content] of Object.entries(extraFiles)) writeFileSync(join(directory, name), content);
  git(directory, 'init', '-q'); git(directory, 'add', '-A'); git(directory, 'commit', '-qm', 'fixture');
  return git(directory, 'rev-parse', 'HEAD');
};
/** pnpm hoists into the virtual store; assert the package is really installed. */
const packageInstalled = (nodeModulesRoot, name) => {
  if (existsSync(join(nodeModulesRoot, name))) return true;
  const store = join(nodeModulesRoot, '.pnpm');
  if (!existsSync(store)) return false;
  return readdirSync(store).some((entry) => entry === name || entry.startsWith(`${name}@`));
};

let managed;
try {
  mkdirSync(MARKERS, { recursive: true });
  // Frozen executor cache: seed the exact pinned artifact, offline.
  const cacheDirectory = join(WORK, 'cache');
  const artifactDir = join(cacheDirectory, 'pnpm', PNPM_EXECUTOR_SPEC.version, PNPM_EXECUTOR_SPEC.sha256);
  mkdirSync(artifactDir, { recursive: true });
  cpSync(TGZ, join(artifactDir, 'pnpm.tgz'));
  cpSync(EXTRACT, join(artifactDir, 'package'), { recursive: true });
  const executor = createManagedPnpmExecutor({
    spec: PNPM_EXECUTOR_SPEC,
    cacheDirectory,
    fetch: async () => { throw new Error('offline: the frozen artifact is provided locally'); },
  });
  const identity = await executor.identity(new AbortController().signal);
  if (!identity.ok) throw new Error(`executor identity failed: ${identity.message}`);

  const depRepo = join(WORK, 'fixture-gitdep');
  const depSha = makeRepo(depRepo, { name: 'fixture-gitdep', version: '1.0.0', scripts: lifecycle });
  const depSpec = `git+file://${depRepo}#${depSha}`;
  // Plugin WITH a transitive malicious dependency (closure not enumerated).
  const closureRepo = join(WORK, 'fixture-plugin-closure');
  const closureSha = makeRepo(closureRepo, { name: 'fixture-plugin-closure', version: '1.0.0', dependencies: { 'fixture-gitdep': depSpec }, dsh: { bundle: { patch: 'cordis.patch.yml' } } }, { 'cordis.patch.yml': '# fixture\n' });
  // Plugin with NO scripts and NO dependencies (source-only refusal bypassed).
  const plainRepo = join(WORK, 'fixture-plugin-plain');
  const plainSha = makeRepo(plainRepo, { name: 'fixture-plugin-plain', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }, { 'cordis.patch.yml': '# fixture\n' });
  // Plugin whose ROOT declares lifecycle scripts (must be refused).
  const scriptedRepo = join(WORK, 'fixture-plugin-scripted');
  const scriptedSha = makeRepo(scriptedRepo, { name: 'fixture-plugin-scripted', version: '1.0.0', scripts: { preinstall: script('root-preinstall') }, dsh: { bundle: { patch: 'cordis.patch.yml' } } }, { 'cordis.patch.yml': '# fixture\n' });

  const provider = (sha, manifestText) => ({ resolveManifest: async () => ({ ok: true, value: { commitSha: sha, manifestText, lockText: null } }) });
  const manifestOf = (repo) => readFileSync(join(repo, 'package.json'), 'utf8');
  const planFor = (source, resolution) => ({
    planId: 'plan-0000000000000001', environmentId: 'env-0000000000000001', baseRevision: 1,
    action: { kind: 'install', source }, createdAt: '2026-09-22T00:00:00.000Z', expiresAt: '2026-09-22T01:00:00.000Z',
    sourceLock: resolution.sourceLock, scriptAssessment: resolution.scriptAssessment, scripts: resolution.scripts,
    requiresBuildAuthorization: resolution.requiresBuildAuthorization, riskItems: resolution.riskItems,
    removals: [], retention: [], blockingReferences: [], executor: resolution.executor, planInputsDigest: resolution.planInputsDigest,
  });
  const stageCommand = (generationId, source, resolution, extra) => ({
    environmentId: 'env-0000000000000001', generationId,
    generationDirectory: join(WORK, generationId), environmentDirectory: join(WORK, `env-${generationId}`), homeDirectory: join(WORK, `home-${generationId}`),
    nodeExecutable: NODE, currentLock: CURRENT_LOCK, plan: planFor(source, resolution), buildAuthorization: null, ...extra,
  });
  const resolve = (source, sha, manifestText) => {
    const built = buildPreviewResolution({ source, resolved: { commitSha: sha, manifestText, lockText: null }, executor: identity.value });
    if (!built.ok) throw new Error('fixture resolution failed');
    return built.value;
  };

  // ---- A. root refusal (S4 closed): no install, 0 markers.
  clearMarkers();
  const scriptedSource = { owner: 'fixture', name: 'fixture-plugin-scripted', ref: null };
  const scriptedResolution = resolve(scriptedSource, scriptedSha, manifestOf(scriptedRepo));
  const refusalPort = createPluginApplyPort({ gitProvider: provider(scriptedSha, manifestOf(scriptedRepo)), executor });
  const rootRefusal = await refusalPort.stage(stageCommand('gen-root-refusal', scriptedSource, scriptedResolution), new AbortController().signal);
  const rootRefusalCode = rootRefusal.ok ? 'INSTALLED' : rootRefusal.code;
  const rootRefusalMarkers = markerNames().length;
  const rootRefusalInstalled = existsSync(join(WORK, 'gen-root-refusal', 'profile', 'node_modules'));
  console.log(`A root-script refusal: code=${rootRefusalCode} markers=${rootRefusalMarkers} anyInstall=${String(rootRefusalInstalled)}`);

  // ---- E. closure-not-enumerated refusal: no install, 0 markers.
  clearMarkers();
  const closureSource = { owner: 'fixture', name: 'fixture-plugin-closure', ref: null };
  const closureSourceResolution = resolve(closureSource, closureSha, manifestOf(closureRepo));
  const closureRefusalPort = createPluginApplyPort({ gitProvider: provider(closureSha, manifestOf(closureRepo)), executor });
  const closureRefusal = await closureRefusalPort.stage(stageCommand('gen-closure-refusal', closureSource, closureSourceResolution), new AbortController().signal);
  const closureRefusalCode = closureRefusal.ok ? 'INSTALLED' : closureRefusal.code;
  const closureRefusalMarkers = markerNames().length;
  const closureRefusalInstalled = existsSync(join(WORK, 'gen-closure-refusal', 'profile', 'node_modules'));
  console.log(`E closure refusal: assessment=${closureSourceResolution.scriptAssessment} code=${closureRefusalCode} markers=${closureRefusalMarkers} anyInstall=${String(closureRefusalInstalled)}`);

  // ---- B. production executor + closure negative control (install really happens).
  clearMarkers();
  const staging = join(WORK, 'staging');
  mkdirSync(staging, { recursive: true });
  const workspaceText = 'blockExoticSubdeps: false\n';
  writeJson(join(staging, 'package.json'), { name: 'hdsl-profile-fixture', private: true, dependencies: { 'fixture-plugin-closure': `git+file://${closureRepo}#${closureSha}` }, dsh: { profile: { bundles: ['fixture-plugin-closure'] } } });
  writeFileSync(join(staging, 'pnpm-workspace.yaml'), workspaceText);
  const runDeny = await executor.run({ cwd: staging, homeDirectory: join(WORK, 'home-b'), nodeExecutable: NODE, args: [...DEFAULT_INSTALL_ARGS] }, new AbortController().signal);
  if (!runDeny.ok) throw new Error(`executor run failed: ${runDeny.message}`);
  const closurePresent = packageInstalled(join(staging, 'node_modules'), 'fixture-gitdep');
  const denyMarkers = markerNames().length;
  console.log(`B executor deny (${DEFAULT_INSTALL_ARGS.join(' ')}): exit=${runDeny.value.exitCode} markers=${denyMarkers} transitiveDepPresent=${String(closurePresent)}`);
  if (!existsSync(join(staging, 'pnpm-lock.yaml'))) throw new Error('the production executor produced no pnpm-lock.yaml');

  // ---- C. production apply boundary install of the frozen target profile.
  // The lock must be the one produced for THIS declaration, so resolve it with
  // the production executor first (that run is itself another deny observation).
  clearMarkers();
  const plainSource = { owner: 'fixture', name: 'fixture-plugin-plain', ref: null };
  const plainResolution = resolve(plainSource, plainSha, manifestOf(plainRepo));
  const profileDeclaration = { name: 'hdsl-profile-fixture', private: true, dependencies: { 'fixture-plugin-plain': `git+file://${plainRepo}#${plainSha}`, 'fixture-gitdep': depSpec }, dsh: { profile: { bundles: ['fixture-plugin-plain'] } } };
  const stagingC = join(WORK, 'staging-c');
  mkdirSync(stagingC, { recursive: true });
  writeJson(join(stagingC, 'package.json'), profileDeclaration);
  writeFileSync(join(stagingC, 'pnpm-workspace.yaml'), workspaceText);
  const runDenyC = await executor.run({ cwd: stagingC, homeDirectory: join(WORK, 'home-c'), nodeExecutable: NODE, args: [...DEFAULT_INSTALL_ARGS] }, new AbortController().signal);
  if (!runDenyC.ok || runDenyC.value.exitCode !== 0) throw new Error(`target-profile lock run failed: ${runDenyC.ok ? runDenyC.value.exitCode : runDenyC.message}`);
  const lockText = readFileSync(join(stagingC, 'pnpm-lock.yaml'), 'utf8');
  console.log(`C0 target-profile lock resolved (deny): exit=${runDenyC.value.exitCode} markers=${markerNames().length} depPresent=${String(packageInstalled(join(stagingC, 'node_modules'), 'fixture-gitdep'))}`);
  clearMarkers();
  const applyPort = createPluginApplyPort({ gitProvider: provider(plainSha, manifestOf(plainRepo)), executor });
  const applyPlan = planFor(plainSource, plainResolution);
  const applySourceLock = { ...plainResolution.sourceLock, closureLockSha256: sha256(lockText) };
  const applied = await applyPort.stage(stageCommand('gen-apply', plainSource, plainResolution, {
    plan: { ...applyPlan, sourceLock: applySourceLock },
    targetProfile: { lockText, declarationText: `${JSON.stringify(profileDeclaration, null, 2)}\n`, workspaceText },
  }), new AbortController().signal);
  const applyCode = applied.ok ? 'OK' : applied.code;
  if (!applied.ok) console.error(`C apply failure: ${applied.code} ${applied.message}`);
  const applyMarkers = markerNames().length;
  const applyDepPresent = packageInstalled(join(WORK, 'gen-apply', 'profile', 'node_modules'), 'fixture-gitdep');
  console.log(`C apply-boundary deny (--frozen-lockfile --ignore-scripts): code=${applyCode} markers=${applyMarkers} depPresent=${String(applyDepPresent)}`);

  // ---- D. isolated test-only positive control (NOT S4, never production).
  clearMarkers();
  const allowDir = join(WORK, 'allow');
  mkdirSync(allowDir, { recursive: true });
  writeJson(join(allowDir, 'package.json'), { name: 'hdsl-profile-fixture', private: true, dependencies: { 'fixture-gitdep': depSpec, 'fixture-plugin-plain': `git+file://${plainRepo}#${plainSha}` } });
  writeFileSync(join(allowDir, 'pnpm-workspace.yaml'), `blockExoticSubdeps: false\nallowBuilds:\n  fixture-gitdep@${depSpec}: true\n`);
  const runAllow = await executor.run({ cwd: allowDir, homeDirectory: join(WORK, 'home-allow'), nodeExecutable: NODE, args: ['install', '--ignore-scripts=false'] }, new AbortController().signal);
  if (!runAllow.ok) throw new Error(`allow run failed: ${runAllow.message}`);
  const allowMarkers = markerNames().length;
  console.log(`D isolated allow (test-only): exit=${runAllow.value.exitCode} markers=${allowMarkers} triggered=${String(allowMarkers >= 4)}`);

  const pass = rootRefusalCode === 'BUILD_NOT_AUTHORIZED' && rootRefusalMarkers === 0 && !rootRefusalInstalled
    && closureRefusalCode === 'BUILD_NOT_AUTHORIZED' && closureRefusalMarkers === 0 && !closureRefusalInstalled
    && runDeny.value.exitCode === 0 && denyMarkers === 0 && closurePresent
    && applyCode === 'OK' && applyMarkers === 0 && applyDepPresent
    && allowMarkers >= 4;
  console.log(pass
    ? 'RESULT: PASS — refusal paths (root scripts / unenumerated closure) never executed anything; the production executor AND the production apply-boundary install really installed the malicious dependency with 0 markers under default deny; the isolated test-only allow proved the sentinel is live'
    : 'RESULT: FAIL');
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (process.env.KEEP === '1' && process.exitCode === 1) console.error(`kept ${WORK}`); else rmSync(WORK, { recursive: true, force: true });
}
