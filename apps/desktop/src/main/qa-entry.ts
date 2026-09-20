/**
 * TEST-ONLY Electron entry (T006 / issue #6).
 *
 * This file is **not** the package `main` and is never used by a user build.
 * It exists so headless QA can inject explicit dependencies (a fixed export
 * path, a fixed import path and an optional silent startup import) without
 * making the production entry read any environment switch. Because the
 * injection is a separate, explicitly launched entry, there is no
 * `NODE_ENV`/env gate in the production code to bypass.
 *
 * Usage:
 *   electron apps/desktop/dist/main/qa-entry.js \
 *     --hdsl-data-root <dir> --user-data-dir <dir> \
 *     [--hdsl-qa-export-path <file>] \
 *     [--hdsl-qa-import-path <file>] [--hdsl-qa-import-environment <envId>]
 */
import { startDesktopApp, type DesktopAppOptions } from './app.js';

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value === undefined || value === '' ? undefined : value;
};

const exportPath = flagValue('--hdsl-qa-export-path');
const importPath = flagValue('--hdsl-qa-import-path');
const importEnvironment = flagValue('--hdsl-qa-import-environment');

const options: DesktopAppOptions = {
  ...(exportPath === undefined
    ? {}
    : { pathChooser: { chooseExportPath: () => exportPath } }),
  ...(importPath === undefined ? {} : { importPathProvider: () => importPath }),
  ...(importPath === undefined || importEnvironment === undefined
    ? {}
    : { startupImport: { environmentId: importEnvironment, filePath: importPath } }),
};

startDesktopApp(options);
