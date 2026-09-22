/**
 * #77 S3: the removal context is derived from the environment's ACTIVE generation
 * only — no parameter accepts a path, so the UI/caller cannot redirect the
 * removal at another generation, home or install tree (ADR 0005 D15/D21).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveRemovalContext, environmentPaths, generationPaths, managedProfileName, resolveLayout, type EnvironmentRecord } from '@hdsl/core';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const environment = (activeGenerationId: string | null): EnvironmentRecord => ({
  schemaVersion: '1', id: 'env-0000000000000001', name: 'S3 env', revision: 3, stateVersion: 2,
  state: 'stopped', activeGenerationId, compositionDigest: activeGenerationId === null ? null : 'a'.repeat(64),
  createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
});

describe('deriveRemovalContext', () => {
  it('derives every path from the active generation (no caller-supplied path)', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-removal-ctx-'));
    roots.push(dataRoot);
    const layout = resolveLayout(dataRoot);
    const environmentId = 'env-0000000000000001';
    const generationId = 'gen-0000000000000001';
    const outcome = deriveRemovalContext({ layout, environment: environment(generationId), stagingKey: 'op-1' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const generation = generationPaths(layout, environmentId, generationId);
    const environmentRoot = environmentPaths(layout, environmentId);
    expect(outcome.value).toMatchObject({
      environmentId,
      generationId,
      declarationDirectory: join(generation.generationDirectory, 'profile'),
      publishedProfileDirectory: join(environmentRoot.profilesDirectory, managedProfileName(generationId)),
      homeDirectory: environmentRoot.homeDirectory,
      dshDirectory: generation.dshDirectory,
      nodeExecutable: join(generation.nodeDirectory, 'bin', 'node'),
      stagingDirectory: join(layout.tmp, 'removal-op-1'),
    });
  });

  it('fails closed without an environment or an active generation', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-removal-ctx-'));
    roots.push(dataRoot);
    const layout = resolveLayout(dataRoot);
    const missing = deriveRemovalContext({ layout, environment: undefined, stagingKey: 'op-2' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND');

    const noGeneration = deriveRemovalContext({ layout, environment: environment(null), stagingKey: 'op-3' });
    expect(noGeneration.ok).toBe(false);
    if (!noGeneration.ok) expect(noGeneration.code).toBe('NOT_FOUND');
  });
});
