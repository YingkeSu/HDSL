/**
 * Mount-and-inspect check for the macOS ARM64 DMG deliverable.
 *
 * This is a **temp-only, read-only** check: the image is attached with
 * `-readonly -nobrowse` to a fresh `mkdtemp` mount point, the app bundle is
 * checked with the same production-content rules as the unpacked build, the
 * drag-to-install `Applications` link is asserted, and the image is detached
 * again. It never starts the packaged app, never touches a real user profile
 * and never falls back to the default mount point under `/Volumes`.
 *
 * Usage: node scripts/verify-mac-dmg.mjs <HDSL-...-mac-arm64.dmg>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectMacApp } from './verify-mac-package.mjs';

/**
 * @param {string} dmg Absolute or relative DMG path.
 * @param {string} mountPoint Existing empty directory to mount at.
 * @returns {string[]} `hdiutil attach` argument vector.
 */
export const attachArguments = (dmg, mountPoint) => [
  'attach',
  resolve(dmg),
  '-readonly',
  '-nobrowse',
  '-noautoopen',
  '-mountpoint',
  resolve(mountPoint),
];

/**
 * Checks a mounted HDSL image.
 *
 * @param {string} mountPoint Directory the image is mounted at.
 * @returns {string[]} One message per problem; empty means the image is usable.
 */
export const inspectMountedImage = (mountPoint) => {
  const errors = [];
  const app = join(mountPoint, 'HDSL.app');
  if (!existsSync(app)) {
    errors.push(`missing HDSL.app in mounted image: ${app}`);
  } else {
    errors.push(...inspectMacApp(app));
  }
  const applications = join(mountPoint, 'Applications');
  // Use lstat: the link target (/Applications) is macOS-only, so existence
  // must be checked on the link itself, not on its target.
  let applicationsStat;
  try {
    applicationsStat = lstatSync(applications);
  } catch {
    applicationsStat = undefined;
  }
  if (applicationsStat === undefined) {
    errors.push(`missing drag-install link in mounted image: ${applications}`);
  } else if (!applicationsStat.isSymbolicLink()) {
    errors.push(`drag-install link is not a symlink: ${applications}`);
  } else if (readlinkSync(applications) !== '/Applications') {
    errors.push(`drag-install link does not point at /Applications: ${applications}`);
  }
  return errors;
};

const detach = (mountPoint) => {
  try {
    execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'inherit' });
    return true;
  } catch {
    try {
      execFileSync('hdiutil', ['detach', '-force', mountPoint], { stdio: 'inherit' });
      return true;
    } catch {
      process.stderr.write(`FAIL: could not detach ${mountPoint}; detach it manually before cleanup\n`);
      return false;
    }
  }
};

const main = () => {
  const dmg = process.argv[2];
  if (dmg === undefined || dmg.trim() === '') {
    process.stderr.write('usage: node scripts/verify-mac-dmg.mjs <HDSL-...-mac-arm64.dmg>\n');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(dmg)) {
    process.stderr.write(`missing DMG: ${dmg}\n`);
    process.exitCode = 2;
    return;
  }
  const mountPoint = mkdtempSync(join(tmpdir(), 'hdsl-dmg-'));
  let attached = false;
  let detachFailed = false;
  let errors = [];
  try {
    execFileSync('hdiutil', attachArguments(dmg, mountPoint), { stdio: 'inherit' });
    attached = true;
    errors = inspectMountedImage(mountPoint);
  } finally {
    if (attached) {
      const detached = detach(mountPoint);
      if (detached) rmSync(mountPoint, { recursive: true, force: true });
      else detachFailed = true;
    } else {
      rmSync(mountPoint, { recursive: true, force: true });
    }
  }
  if (detachFailed) {
    // A leaked mount is a failed check, not a warning.
    process.stderr.write(`FAIL: image stayed mounted at ${mountPoint}\n`);
    process.exitCode = 1;
    return;
  }
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    'PASS: DMG mounts read-only in a temp directory, contains a complete HDSL.app with an Applications link, and detaches cleanly.\n',
  );
  process.stdout.write('Scope: image integrity and layout only; the packaged app was not executed.\n');
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
