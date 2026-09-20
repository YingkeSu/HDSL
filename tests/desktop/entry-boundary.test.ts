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
});
