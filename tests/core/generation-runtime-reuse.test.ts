/**
 * Runtime reuse: independent physical copy (no hardlink inode sharing), source
 * untouched, symlink-escape rejection, and injectable identity verification.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(paths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\necho node\n');
  writeFileSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
  writeFileSync(
    paths.manifestPath,
    JSON.stringify({ schemaVersion: '1', installMode: 'npm-ci', node: { version: '22.19.0' }, dsh: { version: '0.1.5-rc.2' } }),
  );
  return { layout, paths, dataRoot };
};

describe('generation runtime reuse', () => {
  it('copies the runtime into an independent new generation and never mutates the source', () => {
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
    expect(readFileSync(join(target.nodeDirectory, 'bin', 'node'), 'utf8')).toBe('#!/bin/sh\necho node\n');

    // Independence: modifying the new generation must not touch the source.
    writeFileSync(join(target.nodeDirectory, 'bin', 'node'), '#!/bin/sh\necho tampered\n');
    expect(readFileSync(join(paths.nodeDirectory, 'bin', 'node'), 'utf8')).toBe('#!/bin/sh\necho node\n');
    // Structural copy only: no verifier => identityVerified false (not complete).
    expect(outcome.value.identityVerified).toBe(false);
  });

  it('rejects a source tree whose symlink escapes the generation root', () => {
    const { layout, paths, dataRoot } = build();
    symlinkSync(dataRoot, join(paths.dshDirectory, 'escape'));
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

  it('fails closed when the injected identity verifier rejects the copy', () => {
    const { layout } = build();
    const rejected = reuseGenerationRuntime({
      layout,
      environmentId: ENVIRONMENT_ID,
      fromGenerationId: FROM,
      toGenerationId: TO,
      verify: () => false,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe('INTERNAL_ERROR');
    }

    const accepted = reuseGenerationRuntime({
      layout,
      environmentId: ENVIRONMENT_ID,
      fromGenerationId: FROM,
      toGenerationId: 'gen-0000000000000003',
      verify: () => true,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.identityVerified).toBe(true);
    }
  });
});
