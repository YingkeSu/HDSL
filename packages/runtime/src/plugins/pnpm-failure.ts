/**
 * Bounded classification of a NON-ZERO managed-pnpm exit (plugin install and
 * removal share this single rule set so the two paths cannot drift).
 *
 * Evidence (frozen `pnpm@11.7.0` bundled source): the only literal fetch-status
 * codes are `ERR_PNPM_FETCH_401`/`ERR_PNPM_FETCH_403`, both routed to
 * `reportAuthError` (NOT rate limiting); there is no `429` code and no
 * `ERR_PNPM_FETCH_${status}` template, so a reliable registry-429/RATE_LIMITED
 * mapping is NOT available here and is deliberately not fabricated. Network
 * failures from the fetch layer carry system error codes (e.g. `ENOTFOUND`,
 * `EAI_AGAIN`, `ECONNREFUSED` before a connection is established;
 * `ECONNRESET`/`EPIPE`/`ERR_STREAM_PREMATURE_CLOSE` after) and integrity/size
 * failures have dedicated `ERR_PNPM_*` tokens.
 *
 * The scan is a strict whole-token match and its result NEVER includes stderr
 * text, so no path/secret from the child can leak into an error message.
 * Anything not reliably identified stays a sanitized, non-retryable
 * `INTERNAL_ERROR`.
 *
 * This classifies PLUGIN DEPENDENCY install failures only. Runtime artifact
 * downloads (managed Node/DSH) use their own download path and must not reuse
 * this mapping as if it described an artifact fetch.
 */
export const classifyManagedInstallFailure = (
  stderr: string,
): { readonly code: 'NETWORK_UNAVAILABLE' | 'DOWNLOAD_FAILED' | 'INTERNAL_ERROR' } => {
  const hasToken = (token: string): boolean =>
    new RegExp(`(?:^|[^A-Za-z0-9_])${token}(?:[^A-Za-z0-9_]|$)`).test(stderr);
  // Connection could not be established (DNS / connect refused).
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].some(hasToken)) {
    return { code: 'NETWORK_UNAVAILABLE' };
  }
  // Connection established, then transfer/partial/verify failed.
  if (
    [
      'ERR_PNPM_TARBALL_INTEGRITY',
      'ERR_PNPM_BAD_TARBALL_SIZE',
      'ECONNRESET',
      'EPIPE',
      'ECONNABORTED',
      'ERR_STREAM_PREMATURE_CLOSE',
      'UND_ERR_SOCKET',
      'UND_ERR_BODY_TIMEOUT',
    ].some(hasToken)
  ) {
    return { code: 'DOWNLOAD_FAILED' };
  }
  return { code: 'INTERNAL_ERROR' };
};
