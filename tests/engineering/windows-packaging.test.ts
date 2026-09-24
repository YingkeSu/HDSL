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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEV_DEPENDENCY_DIRS,
  FORBIDDEN_RULES,
  REQUIRED_FILES,
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
  };
  readonly devDependencies?: Record<string, string>;
}

/** A complete tree, as the checker expects to find it after a real package run. */
const completeTree = (): string[] => [...REQUIRED_FILES];

describe('Windows portable packaging declaration', () => {
  const desktop = readJson('apps/desktop/package.json') as DesktopManifest;
  const build = desktop.build ?? {};

  it('declares an unpacked win32/x64 dir target', () => {
    expect(build.win?.target).toEqual([{ target: 'dir', arch: ['x64'] }]);
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
    expect(readJson('package.json').scripts).toMatchObject({
      'package:win': expect.stringContaining('build:desktop'),
    });
  });

  it('keeps electron-builder pinned exactly', () => {
    expect(desktop.devDependencies?.['electron-builder']).toMatch(/^\d+\.\d+\.\d+$/);
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
    expect(workflow).toContain('uses: actions/upload-artifact@v4');
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
});
