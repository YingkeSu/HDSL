/**
 * Generation runtime identity recording + migration (ADR 0005 D8/D14).
 *
 * New installs record the Node and DSH tree digests in the install manifest. A
 * generation created before that field existed cannot be verified for reuse and
 * is refused with an actionable, non-destructive message (normal start is
 * unaffected). This module provides the controlled repair: after the caller
 * re-verifies the installed artifacts through the managed-install chain, the
 * digests are computed from the current tree and written into the manifest. The
 * digests are supplied by the caller's trusted computation, never taken from the
 * manifest being repaired.
 */
import { readFileSync } from 'node:fs';
import { isPlainRecord, portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import { writeJsonAtomic } from './fsx.js';
import { generationPaths, type AppDataLayout } from './layout.js';

export interface GenerationRuntimeIdentity {
  readonly nodeTreeDigest: string | null;
  readonly dshTreeDigest: string | null;
}

export interface RecordRuntimeIdentityOptions {
  readonly layout: AppDataLayout;
  readonly environmentId: string;
  readonly generationId: string;
  /** Trusted computation over the installed Node tree (e.g. after artifact re-verification). */
  readonly computeNodeTreeDigest: (nodeDirectory: string) => string;
  /** Trusted computation over the installed DSH package tree. */
  readonly computeDshTreeDigest: (dshDirectory: string) => string;
}

export const readGenerationRuntimeIdentity = (
  layout: AppDataLayout,
  environmentId: string,
  generationId: string,
): GenerationRuntimeIdentity => {
  try {
    const manifest = JSON.parse(
      readFileSync(generationPaths(layout, environmentId, generationId).manifestPath, 'utf8'),
    ) as { node?: { treeDigest?: unknown }; dsh?: { treeDigest?: unknown } };
    return {
      nodeTreeDigest: typeof manifest.node?.treeDigest === 'string' ? manifest.node.treeDigest : null,
      dshTreeDigest: typeof manifest.dsh?.treeDigest === 'string' ? manifest.dsh.treeDigest : null,
    };
  } catch {
    return { nodeTreeDigest: null, dshTreeDigest: null };
  }
};

/**
 * Records missing runtime identity digests into the manifest after the caller
 * re-verifies the installed artifacts. Missing fields are recorded; existing
 * fields are never overwritten, so a repaired generation is not silently
 * re-blessed if it later drifts.
 */
export const recordGenerationRuntimeIdentity = (
  options: RecordRuntimeIdentityOptions,
): PortOutcome<GenerationRuntimeIdentity> => {
  const paths = generationPaths(options.layout, options.environmentId, options.generationId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.manifestPath, 'utf8'));
  } catch {
    return portFail('INTERNAL_ERROR', 'the generation has no readable install manifest to repair');
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed['node']) || !isPlainRecord(parsed['dsh'])) {
    return portFail('INTERNAL_ERROR', 'the generation install manifest is malformed and cannot be repaired');
  }
  const existing = readGenerationRuntimeIdentity(options.layout, options.environmentId, options.generationId);
  const nodeTreeDigest =
    existing.nodeTreeDigest ?? options.computeNodeTreeDigest(paths.nodeDirectory);
  const dshTreeDigest = existing.dshTreeDigest ?? options.computeDshTreeDigest(paths.dshDirectory);
  const manifest = {
    ...parsed,
    node: { ...(parsed['node'] as Record<string, unknown>), treeDigest: nodeTreeDigest },
    dsh: { ...(parsed['dsh'] as Record<string, unknown>), treeDigest: dshTreeDigest },
  };
  writeJsonAtomic(paths.manifestPath, manifest);
  return portOk({ nodeTreeDigest, dshTreeDigest });
};
