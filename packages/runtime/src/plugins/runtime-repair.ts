/**
 * Trusted runtime digests for repairing an old generation's missing identity
 * (ADR 0005 D8/D14).
 *
 * The digests used for a repair must come from the TRUSTED pinned artifacts, not
 * from the (possibly tampered) installed tree and not from the manifest being
 * repaired. This module re-verifies the pinned Node and DSH artifacts (sha256
 * against the catalog) from HDSL's own cache or a bounded download, safely
 * re-extracts them into a private temporary directory, and computes the expected
 * Node and DSH tree digests. Callers pass the result to
 * `recordGenerationRuntimeIdentity`, which then compares the installed tree to
 * these trusted digests and records only an exact match.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import { downloadToFile, type FetchLike } from '../install/download.js';
import { sha256File, sha256TreeDigestSync } from '../install/hash.js';
import { extractTarGz } from '../install/tar.js';

export interface TrustedRuntimeArtifact {
  readonly url: string;
  readonly sha256: string;
}

export interface TrustedRuntimeDigestsOptions {
  readonly node: TrustedRuntimeArtifact;
  readonly dsh: TrustedRuntimeArtifact;
  /** HDSL's own artifact cache (`<dataRoot>/artifacts`). */
  readonly cacheDirectory: string;
  readonly fetch: FetchLike;
}

export interface TrustedRuntimeDigests {
  readonly nodeTreeDigest: string;
  readonly dshTreeDigest: string;
}

const DSH_PACKAGE_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh'] as const;

const obtain = async (
  artifact: TrustedRuntimeArtifact,
  cacheDirectory: string,
  fetch: FetchLike,
): Promise<PortOutcome<string>> => {
  const directory = join(cacheDirectory, artifact.sha256);
  const cached = join(directory, 'artifact.tgz');
  try {
    if (!existsSync(cached)) {
      mkdirSync(directory, { recursive: true });
      await downloadToFile(artifact.url, cached, {
        fetch,
        maxBytes: 400 * 1024 * 1024,
        signal: new AbortController().signal,
      });
    }
    const digest = await sha256File(cached);
    if (digest !== artifact.sha256) {
      return portFail('INTERNAL_ERROR', 'a pinned artifact in the cache does not match its expected digest');
    }
    return portOk(cached);
  } catch {
    return portFail('INTERNAL_ERROR', 'a pinned artifact could not be obtained for runtime verification');
  }
};

/**
 * Re-verifies the pinned artifacts and returns the trusted Node/DSH tree
 * digests. Any failure is a controlled error; no digest is ever derived from the
 * installed generation.
 */
export const deriveTrustedRuntimeDigests = async (
  options: TrustedRuntimeDigestsOptions,
): Promise<PortOutcome<TrustedRuntimeDigests>> => {
  const nodeArchive = await obtain(options.node, options.cacheDirectory, options.fetch);
  if (!nodeArchive.ok) {
    return nodeArchive;
  }
  const dshArchive = await obtain(options.dsh, options.cacheDirectory, options.fetch);
  if (!dshArchive.ok) {
    return dshArchive;
  }
  const work = mkdtempSync(join(tmpdir(), 'hdsl-runtime-trust-'));
  try {
    const nodeRoot = join(work, 'node');
    const dshRoot = join(work, 'dsh');
    mkdirSync(nodeRoot, { recursive: true });
    mkdirSync(dshRoot, { recursive: true });
    await extractTarGz(nodeArchive.value, nodeRoot, { stripComponents: 1 });
    await extractTarGz(dshArchive.value, dshRoot, {
      stripComponents: 1,
      prefix: DSH_PACKAGE_SEGMENTS.join('/'),
    });
    const nodePackage = nodeRoot;
    const dshPackage = join(dshRoot, ...DSH_PACKAGE_SEGMENTS);
    if (!existsSync(nodePackage) || !existsSync(dshPackage)) {
      return portFail('INTERNAL_ERROR', 'a pinned artifact did not contain the expected runtime tree');
    }
    return portOk({
      nodeTreeDigest: sha256TreeDigestSync(nodePackage),
      dshTreeDigest: sha256TreeDigestSync(dshPackage),
    });
  } catch {
    return portFail('INTERNAL_ERROR', 'the pinned artifacts could not be safely re-extracted');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};
