/** Inspect macOS app contents using the same production-content rules as Windows. */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyPackagedTree } from './verify-win-package.mjs';

/**
 * Checks one unpacked `HDSL.app` bundle.
 *
 * @param {string} app Path to `HDSL.app`.
 * @returns {string[]} One message per problem; empty means the bundle is complete.
 */
export const inspectMacApp = (app) => {
  if (app === undefined || app.trim() === '' || !existsSync(join(app, 'Contents/MacOS/HDSL'))) {
    return ['missing macOS HDSL executable'];
  }
  const files = ['HDSL.exe']; // Normalize executable name for the shared required-file list.
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), name);
      else if (entry.isFile()) files.push(name);
    }
  };
  walk(join(app, 'Contents/Resources'), 'resources');
  return verifyPackagedTree(app, { listFiles: () => files });
};

/**
 * @param {string} app Path to `HDSL.app`.
 * @throws {Error} When the bundle is missing or carries forbidden content.
 */
export const verifyMacApp = (app) => {
  const errors = inspectMacApp(app);
  if (errors.length) throw new Error(errors.join('\n'));
};

const main = () => {
  const app = process.argv[2];
  if (app === undefined || app.trim() === '') {
    process.stderr.write('usage: node scripts/verify-mac-package.mjs <HDSL.app>\n');
    process.exitCode = 2;
    return;
  }
  const errors = inspectMacApp(app);
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    'PASS: macOS executable, production modules, catalog and renderer present; no forbidden content.\n',
  );
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
