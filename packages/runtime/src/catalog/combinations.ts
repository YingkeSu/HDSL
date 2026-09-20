/**
 * The audited runtime catalog.
 *
 * Only combinations with real macOS ARM64 launcher evidence from T001
 * (`docs/research/dsh-compatibility.md`, R002) are listed. Windows/Linux stay
 * absent: absence means unsupported, never "untested but probably fine".
 *
 * Every artifact is pinned to its official source and SHA-256:
 * - Node: `https://nodejs.org/dist/<v>/<file>` cross-checked against the
 *   official `SHASUMS256.txt` for that release.
 * - DSH: the exact `@deepseek-ai/dsh@0.1.5-rc.2` tarball in the npm registry
 *   (`f4c54839…`, independently recomputed in T001).
 *
 * `CATALOG_REVISION` changes whenever this table changes; the install manifest
 * records it together with the closure lock hash so a rebuilt environment can
 * never silently move to different bytes for the same combination id.
 */
import {
  runtimeCombinationSchema,
  type RuntimeArtifact,
  type RuntimeCombination,
  type RuntimeArtifactRef,
} from '@hdsl/contracts';
import type { Arch, Platform } from '@hdsl/contracts';

/** Bumped on any change to the audited versions/sources in this module. */
export const CATALOG_REVISION = 't004-2026-09-20.1';

export const DSH_VERSION = '0.1.5-rc.2';
export const DSH_ARTIFACT_URL =
  'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz';
export const DSH_ARTIFACT_SHA256 =
  'f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480';

export interface VerifiedNodeRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

/** Node releases with real launcher evidence on macOS ARM64 (T001 R002). */
export const VERIFIED_NODE_RELEASES: readonly VerifiedNodeRelease[] = [
  {
    version: '22.19.0',
    url: 'https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-arm64.tar.gz',
    sha256: 'c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d',
  },
  {
    version: '24.21.0',
    url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz',
    sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  },
];

export const EVIDENCE_REF = 'docs/research/dsh-compatibility.md#R002';

/** Catalog ids are opaque and path-safe: dots become underscores. */
export const combinationId = (
  platform: Platform,
  arch: Arch,
  nodeVersion: string,
  dshVersion: string,
): string =>
  `${platform}-${arch}-node${nodeVersion.replaceAll('.', '_')}-dsh${dshVersion.replaceAll('.', '_')}`;

const artifactRef = (
  version: string,
  platform: Platform,
  arch: Arch,
  sha256: string,
): RuntimeArtifactRef => ({ version, platform, arch, sha256 });

const artifact = (
  version: string,
  platform: Platform,
  arch: Arch,
  url: string,
  sha256: string,
): RuntimeArtifact => ({ version, platform, arch, url, sha256 });

const buildCombination = (
  platform: Platform,
  arch: Arch,
  node: VerifiedNodeRelease,
): RuntimeCombination => {
  const combination: RuntimeCombination = {
    id: combinationId(platform, arch, node.version, DSH_VERSION),
    platform,
    arch,
    node: artifactRef(node.version, platform, arch, node.sha256),
    dsh: artifactRef(DSH_VERSION, platform, arch, DSH_ARTIFACT_SHA256),
    compatibility: { status: 'verified', evidenceRef: EVIDENCE_REF },
    artifactLocations: {
      node: artifact(node.version, platform, arch, node.url, node.sha256),
      dsh: artifact(DSH_VERSION, platform, arch, DSH_ARTIFACT_URL, DSH_ARTIFACT_SHA256),
    },
  };
  const issues: import('@hdsl/contracts').ValidationIssue[] = [];
  const parsed = runtimeCombinationSchema(combination, 'combination', issues);
  if (parsed === undefined) {
    throw new Error(`catalog combination ${combination.id} is invalid: ${JSON.stringify(issues)}`);
  }
  return parsed;
};

/** The verified macOS ARM64 catalog: Node 22.19.0 / 24.21.0 + DSH 0.1.5-rc.2. */
export const VERIFIED_COMBINATIONS: readonly RuntimeCombination[] = [
  buildCombination('darwin', 'arm64', VERIFIED_NODE_RELEASES[0] as VerifiedNodeRelease),
  buildCombination('darwin', 'arm64', VERIFIED_NODE_RELEASES[1] as VerifiedNodeRelease),
];
