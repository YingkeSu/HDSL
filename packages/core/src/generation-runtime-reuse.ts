/**
 * Runtime reuse for a new plugin generation (ADR 0006 D-B, ADR 0005 D8/D14).
 *
 * A plugin change must produce a new generation that still has a complete,
 * bootable Node + DSH installation. The runtime artifacts are immutable, so the
 * new generation reuses the current generation's `node/` and `dsh/` trees via
 * hardlinks (copy fallback across devices) plus its `install-manifest.json`.
 *
 * Safety rules:
 * - the source generation is only read; it is never modified or deleted;
 * - every reused entry is a hardlink or an independent copy, so the new
 *   generation cannot mutate the old one in place;
 * - a missing/irregular source manifest is a controlled failure, never a
 *   half-populated generation.
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import { generationPaths, type AppDataLayout } from './layout.js';

export interface ReuseGenerationRuntimeOptions {
  readonly layout: AppDataLayout;
  readonly environmentId: string;
  readonly fromGenerationId: string;
  readonly toGenerationId: string;
}

export interface ReusedGenerationRuntime {
  readonly nodeDirectory: string;
  readonly dshDirectory: string;
  readonly manifestPath: string;
}

const hardlinkTree = (from: string, to: string): void => {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const target = join(to, name);
    const stats = lstatSync(source);
    if (stats.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else if (stats.isDirectory()) {
      hardlinkTree(source, target);
    } else if (stats.isFile()) {
      try {
        linkSync(source, target);
      } catch {
        // Cross-device or unsupported: fall back to an independent copy.
        copyFileSync(source, target);
      }
    }
  }
};

/**
 * Stages `node/`, `dsh/` and `install-manifest.json` from the current
 * generation into a new generation directory. Returns controlled failures when
 * the source generation is not a complete managed install.
 */
export const reuseGenerationRuntime = (
  options: ReuseGenerationRuntimeOptions,
): PortOutcome<ReusedGenerationRuntime> => {
  const source = generationPaths(options.layout, options.environmentId, options.fromGenerationId);
  const target = generationPaths(options.layout, options.environmentId, options.toGenerationId);
  let manifestStats;
  try {
    manifestStats = lstatSync(source.manifestPath);
  } catch {
    return portFail('INTERNAL_ERROR', 'the source generation has no managed install manifest');
  }
  if (!manifestStats.isFile()) {
    return portFail('INTERNAL_ERROR', 'the source generation install manifest is not a regular file');
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
    hardlinkTree(from, to);
  }
  try {
    linkSync(source.manifestPath, target.manifestPath);
  } catch {
    copyFileSync(source.manifestPath, target.manifestPath);
  }
  return portOk({
    nodeDirectory: target.nodeDirectory,
    dshDirectory: target.dshDirectory,
    manifestPath: target.manifestPath,
  });
};
