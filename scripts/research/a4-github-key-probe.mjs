// S4 production GitHub exact-key probe (opt-in, single bounded run, #78).
//
// Uses the published, independently reviewed YingkeSu/hdsl-s4-gh-fixture over the
// REAL production transport (github: shorthand -> codeload) and the frozen
// managed pnpm 11.7.0 + managed Node. It answers, with EXTERNAL markers:
//   - default deny materialises and executes NOTHING;
//   - the exact pnpm `allowBuilds` depPath for a `github:` shorthand source is
//     captured (byte-for-byte) from pnpm's own blocking hint, compared to the
//     pinned-lock key, and used verbatim for a SINGLE allow;
//   - only the 4 authorized `gh-root-*` lifecycle markers appear;
//   - a wrong (name-only) key still blocks with zero markers;
//   - a stale key (base key applied to a drift commit) still blocks.
//
// It never disables blockExoticSubdeps, never writes a workspace/global allow
// list, never uses onlyBuiltDependencies/dangerouslyAllowAllBuilds, and never
// modifies the fixture.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

if (process.env['HDSL_S4_GITHUB_KEY'] !== '1') {
  console.log('SKIP: set HDSL_S4_GITHUB_KEY=1');
  process.exit(0);
}
const NODE = process.env['HDSL_S4_NODE'];
const PNPM = process.env['HDSL_S4_PNPM'];
if (NODE === undefined || PNPM === undefined || !existsSync(NODE) || !existsSync(PNPM)) {
  console.log('SKIP: set HDSL_S4_NODE (managed node) and HDSL_S4_PNPM (frozen bin/pnpm.mjs)');
  process.exit(0);
}
const REPO = 'YingkeSu/hdsl-s4-gh-fixture';
const BASE_COMMIT = 'cb265920d7b0d0d5f3616417cd4053176b998f80';
const DRIFT_COMMIT = 'a5438460723df91701aca3464af3a0db7f55eaa0';
const PACKAGE_NAME = 'hdsl-s4-gh-fixture-root';
const AUTHORIZED_MARKERS = ['gh-root-preinstall', 'gh-root-install', 'gh-root-postinstall', 'gh-root-prepare'];

const results = [];
const check = (name, pass, detail = '') => {
  results.push([name, pass]);
  console.log(`CHECK ${pass ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

const work = mkdtempSync(join(tmpdir(), 'hdsl-s4-gh-key-'));
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
    timeout: 5 * 60_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
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
const writeProfile = (commit, extra = {}) => {
  writeFileSync(
    join(profile, 'package.json'),
    `${JSON.stringify(
      {
        name: 'hdsl-s4-gh-profile',
        private: true,
        dependencies: { [PACKAGE_NAME]: `github:${REPO}#${commit}` },
        dsh: { profile: { bundles: [PACKAGE_NAME] } },
        ...extra,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
};
const writeAllow = (keys) => {
  const map = keys.map((key) => `  ${key}: true`).join('\n');
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), `allowBuilds:\n${map}\n`, 'utf8');
};
const clearAllow = () => rmSync(join(profile, 'pnpm-workspace.yaml'), { force: true });

try {
  // --- base commit: default deny ---
  writeProfile(BASE_COMMIT);
  const deny = runPnpm(['install', '--ignore-scripts']);
  check('github: base default-deny materialisation exits 0', deny.status === 0, `status=${String(deny.status)}`);
  check('github: default deny executes no script (markers=0)', markerNames().length === 0, JSON.stringify(markerNames()));
  const lockText = readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8');
  const lockKeys = [...new Set(lockText.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(`${PACKAGE_NAME}@`)).map((line) => line.replace(/:$/, '')))];
  check('github: pinned-lock records the source key', lockKeys.length >= 1, JSON.stringify(lockKeys));

  // --- capture the exact depPath pnpm requires (blocking hint), zero execution ---
  clearMarkers();
  // Force a real git-dep preparation; an already-materialised tree would skip it.
  rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
  const hint = runPnpm(['install', '--frozen-lockfile', '--ignore-scripts=false']);
  check('github: allow without an allowBuilds entry is blocked', hint.status !== 0, `status=${String(hint.status)}`);
  check('github: blocked attempt executes no script (markers=0)', markerNames().length === 0, JSON.stringify(markerNames()));
  const depPathMatch = /allowBuilds:\s*\n\s*(\S+):\s*true/.exec(hint.output);
  const depPath = depPathMatch?.[1];
  check('github: pnpm hint exposes an exact allowBuilds depPath', typeof depPath === 'string' && depPath.includes(BASE_COMMIT), String(depPath));
  if (typeof depPath !== 'string') {
    console.log('BLOCKED: pnpm did not expose a constructible exact allowBuilds depPath; NOT widening policy.');
    throw new Error('no constructible depPath');
  }
  console.log(`OBSERVE lockKey=${JSON.stringify(lockKeys)} depPath=${JSON.stringify(depPath)} keyEqualsLock=${String(lockKeys.includes(depPath))}`);

  // --- exact single allow ---
  clearMarkers();
  writeAllow([depPath]);
  rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
  const allow = runPnpm(['install', '--frozen-lockfile', '--ignore-scripts=false']);
  const observed = markerNames();
  check('github: exact depPath allow exits 0', allow.status === 0, `status=${String(allow.status)}`);
  check(
    'github: exact depPath allow triggers exactly the 4 authorized markers',
    AUTHORIZED_MARKERS.every((name) => observed.includes(name)) && observed.every((name) => AUTHORIZED_MARKERS.includes(name)),
    JSON.stringify(observed),
  );
  clearAllow();

  // --- negative control: name-only (wrong) key still blocks, zero markers ---
  clearMarkers();
  writeAllow([PACKAGE_NAME]);
  rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
  const wrongKey = runPnpm(['install', '--frozen-lockfile', '--ignore-scripts=false']);
  check('github: name-only (wrong) key is blocked', wrongKey.status !== 0, `status=${String(wrongKey.status)}`);
  check('github: wrong key executes no script (markers=0)', markerNames().length === 0, JSON.stringify(markerNames()));
  clearAllow();

  // --- drift control: base key applied to the drift commit still blocks ---
  clearMarkers();
  writeProfile(DRIFT_COMMIT);
  rmSync(join(profile, 'pnpm-lock.yaml'), { force: true });
  rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
  const driftDeny = runPnpm(['install', '--ignore-scripts']);
  check('github: drift commit default-deny materialisation exits 0', driftDeny.status === 0, `status=${String(driftDeny.status)}`);
  writeAllow([depPath]); // stale base-commit key
  rmSync(join(profile, 'node_modules'), { recursive: true, force: true });
  const stale = runPnpm(['install', '--frozen-lockfile', '--ignore-scripts=false']);
  check('github: stale (base) key applied to drift commit is blocked', stale.status !== 0, `status=${String(stale.status)}`);
  check('github: stale key executes no script (markers=0)', markerNames().length === 0, JSON.stringify(markerNames()));
  clearAllow();

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
