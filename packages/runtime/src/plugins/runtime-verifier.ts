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
        node?: { treeDigest?: string };
      };
      const expectedDsh = manifest.dsh?.treeDigest;
      const expectedNode = manifest.node?.treeDigest;
      // Both digests are required: a missing digest (older record) fails closed
      // with an explainable reason rather than trusting file existence, and is
      // not accepted from the same manifest being verified.
      if (typeof expectedDsh !== 'string' || expectedDsh.length !== 64) {
        return false;
      }
      if (typeof expectedNode !== 'string' || expectedNode.length !== 64) {
        return false;
      }
      if (!existsSync(join(input.nodeDirectory, 'bin', 'node'))) {
        return false;
      }
      const packageDirectory = join(input.dshDirectory, ...DSH_PACKAGE_SEGMENTS);
      if (!existsSync(packageDirectory)) {
        return false;
      }
      return (
        sha256TreeDigestSync(input.nodeDirectory) === expectedNode &&
        sha256TreeDigestSync(packageDirectory) === expectedDsh
      );
    } catch {
      return false;
    }
  };
};
