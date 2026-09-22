// S4 real managed-pnpm `.pnpm` transitive-layout probe (opt-in, offline).
//
// It serves a minimal LOCAL registry (localhost HTTP) with two registry-style
// packages and runs the REAL frozen managed pnpm 11.7.0 with DEFAULT DENY
// (`install --ignore-scripts`): NO lifecycle script executes (markers=0). It then
// runs the production enumerator against the REAL generated `node_modules/.pnpm`
// layout. `blockExoticSubdeps` is never disabled; the ONLY executable code is the
// already-reviewed `mark.mjs` (sha256 checked), and it never runs here.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { register } from 'node:module';

register('../../tests/core/support/a2-window-hook.mjs', import.meta.url);
const runtime = await import('@hdsl/runtime');
const { enumerateInstallScriptsFromInstalledTree } = runtime;

if (process.env['HDSL_S4_LAYOUT'] !== '1') {
  console.log('SKIP: set HDSL_S4_LAYOUT=1');
  process.exit(0);
}
const NODE = process.env['HDSL_S4_NODE'];
const PNPM = process.env['HDSL_S4_PNPM'];
if (NODE === undefined || PNPM === undefined || !existsSync(NODE) || !existsSync(PNPM)) {
  console.log('SKIP: set HDSL_S4_NODE and HDSL_S4_PNPM');
  process.exit(0);
}
const MARK_SOURCE = process.env['HDSL_S4_MARK_MJS'] ?? '/tmp/qa33/s4-fixture/fixture-gitdep/scripts/mark.mjs';
const REVIEWED_MARK_SHA = '62dd040f0e2ca3f354ee42ad302d5c8a581b1cbe089608b0abbce1f46c8ec16c';

const results = [];
const check = (name, pass, detail = '') => {
  results.push([name, pass]);
  console.log(`CHECK ${pass ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

if (!existsSync(MARK_SOURCE)) {
  console.log('SKIP: reviewed mark.mjs fixture not found');
  process.exit(0);
}
const markBytes = readFileSync(MARK_SOURCE);
check('executed marker code is byte-identical to the reviewed v2 mark.mjs', createHash('sha256').update(markBytes).digest('hex') === REVIEWED_MARK_SHA);

const work = mkdtempSync(join(tmpdir(), 'hdsl-s4-layout-'));
const keep = process.env['KEEP'] === '1';
console.log(`work=${work}`);
const registry = join(work, 'registry');
const profile = join(work, 'profile');
const home = join(work, 'home');
const markers = join(work, 'markers');
for (const dir of [registry, profile, home, markers]) mkdirSync(dir, { recursive: true });

const tarballFor = (name, dir) => {
  const tgzDir = join(registry, name, '-');
  mkdirSync(tgzDir, { recursive: true });
  const tgz = join(tgzDir, `${name}-1.0.0.tgz`);
  const res = spawnSync('tar', ['-czf', tgz, '-C', dir, 'package'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`tar failed: ${res.stderr}`);
  return tgz;
};
const packPackage = (name, files, manifest) => {
  const dir = join(registry, '_src', name);
  mkdirSync(join(dir, 'package', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'package', rel)), { recursive: true });
    writeFileSync(join(dir, 'package', rel), content);
  }
  return tarballFor(name, dir);
};

const parentManifest = {
  name: 's4-layout-parent',
  version: '1.0.0',
  private: false,
  dependencies: { 's4-layout-transitive': '1.0.0' },
};
const transitiveManifest = {
  name: 's4-layout-transitive',
  version: '1.0.0',
  private: false,
  files: ['scripts/mark.mjs'],
  scripts: {
    preinstall: 'node scripts/mark.mjs s4-layout-preinstall',
    install: 'node scripts/mark.mjs s4-layout-install',
    postinstall: 'node scripts/mark.mjs s4-layout-postinstall',
    prepare: 'node scripts/mark.mjs s4-layout-prepare',
  },
};
const parentTgz = packPackage('s4-layout-parent', {}, parentManifest);
const transitiveTgz = packPackage('s4-layout-transitive', { 'scripts/mark.mjs': markBytes }, transitiveManifest);

const metadata = (tgzPath, manifest) => {
  const bytes = readFileSync(tgzPath);
  return {
    name: manifest.name,
    'dist-tags': { latest: manifest.version },
    versions: {
      [manifest.version]: {
        ...manifest,
        dist: {
          tarball: `http://127.0.0.1:PORT/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`,
          shasum: createHash('sha1').update(bytes).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        },
      },
    },
  };
};

let port = 0;
const server = createServer((request, response) => {
  const url = request.url ?? '/';
  const pkgName = url.split('/')[1];
  const isTarball = url.endsWith('.tgz');
  if (isTarball) {
    const name = url.split('/')[1];
    const path = join(registry, name, '-', `${name}-1.0.0.tgz`);
    if (!existsSync(path)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(readFileSync(path));
    return;
  }
  const manifest = pkgName === 's4-layout-parent' ? parentManifest : pkgName === 's4-layout-transitive' ? transitiveManifest : null;
  if (manifest === null) {
    response.writeHead(404).end();
    return;
  }
  const tgz = pkgName === 's4-layout-parent' ? parentTgz : transitiveTgz;
  const body = JSON.stringify(metadata(tgz, manifest)).replaceAll('PORT', String(port));
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(body);
});

const runPnpm = (args) =>
  // Async spawn so the in-process local registry can answer while pnpm runs
  // (spawnSync would block the event loop and deadlock the registry).
  new Promise((resolve) => {
    const child = spawn(NODE, [PNPM, ...args], {
      cwd: profile,
      env: { HOME: home, DSH_HOME: home, TMPDIR: join(home, '.tmp'), PATH: `${dirname(NODE)}:/usr/bin:/bin`, S4_MARKER_DIR: markers },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, output });
    });
  });
const markerNames = () => {
  try {
    return readdirSync(markers).map((n) => n.replace(/\.marker$/, '')).sort();
  } catch {
    return [];
  }
};
const readPackageJsonText = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

try {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
  writeFileSync(
    join(profile, 'package.json'),
    `${JSON.stringify({ name: 'hdsl-s4-layout-profile', private: true, dependencies: { 's4-layout-parent': '1.0.0' } }, null, 2)}\n`,
    'utf8',
  );
  const install = await runPnpm(['install', '--ignore-scripts', `--registry=http://127.0.0.1:${port}`]);
  if (install.status !== 0) console.log('INSTALL_OUTPUT ' + install.output.split('\n').slice(-14).join(' | '));
  check('real managed pnpm default-deny install exits 0', install.status === 0, `status=${String(install.status)}`);
  check('default deny executes no lifecycle script (markers=0)', markerNames().length === 0, JSON.stringify(markerNames()));

  const transitivePath = join(profile, 'node_modules', '.pnpm', 's4-layout-transitive@1.0.0', 'node_modules', 's4-layout-transitive', 'package.json');
  check('real pnpm generated the transitive package in .pnpm', existsSync(transitivePath), transitivePath);
  const topLevel = join(profile, 'node_modules', 's4-layout-transitive');
  check('the transitive package is NOT top-level linked (only in .pnpm)', !existsSync(topLevel));
  console.log(`OBSERVE .pnpm entries=${JSON.stringify(readdirSync(join(profile, 'node_modules', '.pnpm')).filter((n) => !n.startsWith('.')))}`);

  const lockText = readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8');
  const scripts = enumerateInstallScriptsFromInstalledTree({
    nodeModulesDirectory: join(profile, 'node_modules'),
    lockText,
    excludePackageName: 's4-layout-parent',
    readPackageJsonText,
  });
  check(
    'production enumerator finds the real .pnpm-only transitive scripts',
    scripts !== undefined && scripts.length === 4 && scripts.every((s) => s.packageName === 's4-layout-transitive' && s.source === 'dependency'),
    JSON.stringify(scripts),
  );

  // Negative control on OUR OWN copy: remove a reachable manifest => unknown.
  const copy = join(work, 'copy');
  spawnSync('cp', ['-R', join(profile, 'node_modules'), join(copy)], { encoding: 'utf8' });
  rmSync(join(copy, '.pnpm', 's4-layout-transitive@1.0.0', 'node_modules', 's4-layout-transitive', 'package.json'), { force: true });
  const broken = enumerateInstallScriptsFromInstalledTree({
    nodeModulesDirectory: copy,
    lockText,
    excludePackageName: 's4-layout-parent',
    readPackageJsonText,
  });
  check('missing real .pnpm manifest => undefined (unknown, fail-closed)', broken === undefined);

  const failed = results.filter(([, pass]) => !pass);
  console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length} checks`);
  console.log(`META parent=${JSON.stringify(parentManifest)}`);
  console.log(`META transitive=${JSON.stringify(transitiveManifest)}`);
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`RESULT: FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  server.close();
  if (keep && process.exitCode === 1) console.error(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
