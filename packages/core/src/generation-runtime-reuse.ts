/**
 * Runtime reuse for a new plugin generation (ADR 0006 D-B, ADR 0005 D8/D14).
 *
 * A plugin change must produce a new generation that still has a complete,
 * bootable Node + DSH installation. This module COPIES the current generation's
 * `node/` and `dsh/` into the new generation so the new generation owns
 * independent files (a write in the new generation can never mutate the old
 * one). Hardlinks are deliberately NOT used: inode sharing would make
 * "read-only" only a code intention, not an enforced boundary.
 *
 * Safety rules:
 * - the source generation is only read; it is never modified or deleted;
 * - symlinks are copied as links, but a link whose target escapes the source
 *   generation root fails closed (no escape via a crafted tree);
 * - the install manifest must be a valid managed-install record; mere presence
 *   is not treated as completeness;
 * - identity digests are verified through an injected verifier that reuses the
 *   existing managed-install mechanism (the module never invents a digest).
 */
import { cpSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isPlainRecord, portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import { generationPaths, type AppDataLayout } from './layout.js';

export interface ReuseGenerationRuntimeOptions {
  readonly layout: AppDataLayout;
  readonly environmentId: string;
  readonly fromGenerationId: string;
  readonly toGenerationId: string;
  /**
   * Reuses the existing managed-install verification (identity digests) for the
   * copied runtime. When absent the copy is structurally validated only and
   * `identityVerified` is `false`; callers must not treat that as complete.
   */
  readonly verify?: (input: {
    readonly manifestPath: string;
    readonly nodeDirectory: string;
    readonly dshDirectory: string;
  }) => boolean;
}

export interface ReusedGenerationRuntime {
  readonly nodeDirectory: string;
  readonly dshDirectory: string;
  readonly manifestPath: string;
  /** True only when the injected verifier confirmed the identity digests. */
  readonly identityVerified: boolean;
}

const isWithin = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Symlink policy for reuse: a relative symlink that resolves inside the source
 * generation root is preserved and relocates with the copy (its relative target
 * stays valid in the new tree). An absolute symlink that resolves inside the
 * source generation root is rejected: after the copy it would still point at the
 * OLD generation and break the new generation's independence. Any link that
 * escapes the generation root is rejected too.
 */
const assertRelocatableLinks = (
  generationRoot: string,
  current = generationRoot,
): PortOutcome<void> => {
  for (const name of readdirSync(current)) {
    const full = join(current, name);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(full);
      if (isAbsolute(target)) {
        // Absolute links either point back into the source generation (breaks the
        // new generation's independence) or escape it; both are rejected. The
        // real fixed managed install uses only relative links in node/ and dsh/.
        return portFail(
          'INTERNAL_ERROR',
          'the source generation contains an absolute symlink, which cannot be relocated safely',
        );
      }
      const resolved = resolve(join(full, '..'), target);
      if (!isWithin(generationRoot, resolved)) {
        return portFail('INTERNAL_ERROR', 'the source generation contains a symlink that escapes its root');
      }
    } else if (stats.isDirectory()) {
      const nested = assertRelocatableLinks(generationRoot, full);
      if (!nested.ok) {
        return nested;
      }
    }
  }
  return portOk(undefined);
};

/** Post-copy defence: the target must not link back into the old generation. */
const assertNotLinkedToOld = (
  oldGenerationRoot: string,
  current: string,
): PortOutcome<void> => {
  for (const name of readdirSync(current)) {
    const full = join(current, name);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(full);
      if (isAbsolute(target) && isWithin(oldGenerationRoot, target)) {
        return portFail('INTERNAL_ERROR', 'the copied generation still links into the old generation');
      }
    } else if (stats.isDirectory()) {
      const nested = assertNotLinkedToOld(oldGenerationRoot, full);
      if (!nested.ok) {
        return nested;
      }
    }
  }
  return portOk(undefined);
};

const readManifest = (path: string): PortOutcome<Record<string, unknown>> => {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return portFail('INTERNAL_ERROR', 'the source generation has no managed install manifest');
  }
  if (!stats.isFile()) {
    return portFail('INTERNAL_ERROR', 'the source generation install manifest is not a regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return portFail('INTERNAL_ERROR', 'the source generation install manifest is not valid JSON');
  }
  if (!isPlainRecord(parsed)) {
    return portFail('INTERNAL_ERROR', 'the source generation install manifest is malformed');
  }
  if (typeof parsed['installMode'] !== 'string' || !isPlainRecord(parsed['node']) || !isPlainRecord(parsed['dsh'])) {
    return portFail('INTERNAL_ERROR', 'the source generation install manifest is incomplete');
  }
  return portOk(parsed);
};

/**
 * Copies `node/`, `dsh/` and `install-manifest.json` into the new generation.
 * Returns controlled failures when the source is not a complete managed install.
 */
export const reuseGenerationRuntime = (
  options: ReuseGenerationRuntimeOptions,
): PortOutcome<ReusedGenerationRuntime> => {
  const source = generationPaths(options.layout, options.environmentId, options.fromGenerationId);
  const target = generationPaths(options.layout, options.environmentId, options.toGenerationId);
  const manifest = readManifest(source.manifestPath);
  if (!manifest.ok) {
    return manifest;
  }
  for (const [from, to] of [
    [source.nodeDirectory, target.nodeDirectory],
    [source.dshDirectory, target.dshDirectory],
  ] as const) {
    try {
      if (lstatSync(from).isDirectory() !== true) {
        return portFail('INTERNAL_ERROR', 'the source generation runtime directory is missing');
      }
    } catch {
      return portFail('INTERNAL_ERROR', 'the source generation runtime directory is missing');
    }
    const links = assertRelocatableLinks(source.generationDirectory);
    if (!links.ok) {
      return links;
    }
    // Independent physical copy: the new generation owns its files. Relative
    // symlinks are copied as links (never followed) so a legitimate DSH
    // structure is kept and relocates with the subtree.
    cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
  }
  cpSync(source.manifestPath, target.manifestPath);
  const linkedBack = assertNotLinkedToOld(source.generationDirectory, target.generationDirectory);
  if (!linkedBack.ok) {
    return linkedBack;
  }

  const identityVerified =
    options.verify === undefined
      ? false
      : options.verify({
          manifestPath: target.manifestPath,
          nodeDirectory: target.nodeDirectory,
          dshDirectory: target.dshDirectory,
        });
  if (options.verify !== undefined && !identityVerified) {
    return portFail('INTERNAL_ERROR', 'the copied generation runtime did not match its identity digests');
  }
  return portOk({
    nodeDirectory: target.nodeDirectory,
    dshDirectory: target.dshDirectory,
    manifestPath: target.manifestPath,
    identityVerified,
  });
};
