/** Real generation-runtime verifier: binds both the Node tree and the DSH tree. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGenerationRuntimeVerifier } from '@hdsl/runtime';
import { sha256TreeDigestSync } from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const build = () => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-verifier-'));
  roots.push(root);
  const nodeDirectory = join(root, 'node');
  const dshDirectory = join(root, 'dsh');
  mkdirSync(join(nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(nodeDirectory, 'bin', 'node'), '#!/bin/sh\necho node\n');
  writeFileSync(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
  const manifestPath = join(root, 'install-manifest.json');
  const writeManifest = (): void => {
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: '1',
        installMode: 'npm-ci',
        node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(nodeDirectory) },
        dsh: { version: '0.1.5-rc.2', treeDigest: sha256TreeDigestSync(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')) },
      }),
    );
  };
  writeManifest();
  return { nodeDirectory, dshDirectory, manifestPath, writeManifest };
};

describe('generation runtime verifier', () => {
  it('accepts a runtime whose Node and DSH trees match their recorded digests', () => {
    const { nodeDirectory, dshDirectory, manifestPath } = build();
    const verify = createGenerationRuntimeVerifier();
    expect(verify({ manifestPath, nodeDirectory, dshDirectory })).toBe(true);
  });

  it('blocks a tampered Node binary even when the DSH tree is unchanged', () => {
    const { nodeDirectory, dshDirectory, manifestPath } = build();
    const verify = createGenerationRuntimeVerifier();
    expect(verify({ manifestPath, nodeDirectory, dshDirectory })).toBe(true);
    writeFileSync(join(nodeDirectory, 'bin', 'node'), '#!/bin/sh\necho tampered\n');
    expect(verify({ manifestPath, nodeDirectory, dshDirectory })).toBe(false);
  });

  it('fails closed when the manifest does not record the Node tree digest', () => {
    const { nodeDirectory, dshDirectory, manifestPath } = build();
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: '1',
        installMode: 'npm-ci',
        node: { version: '22.19.0' },
        dsh: { version: '0.1.5-rc.2', treeDigest: sha256TreeDigestSync(join(dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')) },
      }),
    );
    expect(createGenerationRuntimeVerifier()({ manifestPath, nodeDirectory, dshDirectory })).toBe(false);
  });
});
