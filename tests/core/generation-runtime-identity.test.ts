/**
 * Old-generation runtime identity migration: an unrecorded identity is refused
 * with an actionable message (not a generic unrecoverable error); after the
 * caller re-verifies the artifacts and records the digests, reuse verifies.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureLayout,
  generationPaths,
  recordGenerationRuntimeIdentity,
  resolveLayout,
  reuseGenerationRuntime,
} from '@hdsl/core';
import { createGenerationRuntimeVerifier, sha256TreeDigestSync } from '@hdsl/runtime';

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
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-runtime-identity-'));
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
  return { layout, paths };
};

describe('generation runtime identity migration', () => {
  it('refuses with an actionable message, then verifies after the identity is recorded', () => {
    const { layout, paths } = build();
    const refused = reuseGenerationRuntime({
      layout,
      environmentId: ENVIRONMENT_ID,
      fromGenerationId: FROM,
      toGenerationId: TO,
      verify: createGenerationRuntimeVerifier(),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('INTERNAL_ERROR');
      expect(refused.message).toContain('not recorded');
      expect(refused.message).toContain('repair');
    }

    const repaired = recordGenerationRuntimeIdentity({
      layout,
      environmentId: ENVIRONMENT_ID,
      generationId: FROM,
      trusted: {
        nodeTreeDigest: sha256TreeDigestSync(paths.nodeDirectory),
        dshTreeDigest: sha256TreeDigestSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')),
      },
      computeNodeTreeDigest: sha256TreeDigestSync,
      computeDshTreeDigest: (dshDirectory) => sha256TreeDigestSync(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')),
    });
    expect(repaired.ok).toBe(true);
    const manifest = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as { node?: { treeDigest?: string } };
    expect(manifest.node?.treeDigest).toHaveLength(64);

    const accepted = reuseGenerationRuntime({
      layout,
      environmentId: ENVIRONMENT_ID,
      fromGenerationId: FROM,
      toGenerationId: TO,
      verify: createGenerationRuntimeVerifier(),
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.identityVerified).toBe(true);
    }
  });

  it('refuses to record a drifted tree from live digests (trusted artifact binding)', () => {
    const { layout, paths } = build();
    const trusted = {
      nodeTreeDigest: sha256TreeDigestSync(paths.nodeDirectory),
      dshTreeDigest: sha256TreeDigestSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')),
    };
    recordGenerationRuntimeIdentity({
      layout,
      environmentId: ENVIRONMENT_ID,
      generationId: FROM,
      trusted,
      computeNodeTreeDigest: sha256TreeDigestSync,
      computeDshTreeDigest: (dshDirectory) => sha256TreeDigestSync(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')),
    });
    // A tampered tree must NOT be recorded: the trusted digest no longer matches.
    writeFileSync(join(paths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\necho tampered\n');
    const refusedRepair = recordGenerationRuntimeIdentity({
      layout,
      environmentId: ENVIRONMENT_ID,
      generationId: FROM,
      trusted,
      computeNodeTreeDigest: sha256TreeDigestSync,
      computeDshTreeDigest: (dshDirectory) => sha256TreeDigestSync(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')),
    });
    expect(refusedRepair.ok).toBe(false);
    const refused = reuseGenerationRuntime({
      layout,
      environmentId: ENVIRONMENT_ID,
      fromGenerationId: FROM,
      toGenerationId: TO,
      verify: createGenerationRuntimeVerifier(),
    });
    expect(refused.ok).toBe(false);
  });
});
