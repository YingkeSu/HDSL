/**
 * Builds the browser bundle for the React renderer (T006 / issue #6).
 *
 * `tsc -b` emits the typed ESM modules; this step bundles the renderer entry and
 * copies the static shell so Electron can `loadFile` a self-contained document.
 * It resolves `@hdsl/contracts` through the workspace link to the package's
 * built `dist` entry, so main and the renderer consume the same frozen build.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const source = join(appRoot, 'src', 'renderer');
const output = join(appRoot, 'dist', 'renderer');

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

await build({
  entryPoints: [join(source, 'browser-entry.ts')],
  outfile: join(output, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

cpSync(join(source, 'index.html'), join(output, 'index.html'));
cpSync(join(source, 'styles.css'), join(output, 'styles.css'));

console.log(`renderer bundle written to ${output}`);
