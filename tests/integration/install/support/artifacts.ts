/**
 * Deterministic, self-describing runtime artifacts for install QA.
 *
 * Each artifact is a real `.tar.gz` with a `hdsl-qa/marker.txt` entry whose
 * content embeds the fixture scope (composition + environment intent). That
 * marker is how the QA suite detects cross-environment mixing without needing
 * to know the loader's internal directory layout: it walks the created
 * environment root and reads every `marker.txt` it finds.
 *
 * ASSUMPTION (to confirm with T004): the managed installer downloads the
 * catalog `artifactLocations.*.url` and installs the tarball content into the
 * environment root. If T004 installs a different shape (for example a raw
 * executable plus a package tree), only this file and the catalog fixture need
 * to change; the endpoint, fault and isolation assertions stay valid.
 */
import type { Arch, Platform, RuntimeArtifactRef, RuntimeCombination } from '@hdsl/contracts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { sha256Hex } from './hash.js';
import { createTarGz, type TarEntry } from './tar.js';

export type ArtifactKind = 'node' | 'dsh';

export interface ArtifactFixture {
  readonly kind: ArtifactKind;
  readonly version: string;
  readonly platform: Platform;
  readonly arch: Arch;
  readonly fileName: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export interface ArtifactSpec {
  readonly kind: ArtifactKind;
  readonly version: string;
  readonly platform: Platform;
  readonly arch: Arch;
  /** Fixture scope, embedded in the marker file for isolation assertions. */
  readonly scope: string;
}

/** Marker file relative path inside every fixture tarball. */
export const MARKER_PATH = 'hdsl-qa/marker.txt';

export const markerContent = (spec: ArtifactSpec): string =>
  `scope=${spec.scope}\nkind=${spec.kind}\nversion=${spec.version}\nplatform=${spec.platform}/${spec.arch}\n`;

const entriesFor = (spec: ArtifactSpec): TarEntry[] => {
  const marker = Buffer.from(markerContent(spec), 'utf8');
  const common: TarEntry[] = [{ path: MARKER_PATH, data: marker }];
  if (spec.kind === 'node') {
    return [
      ...common,
      {
        path: 'bin/node',
        mode: 0o755,
        data: Buffer.from(`#!/bin/sh\n# HDSL QA fixture node ${spec.version}\necho fixture-node\n`),
      },
      { path: 'LICENSE', data: Buffer.from('HDSL QA fixture; not a real runtime.\n') },
    ];
  }
  return [
    ...common,
    {
      path: 'node_modules/@deepseek-ai/dsh/package.json',
      data: Buffer.from(
        `${JSON.stringify({ name: '@deepseek-ai/dsh', version: spec.version, hdslQaFixture: true }, null, 2)}\n`,
      ),
    },
    {
      path: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
      data: Buffer.from(`// HDSL QA fixture dsh ${spec.version}\nconsole.log('fixture-dsh');\n`),
    },
  ];
};

const fixtureOf = (spec: ArtifactSpec, bytes: Buffer): ArtifactFixture => ({
  kind: spec.kind,
  version: spec.version,
  platform: spec.platform,
  arch: spec.arch,
  fileName: `${spec.kind}-${spec.version}-${spec.platform}-${spec.arch}.tgz`,
  bytes,
  sha256: sha256Hex(bytes),
});

export const buildArtifact = (spec: ArtifactSpec): ArtifactFixture =>
  fixtureOf(spec, createTarGz(entriesFor(spec)));

/**
 * Builds an artifact from explicit entries. Used for hostile fixtures (path
 * traversal, extract-bomb shape) whose behavior must be exercised without
 * changing the normal artifact builder.
 */
export const buildArtifactWithEntries = (
  spec: ArtifactSpec,
  entries: readonly TarEntry[],
): ArtifactFixture => fixtureOf(spec, createTarGz(entries));

/**
 * Absolute-escaping artifact: archive entries target `../../` outside the
 * extraction root. A correct installer must not write those paths.
 */
export const buildPathTraversalArtifact = (spec: ArtifactSpec): ArtifactFixture =>
  buildArtifactWithEntries(spec, [
    { path: MARKER_PATH, data: Buffer.from(markerContent(spec), 'utf8') },
    { path: '../hdsl-qa-escape.txt', data: Buffer.from('escaped-one-level\n') },
    { path: '../../hdsl-qa-escape.txt', data: Buffer.from('escaped-two-levels\n') },
    { path: '/tmp/hdsl-qa-absolute-escape.txt', data: Buffer.from('absolute\n') },
  ]);

/**
 * Builds a digest-eligible ref whose `sha256` is deliberately wrong by one
 * nibble, for the `DIGEST_MISMATCH` scenario. The tampering is explicit and
 * test-local so a mismatch can never be attributed to the fixture artifact.
 */
export const corruptDigest = (digest: string): string => {
  const first = digest.slice(0, 1);
  const flipped = first === '0' ? '1' : '0';
  return `${flipped}${digest.slice(1)}`;
};

export const artifactRef = (artifact: ArtifactFixture): RuntimeArtifactRef => ({
  version: artifact.version,
  platform: artifact.platform,
  arch: artifact.arch,
  sha256: artifact.sha256,
});

export const combinationRef = (
  combination: RuntimeCombination,
  kind: ArtifactKind,
): RuntimeArtifactRef => combination[kind];

/** Reads every `marker.txt` under `root`; missing roots yield an empty list. */
export const readMarkers = (root: string): { readonly relPath: string; readonly content: string }[] => {
  const found: { relPath: string; content: string }[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        visit(full);
      } else if (entry === 'marker.txt') {
        found.push({ relPath: relative(root, full).split(sep).join('/'), content: readFileSync(full, 'utf8') });
      }
    }
  };
  visit(root);
  return found;
};
