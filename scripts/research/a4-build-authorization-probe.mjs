// S4 explicit build-authorization positive/negative control (opt-in, #78).
//
// Uses the independently reviewed fixture v2 (root 1a62a314 + git dependency
// e0a618d5, 8 distinct lifecycle markers, fail-closed mark.mjs) and the REAL
// frozen managed pnpm 11.7.0 + managed Node. It proves, with EXTERNAL markers,
// that default deny executes nothing and that only an exact authorization (bound
// to the pinned lock depPaths by the runtime helper) executes the authorized
// scripts — never a global allow, never a name-only git key.
//
// The fixture scripts only write `<S4_MARKER_DIR>/<name>.marker`; there is no
// network, credential, model, third-party dependency, child process or out-of-
// scope write. Deny/allow symmetry is observed from the filesystem, not from any
// executor self-report.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { register } from 'node:module';

register('../../tests/core/support/a2-window-hook.mjs', import.meta.url);
const runtime = await import('@hdsl/runtime');
const {
  bindAuthorizedScriptsToLock,
  composeAuthorizedWorkspace,
  enumerateInstallScriptsFromInstalledTree,
  sameBuildScriptSet,
  BUILD_LIFECYCLE_SCRIPTS,
} = runtime;

if (process.env['HDSL_S4_AUTHORIZATION'] !== '1') {
  console.log('SKIP: set HDSL_S4_AUTHORIZATION=1');
  process.exit(0);
}
const NODE = process.env['HDSL_S4_NODE'];
const PNPM = process.env['HDSL_S4_PNPM'];
if (NODE === undefined || PNPM === undefined || !existsSync(NODE) || !existsSync(PNPM)) {
  console.log('SKIP: set HDSL_S4_NODE (managed node) and HDSL_S4_PNPM (frozen bin/pnpm.mjs)');
  process.exit(0);
}
const ROOT_REPO = process.env['HDSL_S4_ROOT_REPO'] ?? '/tmp/qa33/s4-fixture/fixture-root';
const DEP_REPO = process.env['HDSL_S4_DEP_REPO'] ?? '/tmp/qa33/s4-fixture/fixture-gitdep';
const ROOT_COMMIT = '1a62a31449bf27127a815ebdd97fbde75294ee33';
const DEP_COMMIT = 'e0a618d5f17d15817f6ebad7cc48e03608e83792';

const results = [];
const check = (name, pass, detail = '') => {
  results.push([name, pass]);
  console.log(`CHECK ${pass ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

const gitShow = (repo, ref, path) =>
  execFileSync('git', ['-C', repo, 'show', `${ref}:${path}`], { encoding: 'utf8' });

// --- fixture identity (exact commit; never an undeclared HEAD) ---
const rootHead = execFileSync('git', ['-C', ROOT_REPO, 'rev-parse', `refs/tags/base-v2^{commit}`], { encoding: 'utf8' }).trim();
const depHead = execFileSync('git', ['-C', DEP_REPO, 'rev-parse', `refs/tags/base-v2^{commit}`], { encoding: 'utf8' }).trim();
check('root fixture tag base-v2 resolves to the declared commit', rootHead === ROOT_COMMIT, rootHead);
check('dep fixture tag base-v2 resolves to the declared commit', depHead === DEP_COMMIT, depHead);

const rootManifest = JSON.parse(gitShow(ROOT_REPO, ROOT_COMMIT, 'package.json'));
const depManifest = JSON.parse(gitShow(DEP_REPO, DEP_COMMIT, 'package.json'));
check('root dep spec binds the exact dep commit', rootManifest.dependencies['s4-fixture-gitdep'] === `git+file://${DEP_REPO}#${DEP_COMMIT}`);

const work = mkdtempSync(join(tmpdir(), 'hdsl-s4-auth-'));
const keep = process.env['KEEP'] === '1';
console.log(`work=${work}`);
const profile = join(work, 'profile');
const home = join(work, 'home');
const markers = join(work, 'markers');
mkdirSync(profile, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(markers, { recursive: true });

const runPnpm = (args) => {
  const result = spawnSync(NODE, [PNPM, ...args], {
    cwd: profile,
    env: { HOME: home, DSH_HOME: home, TMPDIR: join(home, '.tmp'), PATH: `${dirname(NODE)}:/usr/bin:/bin`, S4_MARKER_DIR: markers },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
const markerNames = () => {
  try {
    return readdirSync(markers).map((name) => name.replace(/\.marker$/, '')).sort();
  } catch {
    return [];
  }
};
const clearMarkers = () => {
  for (const name of readdirSync(markers)) {
    rmSync(join(markers, name), { force: true });
  }
};

try {
  // The reviewed fixture root is used as the PROJECT root (its own direct git
  // dependency), which avoids pnpm 11.7.0's default `blockExoticSubdeps` (a git
  // dep inside a git-installed package). This does NOT widen any policy.
  for (const rel of ['lib/index.mjs', 'cordis.patch.yml', 'scripts/mark.mjs']) {
    const target = join(profile, rel);
    mkdirSync(join(profile, rel, '..'), { recursive: true });
    writeFileSync(target, gitShow(ROOT_REPO, ROOT_COMMIT, rel), 'utf8');
  }
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify(rootManifest, null, 2)}\n`, 'utf8');

  // --- default deny: materialise, execute nothing ---
  const deny = runPnpm(['install', '--ignore-scripts']);
  check('default deny install exits 0', deny.status === 0, `status=${String(deny.status)} stderr=${deny.stderr.split('\n').slice(-3).join(' | ')}`);
  check('default deny executes NO third-party script (markers=0)', markerNames().length === 0, `markers=${JSON.stringify(markerNames())}`);
  const lockText = readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8');

  // --- enumerate the effective set (root manifest hooks + installed closure) ---
  const rootScripts = BUILD_LIFECYCLE_SCRIPTS.filter((script) => typeof rootManifest.scripts?.[script] === 'string').map((script) => ({
    packageName: rootManifest.name,
    packageVersion: rootManifest.version,
    script,
    source: 'root',
  }));
  const depScripts = enumerateInstallScriptsFromInstalledTree({
    nodeModulesDirectory: join(profile, 'node_modules'),
    excludePackageName: rootManifest.name,
    readPackageJsonText: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  });
  const effective = [...rootScripts, ...depScripts];
  check('effective enumerated set is root 4 + dep 4 (8 entries)', effective.length === 8, JSON.stringify(effective));
  const depScriptsFromTree = depScripts.filter((entry) => entry.packageName === 's4-fixture-gitdep');
  check('dependency hooks are enumerated as source=dependency', depScriptsFromTree.length === 4 && depScriptsFromTree.every((entry) => entry.source === 'dependency'));

  // --- bind the exact depPaths from the pinned lock (dependency entries only:
  //     the project root itself is not a lock package) ---
  const bound = bindAuthorizedScriptsToLock(lockText, depScriptsFromTree);
  check('every authorized dependency package binds to exactly one pinned-lock depPath', bound.ok, bound.ok ? JSON.stringify(bound.depPaths) : bound.message);
  if (!bound.ok) throw new Error(bound.message);
  const authorizationScripts = effective.map((entry) => ({ ...entry }));
  check('authorization set equals the enumerated set (multiset)', sameBuildScriptSet(authorizationScripts, effective));
  check('a subset authorization is rejected', !sameBuildScriptSet(authorizationScripts.slice(0, -1), effective));

  // --- exact allow: only the authorized scripts may execute ---
  clearMarkers();
  const composed = composeAuthorizedWorkspace(null, bound.depPaths);
  if (!composed.ok) throw new Error(composed.message);
  check('workspace carries only the exact allowBuilds keys (no global switch)', !composed.text.includes('dangerouslyAllowAllBuilds') && !composed.text.includes('onlyBuiltDependencies'));
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), composed.text, 'utf8');
  // Force a real materialisation so the authorized lifecycle hooks execute (a
  // no-op "already up to date" install would run nothing). The pinned lock is kept.
  rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
  const allow = runPnpm(['install', '--frozen-lockfile', '--ignore-scripts=false']);
  const observed = markerNames();
  check('exact authorized install exits 0', allow.status === 0, `status=${String(allow.status)} stderr=${allow.stderr.split('\n').slice(-3).join(' | ')}`);
  const rootObserved = observed.filter((name) => name.startsWith('root-'));
  const depObserved = observed.filter((name) => name.startsWith('gitdep-'));
  check('authorized install triggers the root lifecycle markers', rootObserved.length > 0, JSON.stringify(rootObserved));
  check('authorized install triggers the dependency lifecycle markers', depObserved.length > 0, JSON.stringify(depObserved));
  console.log(`OBSERVE triggered=${JSON.stringify(observed)} notTriggered=${JSON.stringify(
    effective
      .map((entry) => `${entry.packageName === 's4-fixture-root' ? 'root' : 'gitdep'}-${entry.script}`)
      .filter((name) => !observed.includes(name)),
  )}`);
  // Remove the single-install authorization (mirrors apply-port).
  rmSync(join(profile, 'pnpm-workspace.yaml'), { force: true });

  // --- drift: hashed scripts-v2 dep must not run under the old authorization ---
  clearMarkers();
  const depScriptsV2 = execFileSync('git', ['-C', DEP_REPO, 'rev-parse', 'refs/tags/base-v2-scripts-v2^{commit}'], { encoding: 'utf8' }).trim();
  check('scripts-v2 dep variant exists (old authorization invalidation control)', depScriptsV2 === 'a716bb9658de5a93af5bbbef90c7747d647a5ce5', depScriptsV2);
  const driftDecision = sameBuildScriptSet(effective, [{ ...effective[0], script: 'postinstall' }]);
  check('drifted script set is not equal (would refuse)', driftDecision === false);

  const failed = results.filter(([, pass]) => !pass);
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length} checks`);
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (keep && process.exitCode === 1) console.error(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
