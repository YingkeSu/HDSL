/**
 * Catalog fixtures whose download locations point at the local QA endpoint.
 *
 * The catalog is the only input the public `environments.create` method needs:
 * `catalogCombinationId` is resolved to a `RuntimeCombination` and its
 * `artifactLocations` carry the URLs and advertised SHA-256. Two combinations
 * use different versions (and therefore different artifacts and digests) so the
 * isolation scenario can prove env A never reads env B's artifact/data.
 *
 * Host note: `createContractRuntime` requires the combination platform/arch to
 * match the port host, and only `darwin/arm64` is a verified host (T001). On
 * any other machine the full create path is expected to return
 * `UNSUPPORTED_COMBINATION`; that is asserted, not skipped.
 *
 * Usage order (avoids the origin/download circular dependency):
 *   1. `buildComposition(...)` — artifacts + routes, no origin yet.
 *   2. `startLocalEndpoint(fixtures.flatMap(f => f.routes))` — binds the port.
 *   3. `fixture.combinationFor(endpoint.origin)` — URLs now resolvable.
 */
import type {
  Arch,
  Platform,
  RuntimeArtifact,
  RuntimeArtifactRef,
  RuntimeCombination,
} from '@hdsl/contracts';

import { buildArtifact, type ArtifactFixture, type ArtifactKind } from './artifacts.js';
import type { RouteFixture, ServeMode } from './local-endpoint.js';

export interface CompositionInput {
  readonly id: string;
  readonly scope: string;
  readonly nodeVersion: string;
  readonly dshVersion: string;
  readonly platform: Platform;
  readonly arch: Arch;
  readonly evidenceRef: string;
}

export interface CompositionFixture {
  readonly id: string;
  readonly scope: string;
  readonly node: ArtifactFixture;
  readonly dsh: ArtifactFixture;
  /** Fixture download routes, default mode `full`. */
  readonly routes: readonly RouteFixture[];
  /** Same routes with explicit transport modes for fault scenarios. */
  routesWith(modes: Partial<Record<ArtifactKind, ServeMode>>): RouteFixture[];
  combinationFor(origin: string): RuntimeCombination;
}

const artifactPath = (compositionId: string, artifact: ArtifactFixture): string =>
  `/artifacts/${compositionId}/${artifact.fileName}`;

/** Two distinct macOS ARM64 compositions used by the install scenarios. */
export const HOST_ARCH: { readonly platform: Platform; readonly arch: Arch } = {
  platform: 'darwin',
  arch: 'arm64',
};

export const COMPOSITION_A: CompositionInput = {
  id: 'combo-darwin-arm64-a',
  scope: 'env-a',
  nodeVersion: '24.21.0',
  dshVersion: '0.1.5-rc.2',
  platform: HOST_ARCH.platform,
  arch: HOST_ARCH.arch,
  evidenceRef: 'docs/research/dsh-compatibility.md',
};

export const COMPOSITION_B: CompositionInput = {
  id: 'combo-darwin-arm64-b',
  scope: 'env-b',
  nodeVersion: '22.19.0',
  dshVersion: '0.1.5-rc.2',
  platform: HOST_ARCH.platform,
  arch: HOST_ARCH.arch,
  evidenceRef: 'docs/research/dsh-compatibility.md',
};

const buildRoutes = (
  id: string,
  node: ArtifactFixture,
  dsh: ArtifactFixture,
  modes: Partial<Record<ArtifactKind, ServeMode>>,
): RouteFixture[] => [
  { path: artifactPath(id, node), body: node.bytes, mode: modes.node ?? 'full' },
  { path: artifactPath(id, dsh), body: dsh.bytes, mode: modes.dsh ?? 'full' },
];

const refOf = (artifact: ArtifactFixture): RuntimeArtifactRef => ({
  version: artifact.version,
  platform: artifact.platform,
  arch: artifact.arch,
  sha256: artifact.sha256,
});

const locationOf = (
  compositionId: string,
  artifact: ArtifactFixture,
  origin: string,
): RuntimeArtifact => ({
  version: artifact.version,
  platform: artifact.platform,
  arch: artifact.arch,
  url: `${origin}${artifactPath(compositionId, artifact)}`,
  sha256: artifact.sha256,
});

export const buildComposition = (input: CompositionInput): CompositionFixture => {
  const node = buildArtifact({
    kind: 'node',
    version: input.nodeVersion,
    platform: input.platform,
    arch: input.arch,
    scope: input.scope,
  });
  const dsh = buildArtifact({
    kind: 'dsh',
    version: input.dshVersion,
    platform: input.platform,
    arch: input.arch,
    scope: input.scope,
  });
  return {
    id: input.id,
    scope: input.scope,
    node,
    dsh,
    routes: buildRoutes(input.id, node, dsh, {}),
    routesWith: (modes) => buildRoutes(input.id, node, dsh, modes),
    combinationFor: (origin) => ({
      id: input.id,
      platform: input.platform,
      arch: input.arch,
      node: refOf(node),
      dsh: refOf(dsh),
      compatibility: { status: 'verified', evidenceRef: input.evidenceRef },
      artifactLocations: {
        node: locationOf(input.id, node, origin),
        dsh: locationOf(input.id, dsh, origin),
      },
    }),
  };
};
