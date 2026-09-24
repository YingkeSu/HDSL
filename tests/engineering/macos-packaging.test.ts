/**
 * Packaging contract for the macOS ARM64 DMG deliverable.
 *
 * The DMG is an unsigned, un-notarized preview artifact, so the machine-checkable
 * evidence is the packaging declaration, the temp-only mount checker and the
 * release wiring. These tests pin the declarations that a silent edit could
 * otherwise weaken:
 *
 * - the DMG is the primary macOS distribution target for `darwin`/`arm64`,
 *   while the unpacked `dir` target survives for local structure checks;
 * - `package:mac` must not pass `--dir`, which would suppress the DMG target;
 * - no signing identity is configured (ADR 0007: no Developer ID credential);
 * - the mount checker fails closed on a missing app or drag-install link;
 * - the release workflow builds, hashes and uploads the DMG, and the publish
 *   job accepts `.dmg` (and the Windows `.exe`) assets.
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attachArguments, inspectMountedImage } from '../../apps/desktop/scripts/verify-mac-dmg.mjs';
import { inspectMacApp } from '../../apps/desktop/scripts/verify-mac-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as Record<string, unknown>;

const readText = (relativePath: string): string =>
  readFileSync(join(root, relativePath), 'utf8');

interface DesktopManifest {
  readonly scripts?: Record<string, string>;
  readonly build?: {
    readonly mac?: {
      readonly target?: readonly { readonly target?: string; readonly arch?: readonly string[] }[];
      readonly identity?: string | null;
      readonly artifactName?: string;
    };
    readonly dmg?: { readonly sign?: boolean };
    readonly win?: { readonly target?: readonly { readonly target?: string }[] };
  };
}

describe('macOS DMG packaging declaration', () => {
  const desktop = readJson('apps/desktop/package.json') as DesktopManifest;
  const build = desktop.build ?? {};

  it('declares an arm64 dir target plus a dmg target', () => {
    expect(build.mac?.target).toEqual([
      { target: 'dir', arch: ['arm64'] },
      { target: 'dmg', arch: ['arm64'] },
    ]);
  });

  it('stays unsigned: no identity, and DMG signing disabled', () => {
    expect(build.mac?.identity).toBeNull();
    expect(build.dmg?.sign).toBe(false);
  });

  it('names the DMG with product, version, platform and arch', () => {
    expect(build.mac?.artifactName).toBe('HDSL-${version}-mac-${arch}.${ext}');
  });

  it('builds every mac target (no --dir override) through package:mac', () => {
    // `--dir` makes electron-builder build the unpacked directory only, which
    // would silently drop the DMG; the release workflow calls this script.
    expect(desktop.scripts?.['package:mac']).toBe('electron-builder --mac --arm64');
    expect(desktop.scripts?.['package:mac']).not.toContain('--dir');
  });

  it('does not retarget or re-sign the Windows deliverable', () => {
    // Windows packaging is owned by its own change; the mac work must leave the
    // win target declaration untouched.
    expect(build.win?.target).toEqual([{ target: 'dir', arch: ['x64'] }]);
  });
});

describe('macOS app and DMG content checkers', () => {
  it('reports a missing app bundle', () => {
    expect(inspectMacApp(join(root, 'apps/desktop/release/does-not-exist.app'))).toEqual([
      'missing macOS HDSL executable',
    ]);
  });

  it('mounts read-only, without browsing, at the requested mount point', () => {
    const args = attachArguments('/tmp/HDSL-0.1.0-preview.1-mac-arm64.dmg', '/tmp/hdsl-mnt');
    expect(args[0]).toBe('attach');
    expect(args[1]?.endsWith('HDSL-0.1.0-preview.1-mac-arm64.dmg')).toBe(true);
    expect(args).toContain('-readonly');
    expect(args).toContain('-nobrowse');
    expect(args.slice(-2)).toEqual(['-mountpoint', '/tmp/hdsl-mnt']);
  });

  it('fails closed when the mounted image lacks the app or the Applications link', () => {
    const mountPoint = mkdtempSync(join(tmpdir(), 'hdsl-dmg-test-'));
    try {
      expect(inspectMountedImage(mountPoint)).toEqual([
        `missing HDSL.app in mounted image: ${join(mountPoint, 'HDSL.app')}`,
        `missing drag-install link in mounted image: ${join(mountPoint, 'Applications')}`,
      ]);
      symlinkSync('/Applications', join(mountPoint, 'Applications'));
      expect(inspectMountedImage(mountPoint)).toEqual([
        `missing HDSL.app in mounted image: ${join(mountPoint, 'HDSL.app')}`,
      ]);
    } finally {
      rmSync(mountPoint, { recursive: true, force: true });
    }
  });
});

describe('macOS release workflow', () => {
  const workflow = readText('.github/workflows/release.yml');

  it('builds the DMG and verifies it mounts before archiving', () => {
    expect(workflow).toContain('pnpm --filter @hdsl/desktop run package:mac');
    expect(workflow).toContain('node apps/desktop/scripts/verify-mac-package.mjs');
    expect(workflow).toContain('node apps/desktop/scripts/verify-mac-dmg.mjs');
  });

  it('uploads the DMG as the primary asset with checksum and provenance', () => {
    expect(workflow).toContain('apps/desktop/release/*.dmg');
    expect(workflow).toContain('HDSL-$version-mac-arm64.dmg');
    expect(workflow).toContain('primary-format: dmg');
    expect(workflow).toContain('signing: no Developer ID or notarization');
    expect(workflow).toContain('SHA256SUMS-mac.txt');
    expect(workflow).toContain('build-info-mac.txt');
  });

  it('publishes dmg and exe assets, not only zips', () => {
    expect(workflow).toContain('zips=(./*.zip)');
    expect(workflow).toContain('dmgs=(./HDSL-*-mac-arm64.dmg)');
    expect(workflow).toContain('installers=(./HDSL-*-setup.exe)');
    expect(workflow).toContain('assets=("${zips[@]}" "${dmgs[@]}" "${installers[@]}")');
    expect(workflow).not.toContain('gh release create "$GITHUB_REF_NAME" ./*.zip');
  });

  it('fails when an expected asset, checksum or provenance file is missing', () => {
    expect(workflow).toContain('FAIL: missing required release file');
    expect(workflow).toContain('expected at least one *.zip and one HDSL-*-mac-arm64.dmg asset');
    expect(workflow).toContain('setup.exe present but its checksum/provenance file is missing');
  });
});
