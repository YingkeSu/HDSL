/** Inspect macOS app contents using the same production-content rules as Windows. */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPackagedTree } from './verify-win-package.mjs';

const app = process.argv[2];
if (!app || !existsSync(join(app, 'Contents/MacOS/HDSL'))) {
  throw new Error('missing macOS HDSL executable');
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
const errors = verifyPackagedTree(app, { listFiles: () => files });
if (errors.length) throw new Error(errors.join('\n'));
console.log('PASS: macOS executable, production modules, catalog and renderer present; no forbidden content.');
