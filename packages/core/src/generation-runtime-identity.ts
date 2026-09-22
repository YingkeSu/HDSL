/**
 * Generation runtime identity recording + migration (ADR 0005 D8/D14).
 *
 * New installs record the Node and DSH tree digests in the install manifest. A
 * generation created before that field existed cannot be verified for reuse and
 * is refused with an actionable, non-destructive message (normal start is
 * unaffected). This module provides the controlled repair: the caller must first
 * RE-VERIFY the installed runtime against the TRUSTED managed artifact (for
 * example by re-extracting the pinned tarball) and pass the trusted digests. The
 * installed tree is then compared to those trusted digests; only an exact match
 * is recorded. Digests are never computed from the live tree as the source of
 * truth, so a tampered tree cannot be self-blessed.
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
  /**
   * Digests derived from the TRUSTED managed artifact (re-extracted and verified
   * against the pinned source), never from the live installed tree.
   */
  readonly trusted: { readonly nodeTreeDigest: string; readonly dshTreeDigest: string };
  /** Live computations used only to compare the installed tree to `trusted`. */
  readonly computeNodeTreeDigest: (nodeDirectory: string) => string;
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
  const trusted = options.trusted;
  if (trusted.nodeTreeDigest.length !== 64 || trusted.dshTreeDigest.length !== 64) {
    return portFail('INTERNAL_ERROR', 'the trusted artifact digests are missing or malformed');
  }
  const liveNode = options.computeNodeTreeDigest(paths.nodeDirectory);
  const liveDsh = options.computeDshTreeDigest(paths.dshDirectory);
  if (liveNode !== trusted.nodeTreeDigest || liveDsh !== trusted.dshTreeDigest) {
    return portFail(
      'INTERNAL_ERROR',
      'the installed runtime does not match the trusted artifact; refusing to record a drifted identity',
    );
  }
  const nodeTreeDigest = existing.nodeTreeDigest ?? trusted.nodeTreeDigest;
  const dshTreeDigest = existing.dshTreeDigest ?? trusted.dshTreeDigest;
  const manifest = {
    ...parsed,
    node: { ...(parsed['node'] as Record<string, unknown>), treeDigest: nodeTreeDigest },
    dsh: { ...(parsed['dsh'] as Record<string, unknown>), treeDigest: dshTreeDigest },
  };
  writeJsonAtomic(paths.manifestPath, manifest);
  return portOk({ nodeTreeDigest, dshTreeDigest });
};
