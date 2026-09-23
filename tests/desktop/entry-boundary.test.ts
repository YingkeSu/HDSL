/**
 * Production vs test entry boundary (T006 / issue #6, security P2-2).
 *
 * The production entry must not read the diagnostic-export or credential-import
 * hooks. Injection lives only in the explicitly launched test entry
 * (`qa-entry.ts`), which is not the package `main` and is excluded from the
 * published `files` set.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf8');

const HOOK_NAMES = [
  'HDSL_DIAGNOSTICS_EXPORT_PATH',
  'HDSL_CREDENTIAL_IMPORT_PATH',
  'HDSL_CREDENTIAL_IMPORT_ENVIRONMENT',
  'HDSL_QA_',
  '--hdsl-qa-',
];

describe('production entry has no test hooks', () => {
  it.each(['apps/desktop/src/main/index.ts', 'apps/desktop/src/main/app.ts'])(
    '%s contains none of the hook names',
    (file) => {
      const text = source(file);
      for (const hook of HOOK_NAMES) {
        expect(text, `${file} must not reference ${hook}`).not.toContain(hook);
      }
    },
  );

  it('keeps the QA injection in the separate test entry only', () => {
    const qaEntry = source('apps/desktop/src/main/qa-entry.ts');
    expect(qaEntry).toContain('--hdsl-qa-export-path');
    expect(qaEntry).toContain('--hdsl-qa-import-path');
    expect(qaEntry).toContain('--hdsl-qa-import-environment');
    expect(qaEntry).not.toContain("from './index.js'");
    const pkg = JSON.parse(source('apps/desktop/package.json')) as {
      main?: string;
      files?: string[];
    };
    expect(pkg.main).toBe('./dist/main/index.js');
    expect(pkg.files?.some((entry) => entry.includes('qa-entry'))).toBe(true);
  });

  it('checks the exclusive data-root lease before creating any window or IPC host', () => {
    // #6 supplement acceptance: the single-instance/dataRoot-exclusive gate must
    // be in effect *before* any UI operation. `bootstrap` must therefore inspect
    // `created.available` (which reflects the awaited `service.open()` lease)
    // before it constructs the IPC host or loads the launcher window, and the
    // refused branch must exit without creating a window.
    const app = source('apps/desktop/src/main/app.ts');
    const start = app.indexOf('const bootstrap = async');
    const end = app.indexOf('const focusMainWindow');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const bootstrap = app.slice(start, end);
    const leaseGate = bootstrap.indexOf('if (!created.available)');
    const ipcHost = bootstrap.indexOf('ipcHost = new DesktopIpcHost');
    const window = bootstrap.indexOf('await createLauncherWindow()');
    expect(leaseGate).toBeGreaterThanOrEqual(0);
    expect(ipcHost).toBeGreaterThan(leaseGate);
    expect(window).toBeGreaterThan(leaseGate);
    const refusal = bootstrap.slice(leaseGate, ipcHost);
    expect(refusal).toContain('app.exit(1)');
    expect(refusal).not.toContain('createLauncherWindow');
    expect(refusal).not.toContain('new BrowserWindow');
  });

  it('writes the data-root-unavailable signal before the modal and exits non-zero', () => {
    const app = source('apps/desktop/src/main/app.ts');
    const signalIndex = app.indexOf('formatDataRootUnavailableSignal');
    const dialogIndex = app.indexOf("'数据目录被占用'");
    expect(signalIndex).toBeGreaterThanOrEqual(0);
    expect(dialogIndex).toBeGreaterThan(signalIndex);
    expect(app).toContain('app.exit(1)');
    // The signal module is pure: no environment or filesystem access.
    const signals = source('apps/desktop/src/main/app-signals.ts');
    expect(signals).not.toContain('process.env');
    expect(signals).not.toContain('node:fs');
  });
});
