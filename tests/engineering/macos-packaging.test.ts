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
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  // Layout is a structural check: the link is judged on itself, so it holds on
  // every host. Whether a real image actually mounts is covered only by the
  // macOS workflow run and the local `verify-mac-dmg.mjs` evidence, never by
  // this simulation.
  it('fails closed when the mounted image lacks the app and the Applications link', () => {
    const mountPoint = mkdtempSync(join(tmpdir(), 'hdsl-dmg-test-'));
    try {
      expect(inspectMountedImage(mountPoint)).toEqual([
        `missing HDSL.app in mounted image: ${join(mountPoint, 'HDSL.app')}`,
        `missing drag-install link in mounted image: ${join(mountPoint, 'Applications')}`,
      ]);
    } finally {
      rmSync(mountPoint, { recursive: true, force: true });
    }
  });

  it('accepts a correct Applications link, whether or not its target exists here', () => {
    // The target is '/Applications' by contract. On a Linux runner that path
    // does not exist, so this is simultaneously the dangling-but-correct case;
    // lstat must not follow the link to judge presence.
    const mountPoint = mkdtempSync(join(tmpdir(), 'hdsl-dmg-test-'));
    try {
      symlinkSync('/Applications', join(mountPoint, 'Applications'));
      expect(inspectMountedImage(mountPoint)).toEqual([
        `missing HDSL.app in mounted image: ${join(mountPoint, 'HDSL.app')}`,
      ]);
    } finally {
      rmSync(mountPoint, { recursive: true, force: true });
    }
  });

  it('rejects a link that points somewhere else', () => {
    const mountPoint = mkdtempSync(join(tmpdir(), 'hdsl-dmg-test-'));
    try {
      symlinkSync('/tmp/somewhere-else', join(mountPoint, 'Applications'));
      expect(inspectMountedImage(mountPoint)).toContain(
        `drag-install link does not point at /Applications: ${join(mountPoint, 'Applications')}`,
      );
    } finally {
      rmSync(mountPoint, { recursive: true, force: true });
    }
  });

  it('rejects a regular file named Applications', () => {
    const mountPoint = mkdtempSync(join(tmpdir(), 'hdsl-dmg-test-'));
    try {
      writeFileSync(join(mountPoint, 'Applications'), '');
      expect(inspectMountedImage(mountPoint)).toContain(
        `drag-install link is not a symlink: ${join(mountPoint, 'Applications')}`,
      );
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
    expect(workflow).toContain('installers=(./HDSL-*-win-x64-*-setup.exe)');
    expect(workflow).toContain('assets=("${zips[@]}" "${dmgs[@]}" "${installers[@]}")');
    expect(workflow).not.toContain('gh release create "$GITHUB_REF_NAME" ./*.zip');
  });

  it('uploads the installer checksum as its own asset', () => {
    expect(workflow).toContain(
      'SHA256SUMS.txt SHA256SUMS-installer.txt build-info-*.txt',
    );
  });

  it('fails before publishing when a platform artifact, checksum or provenance file is missing', () => {
    expect(workflow).toContain('for required in SHA256SUMS.txt SHA256SUMS-mac.txt SHA256SUMS-installer.txt');
    expect(workflow).toContain('missing or empty required release file');
    expect(workflow).toContain('expected at least one *.zip, one HDSL-*-mac-arm64.dmg and one HDSL-*-win-x64-*-setup.exe');
    expect(workflow).toContain('sha256sum -c "$sums"');
  });

  it('does not accept a merely conditional installer check', () => {
    expect(workflow).not.toContain('setup.exe present but');
    expect(workflow).not.toContain('may not exist yet');
  });
});
