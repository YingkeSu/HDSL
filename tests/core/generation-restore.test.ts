/**
 * generations.restore (ADR 0005 D4/D10): pointer-only restore from the recorded
 * generation identity and the immutable declaration source. Shared home/data are
 * preserved, retained generations are never deleted, and no live identity is
 * rebuilt.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangeApplyService,
  ChangePlanStore,
  EnvironmentStore,
  OperationStore,
  ensureLayout,
  generationPaths,
  resolveLayout,
  type EnvironmentRecord,
} from '@hdsl/core';
import { createGenerationRuntimeVerifier, sha256TreeDigestSync } from '@hdsl/runtime';
import type { CompositionLock, GenerationSummary } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const GEN1 = 'gen-0000000000000001';
const GEN2 = 'gen-0000000000000002';

const lock = (): CompositionLock => ({
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [],
  sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } },
});

const writeGeneration = (layout: ReturnType<typeof resolveLayout>, generationId: string, digest: string): void => {
  const paths = generationPaths(layout, ENVIRONMENT_ID, generationId);
  mkdirSync(join(paths.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(paths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), `// ${generationId}\n`);
  writeFileSync(paths.manifestPath, JSON.stringify({
    schemaVersion: '1', installMode: 'npm-ci',
    node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(paths.nodeDirectory) },
    dsh: { version: '0.1.5-rc.2', treeDigest: sha256TreeDigestSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')) },
  }));
  writeFileSync(paths.lockPath, JSON.stringify(lock()));
  writeFileSync(paths.generationRecordPath, JSON.stringify({ id: generationId, environmentId: ENVIRONMENT_ID, compositionDigest: digest, createdAt: '2026-09-22T00:00:00.000Z', profileName: `hdsl-${generationId}` }));
  const profile = join(paths.generationDirectory, 'profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['b'] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
};

const build = (state: EnvironmentRecord['state'] = 'stopped') => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-restore-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  const now = '2026-09-22T00:05:00.000Z';
  environments.write({ schemaVersion: '1', id: ENVIRONMENT_ID, name: 'restore-env', revision: 2, stateVersion: 2, state, activeGenerationId: GEN2, compositionDigest: '2'.repeat(64), createdAt: now, updatedAt: now });
  writeGeneration(layout, GEN1, '1'.repeat(64));
  writeGeneration(layout, GEN2, '2'.repeat(64));
  // Shared environment home/data that must survive a restore.
  mkdirSync(join(layout.environments, ENVIRONMENT_ID, 'home', 'sessions'), { recursive: true });
  writeFileSync(join(layout.environments, ENVIRONMENT_ID, 'home', 'sessions', 's.json'), '{"session":1}');
  const service = new ChangeApplyService({
    layout, plans: new ChangePlanStore(layout), environments, operations: new OperationStore(layout),
    compositionDigest: (l) => JSON.stringify(l.plugins),
    verifyGenerationRuntime: createGenerationRuntimeVerifier(),
    now: () => new Date(now),
  });
  return { dataRoot, layout, environments, operations: new OperationStore(layout), service, paths2: generationPaths(layout, ENVIRONMENT_ID, GEN2) };
};

const command = (overrides: Partial<{ environmentId: string; expectedRevision: number; targetGenerationId: string }> = {}) => ({
  requestId: 'req-restore',
  environmentId: ENVIRONMENT_ID,
  expectedRevision: 2,
  targetGenerationId: GEN1,
  ...overrides,
});

describe('generations.restore', () => {
  it('restores the previous generation pointer, preserving shared data and retained generations', () => {
    const { layout, environments, operations, service } = build();
    const outcome = service.restoreGeneration(command());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const operation = operations.read(outcome.value.operationId);
    expect(operation?.status).toBe('succeeded');
    expect((operation?.output as GenerationSummary).generationId).toBe(GEN1);
    const environment = environments.read(ENVIRONMENT_ID)!;
    expect(environment.activeGenerationId).toBe(GEN1);
    expect(environment.revision).toBe(3);
    expect(environment.compositionDigest).toBe('1'.repeat(64));
    // Retained generation directory is untouched, shared home/data preserved.
    expect(existsSync(generationPaths(layout, ENVIRONMENT_ID, GEN2).generationDirectory)).toBe(true);
    expect(readFileSync(join(layout.environments, ENVIRONMENT_ID, 'home', 'sessions', 's.json'), 'utf8')).toBe('{"session":1}');
  });

  it('rejects unknown environments/targets, revision conflicts and a running environment', () => {
    const missingEnv = build();
    const unknownEnv = missingEnv.service.restoreGeneration(command({ environmentId: 'env-ffffffffffffffff' }));
    expect(unknownEnv.ok).toBe(false);
    if (!unknownEnv.ok) expect(unknownEnv.code).toBe('NOT_FOUND');

    const unknownTarget = build().service.restoreGeneration(command({ targetGenerationId: 'gen-ffffffffffffffff' }));
    expect(unknownTarget.ok).toBe(false);
    if (!unknownTarget.ok) expect(unknownTarget.code).toBe('NOT_FOUND');

    const conflict = build().service.restoreGeneration(command({ expectedRevision: 99 }));
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('REVISION_CONFLICT');

    const busy = build('running').service.restoreGeneration(command());
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.code).toBe('ENVIRONMENT_BUSY');
  });

  it('fails closed and keeps the current generation when the target runtime identity is tampered', () => {
    const { layout, environments, service } = build();
    const target = generationPaths(layout, ENVIRONMENT_ID, GEN1);
    writeFileSync(join(target.nodeDirectory, 'bin', 'node'), '#!/bin/sh\necho tampered\n');
    const outcome = service.restoreGeneration(command());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
    }
    expect(environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(GEN2);
    expect(environments.read(ENVIRONMENT_ID)?.revision).toBe(2);
  });
});
