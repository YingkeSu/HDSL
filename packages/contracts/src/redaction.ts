/**
 * Secret and local-path redaction for contract error messages.
 *
 * Contract errors are returned to the untrusted renderer, so they must never
 * carry credentials, bearer tokens, WebUI grant query strings or arbitrary
 * local paths (FR-007, ADR 0002). Validators already build value-free messages;
 * this module is the defense-in-depth pass applied by `contractError`.
 */

/** Matches `scheme://user:pass@host` credential material. */
const URL_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g;

/** Matches bearer credentials. */
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

/** Matches token-like assignments (e.g. the DSH WebUI `?token=` grant). */
const TOKEN_QUERY = /\b((?:token|access_token|api_key|apikey|secret|key)=)[^&#\s]*/gi;

/** Absolute paths that must not leak into contract errors. */
const LOCAL_PATHS = [/\/(?:Users|home|private|var|tmp|opt)\/[^\s"'()]+/g, /[A-Za-z]:\\[^\s"'()]+/g];

const REDACTED_PATH = '<path>';

/** Structural redaction; applied to every message created by `contractError`. */
export const sanitizeContractMessage = (message: string): string => {
  let result = message
    .replace(URL_CREDENTIALS, '$1***@')
    .replace(TOKEN_QUERY, '$1***')
    .replace(BEARER, 'Bearer ***');
  for (const pattern of LOCAL_PATHS) {
    result = result.replace(pattern, REDACTED_PATH);
  }
  return result;
};

/** Removes known secret values from arbitrary text (used for diagnostics/tests). */
export const redactSecretValues = (text: string, secrets: readonly string[]): string => {
  let result = text;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    result = result.split(secret).join('[redacted]');
  }
  return result;
};

export const containsSecret = (text: string, secrets: readonly string[]): boolean =>
  secrets.some((secret) => secret.length > 0 && text.includes(secret));
