/**
 * Platform and architecture vocabulary plus the verified host matrix.
 *
 * Only macOS ARM64 has real launcher evidence today (T001); Windows x64 is a
 * target with no host evidence. A create request whose combination does not
 * match a verified host is `UNSUPPORTED_COMBINATION`, never a silent install.
 */
import { sLiteral } from './schema.js';

export const PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ARCHES = ['arm64', 'x64'] as const;
export type Arch = (typeof ARCHES)[number];

export const platformSchema = sLiteral(...PLATFORMS);
export const archSchema = sLiteral(...ARCHES);

export interface HostPlatform {
  readonly platform: Platform;
  readonly arch: Arch;
}

/**
 * Hosts with verified launcher evidence. Windows x64 and Linux stay absent
 * until T008 provides real evidence; absence means unsupported, not untested.
 */
export const VERIFIED_HOSTS: readonly HostPlatform[] = [{ platform: 'darwin', arch: 'arm64' }];

export const isHostPlatformSupported = (host: HostPlatform): boolean =>
  VERIFIED_HOSTS.some((entry) => entry.platform === host.platform && entry.arch === host.arch);

/** Any value that carries the frozen platform/architecture target pair. */
export interface HostTarget {
  readonly platform: Platform;
  readonly arch: Arch;
}

/** True when an artifact/combination targets exactly `host`. */
export const isTargetedAtHost = (host: HostPlatform, target: HostTarget): boolean =>
  target.platform === host.platform && target.arch === host.arch;

/**
 * The subset of an audit catalog that targets exactly `host`. An unresolved
 * (unknown vocabulary) or known-but-unverified host yields an empty list:
 * absence of evidence is unsupported, never a darwin fallback and never a
 * support claim for a host without host evidence.
 *
 * This is a **projection** of the installable surface, not an authorization
 * boundary. Callers must still drop `unverified` entries, and a combination
 * absent from the result may still be resolvable downstream, so
 * `environments.create`/`switchCombination` can refuse it with a specific
 * `UNSUPPORTED_COMBINATION` instead of a generic `NOT_FOUND`.
 */
export const combinationsForHost = <T extends HostTarget>(
  host: HostPlatform | undefined,
  catalog: readonly T[],
): readonly T[] =>
  host === undefined || !isHostPlatformSupported(host)
    ? []
    : catalog.filter((entry) => isTargetedAtHost(host, entry));

/**
 * Narrows an arbitrary runtime `platform`/`arch` pair to the frozen host
 * vocabulary, or `undefined` when either value is unknown (for example Node's
 * `freebsd`, `openharmony` or `ia32`). The narrowing is membership-based, so an
 * unknown value is never coerced to a verified host such as darwin/arm64; the
 * caller must fail closed instead.
 */
export const resolveHostPlatform = (
  platform: string,
  arch: string,
): HostPlatform | undefined => {
  const knownPlatform = PLATFORMS.find((candidate) => candidate === platform);
  if (knownPlatform === undefined) {
    return undefined;
  }
  const knownArch = ARCHES.find((candidate) => candidate === arch);
  if (knownArch === undefined) {
    return undefined;
  }
  return { platform: knownPlatform, arch: knownArch };
};

export const formatHostPlatform = (host: HostPlatform): string => `${host.platform}/${host.arch}`;
