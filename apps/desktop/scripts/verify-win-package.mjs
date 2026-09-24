/**
 * Build-integrity check for the unsigned Windows x64 portable directory
 * (`electron-builder --win --x64 --dir` output, `release/win-unpacked`).
 *
 * This is a **file-tree** check only. It never starts `HDSL.exe`, never runs
 * the packaged app and never runs a Windows test: the deliverable is an
 * unsigned build with no Windows machine evidence (see
 * `docs/development/windows-portable-build.md`). What it does assert is that
 * the archive can only pass when the production workspace modules, the runtime
 * static catalog and the renderer assets are present, and when development
 * leftovers, user data, diagnostics and credentials are absent.
 *
 * Usage: node scripts/verify-win-package.mjs <win-unpacked-directory>
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Paths that must exist in `win-unpacked` for the archive to be usable. */
export const REQUIRED_FILES = [
  'HDSL.exe',
  'resources/app/package.json',
  // Electron main / preload / renderer entry points (production entry only).
  'resources/app/dist/main/index.js',
  'resources/app/dist/preload/bridge.cjs',
  'resources/app/dist/renderer/index.html',
  'resources/app/dist/renderer/app.js',
  'resources/app/dist/renderer/styles.css',
  // Production workspace modules: the main process imports these by name at
  // runtime, so a build that only ships the renderer bundle is not usable.
  'resources/app/node_modules/@hdsl/contracts/package.json',
  'resources/app/node_modules/@hdsl/contracts/dist/index.js',
  'resources/app/node_modules/@hdsl/core/package.json',
  'resources/app/node_modules/@hdsl/core/dist/index.js',
  'resources/app/node_modules/@hdsl/runtime/package.json',
  'resources/app/node_modules/@hdsl/runtime/dist/index.js',
  'resources/app/node_modules/@hdsl/runtime/dist/catalog/dependency-closure.js',
  // Runtime static catalog. `dependency-closure.ts` resolves
  // `../../catalog/dsh-<version>` from `dist/catalog/` with `import.meta.url`,
  // so these JSON files live beside `dist` inside the package, not in it.
  'resources/app/node_modules/@hdsl/runtime/catalog/dsh-0.1.5-rc.2/closure.json',
  'resources/app/node_modules/@hdsl/runtime/catalog/dsh-0.1.7-rc.1/closure.json',
  // Declared production dependencies of the desktop package.
  'resources/app/node_modules/react/package.json',
  'resources/app/node_modules/react-dom/package.json',
  'resources/app/node_modules/yaml/package.json',
];

/** Path-independent rules for content that must never reach the archive. */
export const FORBIDDEN_RULES = [
  { id: 'qa-entry', test: (p) => p === 'resources/app/dist/main/qa-entry.js', why: 'the headless QA entry is a test entry and must never ship' },
  { id: 'source-map', test: (p) => p.startsWith('resources/app/dist/') && p.endsWith('.map'), why: 'build maps are not needed and are excluded from the package' },
  { id: 'app-sources', test: (p) => p.startsWith('resources/app/src/'), why: 'unbuilt TypeScript sources are not part of the package' },
  { id: 'workspace-manifests', test: (p) => p === 'resources/app/pnpm-lock.yaml' || p === 'resources/app/pnpm-workspace.yaml', why: 'workspace manifests are repository metadata, not application content' },
  { id: 'git-metadata', test: (p) => p.split('/').includes('.git'), why: 'repository metadata is not distributable content' },
  { id: 'logs', test: (p) => p.endsWith('.log'), why: 'logs may contain unsanitized operator data' },
  { id: 'diagnostics', test: (p) => p.split('/').some((part) => part.includes('hdsl-diagnostics') || part.includes('diagnostics-export')), why: 'diagnostic exports are per-user data' },
  { id: 'credentials', test: (p) => p.endsWith('.credentials.yaml') || p.includes('/.hdsl/'), why: 'credentials and local runtime state must never be packaged' },
  { id: 'dev-cache', test: (p) => p.split('/').some((part) => part === 'pnpm-cache' || part === '.cache' || part === '.scratch'), why: 'development caches are not distributable content' },
  { id: 'dependency-sources', test: (p) => p.startsWith('resources/app/node_modules/@hdsl/') && p.includes('/src/'), why: 'workspace dependency TypeScript sources are not runtime content' },
  { id: 'dependency-source-map', test: (p) => p.startsWith('resources/app/node_modules/@hdsl/') && p.endsWith('.map'), why: 'workspace dependency build maps are not runtime content' },
  { id: 'test-only-api', test: (p) => p.startsWith('resources/app/node_modules/@hdsl/contracts/dist/testing/'), why: 'the contracts testing subpath is a test-only API and must never ship' },
  { id: 'test-evidence-fixture', test: (p) => p.startsWith('resources/app/node_modules/@hdsl/runtime/catalog/service-verifications/'), why: 'service-verification evidence fixtures are review data, not runtime content' },
  { id: 'dev-dependency', test: (p) => DEV_DEPENDENCY_DIRS.some((name) => p.startsWith(`resources/app/node_modules/${name}/`)), why: 'development-only dependencies must not be packaged' },
];

/** Declared `devDependencies` names that must not appear inside the archive. */
export const DEV_DEPENDENCY_DIRS = [
  '@types',
  'app-builder-bin',
  'dmg-builder',
  'electron',
  'electron-builder',
  'esbuild',
  'typescript',
  'vitest',
];

const toPosix = (value) => value.split(sep).join('/');

const walk = (root, current = root, out = []) => {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, absolute, out);
    } else if (entry.isFile()) {
      out.push(toPosix(relative(root, absolute)));
    }
  }
  return out;
};

/**
 * Checks one unpacked Windows directory.
 *
 * @param {string} appDir `win-unpacked` directory to inspect.
 * @param {{ listFiles?: (dir: string) => string[] }} [options] Test seam for the file walk.
 * @returns {string[]} One message per problem; empty means the tree is complete.
 */
export const verifyPackagedTree = (appDir, options = {}) => {
  const errors = [];
  if (!existsSync(appDir) || !statSync(appDir).isDirectory()) {
    return [`missing packaged directory: ${appDir}`];
  }
  const listFiles = options.listFiles ?? ((dir) => walk(dir));
  let files;
  try {
    files = listFiles(appDir).map(toPosix);
  } catch (error) {
    return [`could not read ${appDir}: ${error instanceof Error ? error.message : 'unknown error'}`];
  }
  const present = new Set(files);
  for (const required of REQUIRED_FILES) {
    if (!present.has(required)) {
      errors.push(`missing required file: ${required}`);
    }
  }
  for (const file of files) {
    for (const rule of FORBIDDEN_RULES) {
      if (rule.test(file)) {
        errors.push(`forbidden content (${rule.id}): ${file} — ${rule.why}`);
      }
    }
  }
  return errors;
};

const main = () => {
  const appDir = process.argv[2];
  if (appDir === undefined || appDir.trim() === '') {
    process.stderr.write('usage: node scripts/verify-win-package.mjs <win-unpacked-directory>\n');
    process.exitCode = 2;
    return;
  }
  const errors = verifyPackagedTree(appDir);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.stderr.write(`FAIL: ${String(errors.length)} problem(s) in ${appDir}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `PASS: ${String(REQUIRED_FILES.length)} required files present, no forbidden content in ${appDir}\n`,
  );
  process.stdout.write('Scope: archive integrity only; the packaged app was not executed.\n');
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
