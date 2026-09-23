/**
 * The pnpm TRANSPORT spec for a plugin source pinned at an exact commit (#141).
 *
 * HDSL records the SOURCE as a GitHub repository plus a full commit SHA
 * (`PluginSourceLock.sourceKind === 'github'`); the pnpm TRANSPORT spec is the
 * same commit's official codeload tarball. The tarball form avoids pnpm's
 * `fromHostedGit` GitHub HEAD probe (which has no request-level timeout) while
 * the resulting lock keeps `gitHosted: true`, the tarball `integrity`, and the
 * same `name@<tarball-url>` closure identity, so retention and authorization
 * keys are unchanged.
 *
 * The spec is never a floating reference: a non-40-hex commit is refused, the
 * host is fixed to `codeload.github.com`, and owner/name may only be plain path
 * segments. This module is the single construction point for BOTH the preview
 * target declaration and the apply-time profile declaration.
 */
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
/** Plain GitHub owner/repository segment: no scheme, slash, query or fragment. */
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

export const CODELOAD_HOST = 'codeload.github.com';

export const pluginTransportSpec = (
  source: { readonly owner: string; readonly name: string },
  commitSha: string,
): string => {
  if (!FULL_COMMIT_SHA.test(commitSha)) {
    throw new Error('a plugin transport spec requires a full 40-hex commit SHA');
  }
  if (!PATH_SEGMENT.test(source.owner) || !PATH_SEGMENT.test(source.name)) {
    throw new Error('a plugin transport spec requires a plain GitHub owner and repository name');
  }
  return `https://${CODELOAD_HOST}/${source.owner}/${source.name}/tar.gz/${commitSha}`;
};
