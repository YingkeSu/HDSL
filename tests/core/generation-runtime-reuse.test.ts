/** Runtime reuse for a new plugin generation: hardlinks, source untouched. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLayout, generationPaths, resolveLayout, reuseGenerationRuntime } from '@hdsl/core';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const FROM = 'gen-0000000000000001';
const TO = 'gen-0000000000000002';

const build = () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-runtime-reuse-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const paths = generationPaths(layout, ENVIRONMENT_ID, FROM);
  mkdirSync(join(paths.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(paths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
  writeFileSync(paths.manifestPath, JSON.stringify({ installMode: 'npm-ci' }));
  return { layout, paths };
};

describe('generation runtime reuse', () => {
  it('reuses node/dsh/manifest via hardlinks without modifying the source generation', () => {
    const { layout, paths } = build();
    const outcome = reuseGenerationRuntime({
      layout,
      environmentId: ENVIRONMENT_ID,
      fromGenerationId: FROM,
      toGenerationId: TO,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const target = generationPaths(layout, ENVIRONMENT_ID, TO);
    expect(existsSync(join(target.nodeDirectory, 'bin', 'node'))).toBe(true);
    expect(existsSync(join(target.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'))).toBe(true);
    expect(existsSync(target.manifestPath)).toBe(true);
    // Hardlink proof: the reused file shares an inode with the source.
    expect(statSync(join(target.nodeDirectory, 'bin', 'node')).ino).toBe(
      statSync(join(paths.nodeDirectory, 'bin', 'node')).ino,
    );
    // The source generation is untouched.
    expect(existsSync(join(paths.nodeDirectory, 'bin', 'node'))).toBe(true);
    expect(existsSync(paths.manifestPath)).toBe(true);
  });

  it('fails closed when the source generation has no managed install manifest', () => {
    const { layout, paths } = build();
    rmSync(paths.manifestPath);
    const outcome = reuseGenerationRuntime({
      layout,
      environmentId: ENVIRONMENT_ID,
      fromGenerationId: FROM,
      toGenerationId: TO,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
    }
  });
});
