/**
 * Structural guard: the credentials slice must never persist or print a secret
 * and must never read the host process environment for credential material.
 *
 * This complements the behavioral tests: it fails if someone later adds a
 * `console.*`, a filesystem write, or an implicit `process.env` inheritance to
 * the adapter. It is a denylist over the source text, not a runtime proof.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECURITY_EXECUTABLE } from '../../packages/runtime/src/credentials/index.js';

const sourceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'runtime',
  'src',
  'credentials',
);

const sourceFiles = readdirSync(sourceRoot)
  .filter((entry) => entry.endsWith('.ts'))
  .map((entry) => join(sourceRoot, entry));

describe('credentials source egress guard', () => {
  it('has source files to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it.each(sourceFiles.map((file) => [file.slice(sourceRoot.length + 1), file] as const))(
    '%s does not log, write files or read the host environment',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\bconsole\s*\./);
      expect(source).not.toMatch(/\bprocess\s*\.\s*env\b/);
      expect(source).not.toMatch(/node:fs|from ['"]fs['"]/);
      expect(source).not.toMatch(/\b(?:writeFile|appendFile|createWriteStream|openSync)\b/);
    },
  );

  it('invokes the absolute macOS security executable', () => {
    expect(SECURITY_EXECUTABLE).toBe('/usr/bin/security');
  });
});
