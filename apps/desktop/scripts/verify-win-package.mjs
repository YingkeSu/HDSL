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
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
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
  // `readDependencyClosure` reads `closure.json`, `package.json` and
  // `package-lock.json` together and returns `undefined` if any is absent, so a
  // missing lock file breaks environment creation with INTERNAL_ERROR.
  // electron-builder's default `excludedNames` strips every `package-lock.json`
  // from the app tree, so these two are restored through `extraResources`.
  'resources/app/node_modules/@hdsl/runtime/catalog/dsh-0.1.5-rc.2/package-lock.json',
  'resources/app/node_modules/@hdsl/runtime/catalog/dsh-0.1.7-rc.1/package-lock.json',
  // Declared production dependencies of the desktop package.
  'resources/app/node_modules/react/package.json',
  'resources/app/node_modules/react-dom/package.json',
  'resources/app/node_modules/yaml/package.json',
  // `extraResources`: the license and third-party notices must travel with the
  // installed application, not only with the repository.
  'resources/LICENSE.hdsl.txt',
  'resources/THIRD_PARTY_NOTICES.md',
];

/** Path-independent rules for content that must never reach the archive. */
export const FORBIDDEN_RULES = [
  { id: 'qa-entry', test: (p) => p === 'resources/app/dist/main/qa-entry.js', why: 'the headless QA entry is a test entry and must never ship' },
  { id: 'renderer-test-entry', test: (p) => p.startsWith('resources/app/dist/renderer/testing/'), why: 'stale renderer test entries are development artifacts and must never ship' },
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

/**
 * High-signal content markers that must never appear in packaged runtime files.
 *
 * The path rules above catch test/QA artifacts by name; these catch the same
 * content when it is inlined into a bundle or a stray file. They are
 * deliberately narrow so a legitimate production bundle (which does contain
 * words like `apiKey`, `secret` and `127.0.0.1`) cannot trip them. A violation
 * reports only the rule id, the relative path and why — never the matched text.
 */
export const CONTENT_MARKERS = [
  {
    id: 'qa-opt-in-env',
    pattern: /HDSL_(QA_REAL_INSTALL|REAL_PROCESS|KEYCHAIN_CANARY|E2E_MAIN_FLOW|REAL_WEBUI_BOOTSTRAP|QA_REAL_DSH)/,
    why: 'test-only opt-in environment variable names must not ship',
  },
  { id: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, why: 'private key material must never ship' },
  { id: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/, why: 'AWS access key material must never ship' },
  {
    id: 'github-token',
    pattern: /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
    why: 'GitHub token material must never ship',
  },
];

/** Per-file content-scan cap; the renderer bundle and main entry are far smaller. */
export const MAX_CONTENT_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * Scans one packaged file for [CONTENT_MARKERS]. Binary files (NUL bytes) and
 * oversized files are skipped, and the return value never contains the matched
 * text.
 *
 * @param {string} filePath Absolute path of a file inside the packaged tree.
 * @returns {Array<{ id: string, why: string }>} One entry per matched marker.
 */
export const scanFileContent = (filePath) => {
  const violations = [];
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return violations;
  }
  if (!stat.isFile() || stat.size === 0) return violations;
  const length = Math.min(stat.size, MAX_CONTENT_SCAN_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  let slice;
  try {
    const read = readSync(fd, buffer, 0, length, 0);
    slice = buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  if (slice.includes(0)) return violations; // Binary asset; markers are textual.
  const text = slice.toString('utf8');
  for (const marker of CONTENT_MARKERS) {
    if (marker.pattern.test(text)) violations.push({ id: marker.id, why: marker.why });
  }
  return violations;
};

/**
 * Full audit of a packaged tree: [verifyPackagedTree] path rules plus the
 * content scan above. Used against the actual installed payload, never instead
 * of it.
 *
 * @param {string} appDir Installed application directory.
 * @returns {{ errors: string[], files: number, markerFiles: number }} Sanitized result.
 */
export const auditPackagedTree = (appDir) => {
  const errors = verifyPackagedTree(appDir);
  let files = [];
  try {
    files = walk(appDir);
  } catch {
    return { errors, files: 0, markerFiles: 0 };
  }
  let markerFiles = 0;
  for (const file of files) {
    const violations = scanFileContent(join(appDir, file));
    if (violations.length > 0) {
      markerFiles += 1;
      for (const violation of violations) {
        errors.push(`forbidden content (${violation.id}): ${file} — ${violation.why}`);
      }
    }
  }
  return { errors, files: files.length, markerFiles };
};

/**
 * Format check for the `.exe` deliverable produced by the `nsis` target.
 *
 * A Windows installer is a PE executable, and NSIS stamps every installer and
 * uninstaller it builds with the `NullsoftInst` signature block. Requiring both
 * means a renamed `HDSL.exe` from `win-unpacked` (also a PE file) cannot pass as
 * an installer, which is exactly the substitution this deliverable must rule
 * out. This is a file-format check only: it never executes the installer.
 */
export const MIN_INSTALLER_BYTES = 1_048_576; // 1 MiB; the NSIS stub alone is larger.
export const NSIS_MARKER = 'NullsoftInst';
const PE_SIGNATURE = 0x0000_4550; // "PE\0\0" as a little-endian uint32.
const PE_HEADER_SCAN_BYTES = 16 * 1024 * 1024; // Bound the marker scan for a large installer.
const CHUNK_BYTES = 1024 * 1024;

const hasNsisMarker = (path, size) => {
  const marker = Buffer.from(NSIS_MARKER, 'latin1');
  const fd = openSync(path, 'r');
  try {
    const limit = Math.min(size, PE_HEADER_SCAN_BYTES);
    let position = 0;
    let tail = Buffer.alloc(0);
    while (position < limit) {
      const length = Math.min(CHUNK_BYTES, limit - position);
      const chunk = Buffer.alloc(length);
      const read = readSync(fd, chunk, 0, length, position);
      if (read <= 0) break;
      const window = Buffer.concat([tail, chunk.subarray(0, read)]);
      if (window.includes(marker)) return true;
      tail = window.subarray(Math.max(0, window.length - marker.length + 1));
      position += read;
    }
    return false;
  } finally {
    closeSync(fd);
  }
};

/**
 * Checks the NSIS `.exe` installer as a file.
 *
 * @param {string} installerPath Installer produced by `electron-builder --win nsis --x64`.
 * @returns {string[]} One message per problem; empty means the file is an NSIS PE installer.
 */
export const verifyInstallerFile = (installerPath) => {
  const errors = [];
  if (!existsSync(installerPath) || !statSync(installerPath).isFile()) {
    return [`missing installer file: ${installerPath}`];
  }
  const size = statSync(installerPath).size;
  if (size < MIN_INSTALLER_BYTES) {
    errors.push(
      `installer is too small to be an Electron NSIS installer: ${String(size)} bytes < ${String(MIN_INSTALLER_BYTES)}`,
    );
  }
  const fd = openSync(installerPath, 'r');
  try {
    const header = Buffer.alloc(64);
    const read = readSync(fd, header, 0, header.length, 0);
    if (read < header.length || header.toString('latin1', 0, 2) !== 'MZ') {
      errors.push(`not a Windows PE executable (missing MZ header): ${installerPath}`);
      return errors;
    }
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > size - 4) {
      errors.push(`not a Windows PE executable (invalid PE header offset): ${installerPath}`);
      return errors;
    }
    const signature = Buffer.alloc(4);
    readSync(fd, signature, 0, signature.length, peOffset);
    if (signature.readUInt32LE(0) !== PE_SIGNATURE) {
      errors.push(`not a Windows PE executable (missing PE signature): ${installerPath}`);
      return errors;
    }
  } finally {
    closeSync(fd);
  }
  if (!hasNsisMarker(installerPath, size)) {
    errors.push(
      `not an NSIS installer (missing ${NSIS_MARKER} signature); a renamed win-unpacked/HDSL.exe is not an installer: ${installerPath}`,
    );
  }
  return errors;
};

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
  const [mode, target] = process.argv.slice(2);
  if (mode === '--installer' && target !== undefined && target.trim() !== '') {
    const errors = verifyInstallerFile(target);
    if (errors.length > 0) {
      process.stderr.write(`${errors.join('\n')}\n`);
      process.stderr.write(`FAIL: ${String(errors.length)} problem(s) in ${target}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `PASS: NSIS PE installer with ${NSIS_MARKER} signature and plausible size in ${target}\n`,
    );
    process.stdout.write('Scope: installer file format only; the installer was not executed.\n');
    return;
  }
  if (mode === '--audit' && target !== undefined && target.trim() !== '') {
    const { errors, files, markerFiles } = auditPackagedTree(target);
    process.stdout.write(`audit directory: ${target}\n`);
    process.stdout.write(`files: ${String(files)}\n`);
    process.stdout.write(`files with forbidden content markers: ${String(markerFiles)}\n`);
    process.stdout.write(`violations: ${String(errors.length)}\n`);
    process.stdout.write('Scope: path rules plus a bounded content scan; no matched value is printed.\n');
    if (errors.length > 0) {
      process.stderr.write(`${errors.join('\n')}\n`);
      process.stderr.write(`FAIL: ${String(errors.length)} problem(s) in ${target}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`PASS: audited ${String(files)} packaged files in ${target}\n`);
    return;
  }
  if (mode === undefined || mode.trim() === '' || mode === '--installer' || mode === '--audit') {
    process.stderr.write(
      'usage: node scripts/verify-win-package.mjs <win-unpacked-directory>\n' +
        '       node scripts/verify-win-package.mjs --installer <setup.exe>\n' +
        '       node scripts/verify-win-package.mjs --audit <installed-directory>\n',
    );
    process.exitCode = 2;
    return;
  }
  const appDir = mode;
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
