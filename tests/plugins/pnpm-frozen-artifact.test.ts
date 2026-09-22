/**
 * Opt-in regression for the frozen managed pnpm artifact (E1).
 *
 * Default CI is offline: the test is skipped unless HDSL_PNPM_ARTIFACT points at
 * a local copy of the pinned tarball. When it runs, it re-verifies the artifact
 * against PNPM_EXECUTOR_SPEC using the PRODUCTION extractor and the executor's
 * own `executorTreeDigest` (never an ad-hoc scheme), so a wrong pinned digest is
 * caught at build time instead of failing every real apply.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNPM_EXECUTOR_SPEC, executorTreeDigest } from '@hdsl/runtime';
import { extractTarGz } from '../../packages/runtime/src/install/tar.js';

const artifact = process.env['HDSL_PNPM_ARTIFACT'];

describe.skipIf(artifact === undefined)('frozen managed pnpm artifact (opt-in)', () => {
  it('matches every pinned digest with the production extractor and tree digest', async () => {
    const path = artifact as string;
    expect(existsSync(path)).toBe(true);
    const bytes = readFileSync(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sha512 = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    expect(sha512).toBe(PNPM_EXECUTOR_SPEC.sha512);
    expect(sha256).toBe(PNPM_EXECUTOR_SPEC.sha256);

    const work = mkdtempSync(join(tmpdir(), 'hdsl-pnpm-artifact-'));
    try {
      await extractTarGz(path, work, { stripComponents: 1 });
      const entry = join(work, 'bin', 'pnpm.mjs');
      expect(existsSync(entry)).toBe(true);
      expect(createHash('sha256').update(readFileSync(entry)).digest('hex')).toBe(PNPM_EXECUTOR_SPEC.entrySha256);
      expect(executorTreeDigest(work)).toBe(PNPM_EXECUTOR_SPEC.treeSha256);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
