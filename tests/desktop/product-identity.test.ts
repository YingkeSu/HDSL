/**
 * Product metadata and About dialog wiring (issue #149).
 *
 * The packaged app exposed the scoped npm name `@hdsl/desktop` as the
 * application name and a truncated `0.1.0.0` version in the About dialog. These
 * checks pin the two declated sources of that behavior:
 * - `apps/desktop/package.json` must declare a `productName` (Electron's
 *   `app.getName()` source) and an `author.name` (electron-builder's Windows
 *   `CompanyName` source), and both must agree with the runtime constants;
 * - the production bootstrap must set the app name and pass the full semantic
 *   version to the About panel before the single-instance lock can show any UI.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  aboutPanelContent,
  LEGACY_PRODUCT_NAME,
  PRODUCT_NAME,
} from '../../apps/desktop/src/main/product-identity.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readText = (relativePath: string): string =>
  readFileSync(join(root, relativePath), 'utf8');
const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readText(relativePath)) as Record<string, unknown>;

interface DesktopManifest {
  readonly name?: string;
  readonly productName?: string;
  readonly version?: string;
  readonly author?: { readonly name?: string };
  readonly build?: {
    readonly productName?: string;
    readonly copyright?: string;
    readonly extraMetadata?: { readonly author?: { readonly name?: string } };
  };
}

describe('desktop product metadata (issue #149)', () => {
  const desktop = readJson('apps/desktop/package.json') as DesktopManifest;
  const rootManifest = readJson('package.json') as DesktopManifest;

  it('declares the product name Electron reads for app.getName()', () => {
    // Without a top-level `productName`, Electron falls back to the npm name
    // and reports `@hdsl/desktop`; electron-builder preserves this field in
    // `resources/app/package.json` (only `build`, `scripts`, `devDependencies`
    // and friends are stripped).
    expect(desktop.productName).toBe(PRODUCT_NAME);
    expect(desktop.build?.productName).toBe(PRODUCT_NAME);
    // The npm package name stays scoped; only the display product name changes.
    expect(desktop.name).toBe(LEGACY_PRODUCT_NAME);
  });

  it('clears the Windows CompanyName instead of declaring a company', () => {
    // electron-builder writes `appInfo.companyName` (`metadata.author.name`) as
    // the Windows `CompanyName`, and when it is absent the executable keeps
    // Electron's `GitHub, Inc.` default. A top-level `author: { name: '' }`
    // cannot clear it: `normalizePackageData` round-trips people through
    // `unParsePerson`/`parsePerson` and drops the empty name, so `companyName`
    // becomes `undefined` and the field is left untouched. `extraMetadata` is
    // deep-assigned *after* normalization, so this is the declaration that
    // actually reaches the executable's version resource as an empty
    // `CompanyName` (confirmed against a real `win-unpacked/HDSL.exe`).
    expect(desktop.author).toBeUndefined();
    expect(desktop.build?.extraMetadata?.author?.name).toBe('');
  });

  it('pins the copyright instead of deriving it from the build year', () => {
    expect(desktop.build?.copyright).toBe('Copyright © 2026 HDSL');
  });

  it('keeps the desktop version equal to the workspace version', () => {
    expect(desktop.version).toBe(rootManifest.version);
  });
});

describe('About panel content (issue #149)', () => {
  it('reports the product name with the full semantic version', () => {
    expect(aboutPanelContent('0.1.0-preview.1')).toEqual({
      applicationName: PRODUCT_NAME,
      applicationVersion: '0.1.0-preview.1',
    });
  });

  it('never reports the numeric Windows resource form as the app version', () => {
    // The Windows version resource truncates the prerelease to `0.1.0.0`; the
    // About panel must show what `app.getVersion()` returns, not that value.
    expect(aboutPanelContent('0.1.0-preview.1').applicationVersion).not.toBe('0.1.0.0');
  });
});

describe('production bootstrap applies the product identity (issue #149)', () => {
  const app = readText('apps/desktop/src/main/app.ts');

  it('sets the application name from the shared constant', () => {
    expect(app).toContain('app.setName(PRODUCT_NAME)');
  });

  it('gives the About dialog the running application version', () => {
    expect(app).toContain('app.setAboutPanelOptions(aboutPanelContent(app.getVersion()))');
  });

  it('settles the identity before the single-instance lock', () => {
    // The lock is the first side effect that uses the (possibly migrated)
    // userData directory and the first place a native dialog could appear.
    const identity = app.indexOf('app.setName(PRODUCT_NAME)');
    const about = app.indexOf('app.setAboutPanelOptions');
    const userData = app.indexOf('resolveUserDataDirectory({');
    const lock = app.indexOf('app.requestSingleInstanceLock()');
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(about).toBeGreaterThan(identity);
    expect(userData).toBeGreaterThan(about);
    expect(lock).toBeGreaterThan(userData);
  });
});
