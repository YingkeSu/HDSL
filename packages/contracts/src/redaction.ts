/**
 * Secret and local-path redaction for contract error messages.
 *
 * Contract errors are returned to the untrusted renderer, so they must never
 * carry credentials, bearer tokens, WebUI grant query strings or arbitrary
 * local paths (FR-007, ADR 0002). Validators already build value-free messages,
 * and downstream port text is replaced by controlled per-code messages
 * (`contractErrorForCode`); this module is the defense-in-depth pass applied by
 * `contractError`.
 *
 * This is a denylist, not a guarantee: security review P2-3 is mitigated
 * primarily by not forwarding downstream text, not by these patterns.
 */

/** Matches `scheme://user:pass@host` credential material. */
const URL_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g;

/** Matches bearer credentials. */
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Matches `name: value` / `name=value` assignments whose key looks secret-like
 * (DSH's `.credentials.yaml` uses `secret: <base64url>`, cookies use
 * `dsh-auth-<hash>=<value>`). Keys are matched as tokens (no `.`), and an
 * optional quote around the key covers JSON (`{"secret":"..."}`).
 */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:secret|password|passwd|pwd|token|api[_-]?key|credential|authorization|auth|cookie)[A-Za-z0-9_-]*)["']?\s*[:=]\s*("[^"]*"|'[^']*'|(?![Bb]earer\b)[^\s,;{}]+)/gi;

/** Bare `key=...` assignment (word-bounded, so `monkey=` is untouched). */
const KEY_ASSIGNMENT = /\b(key=)[^&#\s]*/gi;

/** Absolute path roots that must not leak into contract errors. */
const LOCAL_PATH_ROOT = String.raw`\/(?:Users|home|private|var|tmp|opt|etc|root|Volumes|Applications|Library|System|usr|bin|sbin|mnt|media)`;
const LOCAL_PATHS = [
  new RegExp(`${LOCAL_PATH_ROOT}\\/[^\\s"'()]+`, 'g'),
  /~\/[^\s"'()]+/g,
  /[A-Za-z]:\\[^\s"'()]+/g,
];

const REDACTED_PATH = '<path>';

/** Structural redaction; applied to every message created by `contractError`. */
export const sanitizeContractMessage = (message: string): string => {
  let result = message
    .replace(URL_CREDENTIALS, '$1***@')
    .replace(SECRET_ASSIGNMENT, '$1=***')
    .replace(KEY_ASSIGNMENT, '$1***')
    .replace(BEARER, 'Bearer ***');
  for (const pattern of LOCAL_PATHS) {
    result = result.replace(pattern, REDACTED_PATH);
  }
  return result;
};

/**
 * Truncates to `maxLength` Unicode code points — the same unit `sString` counts
 * — so a schema `maxLength` postcondition holds after redaction. Never splits a
 * surrogate pair.
 */
const boundCodePoints = (value: string, maxLength: number): string => {
  const codePoints = [...value];
  return codePoints.length <= maxLength ? value : codePoints.slice(0, maxLength).join('');
};

/**
 * Redacts then bounds `message` to `maxLength` code points, guaranteeing the
 * result satisfies a `maxLength` string schema (issue #29). Redaction runs
 * first, so truncation can only cut already-substituted text and can never
 * expose the tail of a raw secret. Bounding can expose a fresh assignment or
 * path pattern at the cut (e.g. `token=*`), so it is re-run to a fixed point;
 * the result is idempotent and safe to pass through the sanitizer again.
 */
export const sanitizeBoundedMessage = (message: string, maxLength: number): string => {
  let candidate = boundCodePoints(sanitizeContractMessage(message), maxLength);
  // Two passes cover the current patterns; the cap only bounds a future pair
  // that kept alternating.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = boundCodePoints(sanitizeContractMessage(candidate), maxLength);
    if (next === candidate) {
      return candidate;
    }
    candidate = next;
  }
  return candidate;
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
