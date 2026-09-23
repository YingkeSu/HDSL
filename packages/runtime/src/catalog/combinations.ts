/**
 * The audited runtime catalog.
 *
 * Only combinations with real macOS ARM64 launcher evidence from T001
 * (`docs/research/dsh-compatibility.md`, R002) plus the A2 Tier 2
 * (`0.1.7-rc.1`, `docs/development/version-switch-validation.md`) are listed.
 * Windows/Linux stay absent: absence means unsupported, never "untested but
 * probably fine".
 *
 * Every artifact is pinned to its official source and SHA-256:
 * - Node: `https://nodejs.org/dist/<v>/<file>` cross-checked against the
 *   official `SHASUMS256.txt` for that release.
 * - DSH: the exact `@deepseek-ai/dsh@<version>` tarball in the npm registry,
 *   independently recomputed (T001 for `0.1.5-rc.2`; A2 Tier 2 for
 *   `0.1.7-rc.1`).
 *
 * `latest`/`next`/`alpha` dist-tags are source facts, never support. A version
 * becomes `supported` only when a combination here pins its exact bytes.
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
export const CATALOG_REVISION = 'a2-tier2-2026-09-24.1';

/**
 * Baseline DSH release (T001). Kept as the named constants existing callers use;
 * `VERIFIED_DSH_RELEASES` is the authoritative list of audited releases.
 */
export const DSH_VERSION = '0.1.5-rc.2';
export const DSH_ARTIFACT_URL =
  'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz';
export const DSH_ARTIFACT_SHA256 =
  'f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480';

/**
 * A2 Tier 2 DSH release (#131): the first audited DSH version that forms a real
 * data-format boundary against the baseline (`SESSION_FORMAT_VERSION` 4 vs 3).
 * Source facts were verified read-only against the public npm registry and the
 * upstream tag `dsh-v0.1.7-rc.1`; see `docs/research/dsh-compatibility.md` R007.
 */
export const DSH_VERSION_TIER2 = '0.1.7-rc.1';
export const DSH_ARTIFACT_URL_TIER2 =
  'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.1.tgz';
export const DSH_ARTIFACT_SHA256_TIER2 =
  'efc7f91923ae5e7bc35a654fd80a8eee9d36ed05a141ce61083973182d78cd42';

export interface VerifiedDshRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

/** Exact DSH tarballs with independently recomputed SHA-256 (macOS ARM64). */
export const VERIFIED_DSH_RELEASES: readonly VerifiedDshRelease[] = [
  { version: DSH_VERSION, url: DSH_ARTIFACT_URL, sha256: DSH_ARTIFACT_SHA256 },
  { version: DSH_VERSION_TIER2, url: DSH_ARTIFACT_URL_TIER2, sha256: DSH_ARTIFACT_SHA256_TIER2 },
];

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

/** T001 baseline evidence: Node axis + DSH 0.1.5-rc.2 behavior probes. */
export const EVIDENCE_REF = 'docs/research/dsh-compatibility.md#R002';
/** A2 Tier 2 evidence: real macOS ARM64 install/start/cross-version restore. */
export const TIER2_EVIDENCE_REF = 'docs/development/version-switch-validation.md#tier-2-real-evidence';

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
  dsh: VerifiedDshRelease,
): RuntimeCombination => {
  const combination: RuntimeCombination = {
    id: combinationId(platform, arch, node.version, dsh.version),
    platform,
    arch,
    node: artifactRef(node.version, platform, arch, node.sha256),
    dsh: artifactRef(dsh.version, platform, arch, dsh.sha256),
    compatibility: {
      status: 'verified',
      evidenceRef: dsh.version === DSH_VERSION ? EVIDENCE_REF : TIER2_EVIDENCE_REF,
    },
    artifactLocations: {
      node: artifact(node.version, platform, arch, node.url, node.sha256),
      dsh: artifact(dsh.version, platform, arch, dsh.url, dsh.sha256),
    },
  };
  const issues: import('@hdsl/contracts').ValidationIssue[] = [];
  const parsed = runtimeCombinationSchema(combination, 'combination', issues);
  if (parsed === undefined) {
    throw new Error(`catalog combination ${combination.id} is invalid: ${JSON.stringify(issues)}`);
  }
  return parsed;
};

/**
 * The verified macOS ARM64 catalog: Node 22.19.0 / 24.21.0 for both audited DSH
 * releases (baseline `0.1.5-rc.2` first, then `0.1.7-rc.1`). Existing baseline
 * combination ids/bytes are unchanged.
 */
export const VERIFIED_COMBINATIONS: readonly RuntimeCombination[] =
  VERIFIED_DSH_RELEASES.flatMap((dsh) =>
    VERIFIED_NODE_RELEASES.map((node) => buildCombination('darwin', 'arm64', node, dsh)),
  );
