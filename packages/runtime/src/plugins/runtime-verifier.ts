/**
 * Real generation-runtime verifier (ADR 0005 D8/D14, ADR 0006 D-B).
 *
 * Reuses the managed-install tree-digest mechanism: the copied generation's DSH
 * package tree must hash to the `treeDigest` recorded in its install manifest.
 * A mismatch (tampered, partial or relocated install) fails closed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256TreeDigestSync } from '../install/hash.js';

export interface GenerationRuntimeVerifierInput {
  readonly manifestPath: string;
  readonly nodeDirectory: string;
  readonly dshDirectory: string;
}

const DSH_PACKAGE_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh'] as const;

export const createGenerationRuntimeVerifier = (): ((input: GenerationRuntimeVerifierInput) => boolean) => {
  return (input) => {
    try {
      const manifest = JSON.parse(readFileSync(input.manifestPath, 'utf8')) as {
        dsh?: { treeDigest?: string };
        node?: { version?: string };
      };
      const expected = manifest.dsh?.treeDigest;
      if (typeof expected !== 'string' || expected.length !== 64) {
        return false;
      }
      if (!existsSync(join(input.nodeDirectory, 'bin', 'node'))) {
        return false;
      }
      const packageDirectory = join(input.dshDirectory, ...DSH_PACKAGE_SEGMENTS);
      if (!existsSync(packageDirectory)) {
        return false;
      }
      return sha256TreeDigestSync(packageDirectory) === expected;
    } catch {
      return false;
    }
  };
};
