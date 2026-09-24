/**
 * Packaging contract for the unsigned Windows x64 portable build.
 *
 * The Windows deliverable cannot be executed in CI (no Windows host evidence,
 * no signing), so the only enforceable evidence is the packaging declaration
 * plus the archive-integrity checker. These tests pin the declarations that a
 * silent edit could otherwise weaken:
 *
 * - the app is packaged as an unpacked `dir` target for `win32`/`x64`, not as a
 *   signed installer;
 * - the headless QA entry never ships;
 * - the integrity checker rejects a tree that misses production workspace
 *   modules, the runtime static catalog or the renderer assets, and rejects a
 *   tree that carries sources, maps, logs, credentials or dev dependencies;
 * - the workflow is build-only: it must not run Windows tests and must not hold
 *   release/signing permissions.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTENT_MARKERS,
  DEV_DEPENDENCY_DIRS,
  FORBIDDEN_RULES,
  MIN_INSTALLER_BYTES,
  NSIS_MARKER,
  REQUIRED_FILES,
  auditPackagedTree,
  scanFileContent,
  verifyInstallerFile,
  verifyPackagedTree,
} from '../../apps/desktop/scripts/verify-win-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>;

const readText = (relativePath: string): string =>
  readFileSync(join(root, relativePath), 'utf8');

interface DesktopManifest {
  readonly scripts?: Record<string, string>;
  readonly build?: {
    readonly asar?: boolean;
    readonly files?: readonly string[];
    readonly win?: {
      readonly target?: readonly {
        readonly target?: string;
        readonly arch?: readonly string[];
      }[];
      readonly certificateFile?: string;
      readonly signingHashAlgorithms?: readonly string[];
    };
    readonly nsis?: {
      readonly artifactName?: string;
      readonly oneClick?: boolean;
      readonly perMachine?: boolean;
      readonly allowToChangeInstallationDirectory?: boolean;
      readonly deleteAppDataOnUninstall?: boolean;
      readonly certificateFile?: string;
    };
    readonly extraResources?: readonly {
      readonly from?: string;
      readonly to?: string;
      readonly filter?: readonly string[];
    }[];
  };
  readonly devDependencies?: Record<string, string>;
}

/** A complete tree, as the checker expects to find it after a real package run. */
const completeTree = (): string[] => [...REQUIRED_FILES];

/**
 * Writes a synthetic PE file that mimics an NSIS installer without shipping a
 * multi-megabyte binary fixture. The NSIS marker is what separates a real
 * installer from a renamed `win-unpacked/HDSL.exe`, so the negative controls
 * below exercise exactly that distinction.
 */
const writeSyntheticInstaller = (
  directory: string,
  options: { size?: number; marker?: boolean; mz?: boolean; peOffset?: number } = {},
): string => {
  const size = options.size ?? MIN_INSTALLER_BYTES + 4096;
  const buffer = Buffer.alloc(size, 0);
  if (options.mz ?? true) buffer.write('MZ', 0, 'latin1');
  const peOffset = options.peOffset ?? 0x80;
  buffer.writeUInt32LE(peOffset, 0x3c);
  if (peOffset + 4 <= size) buffer.writeUInt32LE(0x0000_4550, peOffset);
  if ((options.marker ?? true) && 0x1000 + NSIS_MARKER.length <= size) {
    buffer.write(NSIS_MARKER, 0x1000, 'latin1');
  }
  const installerPath = join(directory, 'setup.exe');
  writeFileSync(installerPath, buffer);
  return installerPath;
};

describe('Windows portable packaging declaration', () => {
  const desktop = readJson('apps/desktop/package.json') as DesktopManifest;
  const build = desktop.build ?? {};

  it('declares an unpacked win32/x64 dir target plus the NSIS installer target', () => {
    expect(build.win?.target).toEqual([
      { target: 'dir', arch: ['x64'] },
      { target: 'nsis', arch: ['x64'] },
    ]);
  });

  it('declares no signing identity and ships an inspectable (non-asar) tree', () => {
    // An unsigned portable build is the agreed shape; a signing identity would
    // need a credential decision this repository has not made (ADR 0007).
    expect(build.win?.certificateFile).toBeUndefined();
    expect(build.win?.signingHashAlgorithms).toBeUndefined();
    // `asar: false` keeps the tree inspectable and avoids relying on unverified
    // ESM-in-asar loading for a build that no Windows host has started yet.
    expect(build.asar).toBe(false);
  });

  it('excludes the QA entry and build maps from the packaged files', () => {
    expect(build.files).toContain('dist/**/*');
    expect(build.files).toContain('!dist/main/qa-entry.*');
    expect(build.files).toContain('!dist/**/*.map');
  });

  it('exposes the packaging command through a script', () => {
    expect(desktop.scripts?.['package:win']).toBe('electron-builder --win --x64 --dir');
    expect(desktop.scripts?.['package:win:nsis']).toBe('electron-builder --win nsis --x64');
    expect(readJson('package.json').scripts).toMatchObject({
      'package:win': expect.stringContaining('build:desktop'),
    });
  });

  it('keeps electron-builder pinned exactly', () => {
    expect(desktop.devDependencies?.['electron-builder']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('NSIS installer packaging declaration', () => {
  const desktop = readJson('apps/desktop/package.json') as DesktopManifest;
  const build = desktop.build ?? {};

  it('produces a versioned win-x64 setup artifact name', () => {
    expect(build.nsis?.artifactName).toBe('${productName}-${version}-win-${arch}-setup.${ext}');
  });

  it('uses an assisted, per-user installer that never deletes user data by default', () => {
    expect(build.nsis?.oneClick).toBe(false);
    expect(build.nsis?.perMachine).toBe(false);
    expect(build.nsis?.allowToChangeInstallationDirectory).toBe(true);
    expect(build.nsis?.deleteAppDataOnUninstall).toBe(false);
  });

  it('declares no signing identity for the installer', () => {
    expect(build.win?.certificateFile).toBeUndefined();
    expect(build.win?.signingHashAlgorithms).toBeUndefined();
    expect(build.nsis?.certificateFile).toBeUndefined();
  });
});

describe('extraResources that must reach the packaged app', () => {
  const desktop = readJson('apps/desktop/package.json') as DesktopManifest;
  const extraResources = desktop.build?.extraResources ?? [];

  it('carries the license and third-party notices', () => {
    expect(extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: 'LICENSE.hdsl.txt' }),
        expect.objectContaining({ to: 'THIRD_PARTY_NOTICES.md' }),
      ]),
    );
  });

  it('restores the catalog lock files that electron-builder strips by default', () => {
    // `readDependencyClosure` needs closure.json + package.json +
    // package-lock.json; electron-builder's excludedNames removes every
    // package-lock.json, so it must come back through extraResources.
    expect(extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: '../../packages/runtime/catalog',
          to: 'app/node_modules/@hdsl/runtime/catalog',
          filter: ['dsh-*/package-lock.json'],
        }),
      ]),
    );
  });

  it('requires the license, notices and catalog locks in the packaged tree', () => {
    for (const required of [
      'resources/LICENSE.hdsl.txt',
      'resources/THIRD_PARTY_NOTICES.md',
      'resources/app/node_modules/@hdsl/runtime/catalog/dsh-0.1.5-rc.2/package-lock.json',
      'resources/app/node_modules/@hdsl/runtime/catalog/dsh-0.1.7-rc.1/package-lock.json',
    ]) {
      expect(REQUIRED_FILES).toContain(required);
    }
  });
});

describe('NSIS installer file check', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hdsl-nsis-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('accepts a PE file that carries the NSIS signature', () => {
    expect(verifyInstallerFile(writeSyntheticInstaller(directory))).toEqual([]);
  });

  it('rejects a renamed win-unpacked HDSL.exe (PE without the NSIS signature)', () => {
    const errors = verifyInstallerFile(writeSyntheticInstaller(directory, { marker: false }));
    expect(errors).toEqual([expect.stringContaining(NSIS_MARKER)]);
  });

  it('rejects a file without an MZ header', () => {
    const errors = verifyInstallerFile(writeSyntheticInstaller(directory, { mz: false }));
    expect(errors).toEqual([expect.stringContaining('MZ')]);
  });

  it('rejects a file too small to be an Electron NSIS installer', () => {
    const errors = verifyInstallerFile(
      writeSyntheticInstaller(directory, { size: 128, peOffset: 64, marker: false }),
    );
    expect(errors.some((error) => error.includes('too small'))).toBe(true);
  });

  it('fails closed when the installer is absent', () => {
    expect(verifyInstallerFile(join(directory, 'missing.exe'))).toEqual([
      expect.stringContaining('missing installer file'),
    ]);
  });
});

describe('packaged payload content audit', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hdsl-audit-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('accepts a normal production bundle', () => {
    const file = join(directory, 'app.js');
    writeFileSync(file, 'const apiKey = readSecret(); fetch("http://127.0.0.1:3000");\n');
    expect(scanFileContent(file)).toEqual([]);
  });

  it.each([
    ['HDSL_QA_REAL_INSTALL=1', 'qa-opt-in-env'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['ghp_abcdefghijklmnopqrstuvwx1234567890', 'github-token'],
  ])('flags %s as %s without leaking the matched value', (content, ruleId) => {
    const file = join(directory, 'bundle.js');
    writeFileSync(file, `const value = ${JSON.stringify(content)};\n`);
    const violations = scanFileContent(file);
    expect(violations.map((violation) => violation.id)).toContain(ruleId);
    // Sanitized output: the violation carries the rule id and reason, never the value.
    expect(JSON.stringify(violations)).not.toContain(content);
  });

  it('skips binary files', () => {
    const file = join(directory, 'icon.png');
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x41, 0x4b, 0x49, 0x41]));
    expect(scanFileContent(file)).toEqual([]);
  });

  it('audits a tree and reports file and marker counts', () => {
    writeFileSync(join(directory, 'clean.js'), 'export const x = 1;\n');
    const result = auditPackagedTree(directory);
    expect(result.files).toBeGreaterThan(0);
    expect(result.markerFiles).toBe(0);
    expect(result.errors.some((error) => error.includes('missing required file'))).toBe(true);
  });

  it('documents every content marker', () => {
    for (const marker of CONTENT_MARKERS) {
      expect(marker.why.length).toBeGreaterThan(10);
    }
  });
});

describe('archive integrity checker', () => {
  it('accepts a complete tree', () => {
    expect(verifyPackagedTree(root, { listFiles: completeTree })).toEqual([]);
  });

  it('reports a missing production workspace or catalog file', () => {
    for (const required of [
      'resources/app/node_modules/@hdsl/runtime/dist/index.js',
      'resources/app/node_modules/@hdsl/runtime/catalog/dsh-0.1.5-rc.2/closure.json',
      'resources/app/node_modules/@hdsl/runtime/catalog/dsh-0.1.7-rc.1/package-lock.json',
      'resources/LICENSE.hdsl.txt',
      'resources/app/dist/renderer/app.js',
    ]) {
      const errors = verifyPackagedTree(root, {
        listFiles: () => completeTree().filter((file) => file !== required),
      });
      expect(errors).toContain(`missing required file: ${required}`);
    }
  });

  it.each([
    ['resources/app/dist/main/qa-entry.js', 'qa-entry'],
    ['resources/app/dist/main/index.js.map', 'source-map'],
    ['resources/app/src/main/app.ts', 'app-sources'],
    ['resources/app/pnpm-lock.yaml', 'workspace-manifests'],
    ['resources/app/.git/config', 'git-metadata'],
    ['resources/app/hdsl-diagnostics-2026.json', 'diagnostics'],
    ['resources/app/node_modules/.bin/hdsl.log', 'logs'],
    ['resources/app/home/.credentials.yaml', 'credentials'],
    ['resources/app/node_modules/@hdsl/runtime/pnpm-cache/index.json', 'dev-cache'],
    ['resources/app/node_modules/electron-builder/package.json', 'dev-dependency'],
  ])('rejects %s', (extra, ruleId) => {
    const errors = verifyPackagedTree(root, { listFiles: () => [...completeTree(), extra] });
    expect(errors.some((error) => error.includes(`(${ruleId})`))).toBe(true);
  });

  it('names every dev dependency directory it refuses', () => {
    for (const name of DEV_DEPENDENCY_DIRS) {
      expect(
        verifyPackagedTree(root, {
          listFiles: () => [...completeTree(), `resources/app/node_modules/${name}/package.json`],
        }).some((error) => error.includes('(dev-dependency)')),
      ).toBe(true);
    }
  });

  it('fails closed when the directory is absent', () => {
    expect(verifyPackagedTree(join(root, 'apps/desktop/release/does-not-exist'))).toEqual([
      expect.stringContaining('missing packaged directory'),
    ]);
  });

  it('documents every rule it applies', () => {
    for (const rule of FORBIDDEN_RULES) {
      expect(rule.why.length).toBeGreaterThan(10);
    }
  });
});

describe('Windows portable build workflow', () => {
  const workflow = readText('.github/workflows/windows-portable-build.yml');

  it('runs on a Windows runner as a controlled, build-only job', () => {
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('workflow_dispatch:');
  });

  it('never runs the app or a Windows test', () => {
    expect(workflow).not.toMatch(/pnpm (run )?test\b/);
    expect(workflow).not.toMatch(/vitest/);
    // The only execution of the packaged tree is the file-tree checker.
    expect(workflow).toContain('node apps/desktop/scripts/verify-win-package.mjs');
    expect(workflow).not.toMatch(/win-unpacked\/HDSL\.exe/);
  });

  it('holds no publishing or signing permission', () => {
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toMatch(
      /contents: write|id-token|GH_TOKEN|NPM_TOKEN|softprops\/action-gh-release|gh release/,
    );
  });

  it('uploads the ZIP with its SHA-256 and build provenance', () => {
    expect(workflow).toContain('uses: actions/upload-artifact@v7.0.1');
    expect(workflow).toContain('Get-FileHash -Algorithm SHA256');
    expect(workflow).toContain('SHA256SUMS.txt');
    expect(workflow).toContain('build-info.txt');
  });

  it('names the artifact with version, win-x64 and the exact build SHA', () => {
    expect(workflow).toContain('HDSL-$version-win-x64-$sha-portable.zip');
    expect(workflow).not.toContain('win32-x64');
    expect(workflow).toContain('hdsl-win-x64-portable-${{ github.sha }}');
    // The provenance file carries the full commit, not just the short form.
    expect(workflow).toContain('base-commit: $env:GITHUB_SHA');
    expect(workflow).toContain('release-channel: windows-preview');
  });

  it('checks and archives repository-relative paths', () => {
    // The same command works locally and on the runner, so the recorded
    // evidence stays reproducible from the documented instructions.
    expect(workflow).toContain(
      'apps/desktop/scripts/verify-win-package.mjs apps/desktop/release/win-unpacked',
    );
  });

  it('audits the packaged tree for test, fixture and credential content', () => {
    expect(workflow).toContain(
      'verify-win-package.mjs --audit apps/desktop/release/win-unpacked',
    );
  });
});

describe('Windows NSIS installer job', () => {
  const workflow = readText('.github/workflows/windows-portable-build.yml');

  it('adds a read-only installer job on a Windows runner', () => {
    expect(workflow).toContain('nsis-installer:');
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('permissions:\n  contents: read');
  });

  it('builds through the nsis script and checks the .exe file format', () => {
    expect(workflow).toContain('pnpm --filter @hdsl/desktop run package:win:nsis');
    expect(workflow).toContain('node apps/desktop/scripts/verify-win-package.mjs --installer');
  });

  it('runs silent install, in-place upgrade and uninstall and proves user data survives', () => {
    expect(workflow).toContain("-ArgumentList '/S'");
    expect(workflow).toContain('Uninstall');
    expect(workflow).toContain('hdsl-installer-sentinel.txt');
    expect(workflow).toContain('deleteAppDataOnUninstall');
    expect(workflow).toContain('verify-win-package.mjs $target');
  });

  it('audits the actual installed payload for test and credential content', () => {
    expect(workflow).toContain('verify-win-package.mjs --audit $target');
  });

  it('pins the installer to the exact artifactName instead of the newest .exe', () => {
    expect(workflow).toContain('$expected = "HDSL-$version-win-x64-setup.exe"');
    expect(workflow).toContain('Get-Item -Path "apps/desktop/release/$expected"');
    expect(workflow).not.toContain('Sort-Object LastWriteTime -Descending');
  });

  it('uploads the .exe with its own checksum and provenance files', () => {
    expect(workflow).toContain('name: hdsl-win-x64-installer-${{ github.sha }}');
    expect(workflow).toContain('HDSL-$version-win-x64-$sha-setup.exe');
    expect(workflow).toContain('SHA256SUMS-installer.txt');
    expect(workflow).toContain('build-info-installer.txt');
    expect(workflow).toContain('Get-FileHash -Algorithm SHA256');
  });

  it('never claims Windows GUI evidence', () => {
    expect(workflow).toContain(
      'windows-gui-evidence: none (the installed application was not launched',
    );
  });

  it('holds no publishing or signing permission', () => {
    expect(workflow).not.toMatch(
      /contents: write|id-token|GH_TOKEN|NPM_TOKEN|softprops\/action-gh-release|gh release/,
    );
  });
});
