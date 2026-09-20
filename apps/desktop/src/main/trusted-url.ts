/**
 * Exact trusted renderer-document URL policy (T006 / issue #6, security P2-1).
 *
 * IPC sender authorization and navigation authorization MUST use the same rule.
 * A prefix check is not sufficient: `.../index.html.evil`, `.../index.html/../x`,
 * encoded separators (`%2f`, `%5c`) and query/hash variants must all be rejected.
 * The rule is therefore **exact normalized equality** with the one renderer
 * document URL this build loads, with no hash/query allowance (the launcher
 * renderer has no client-side routing).
 *
 * This module is Electron-free so both the IPC host and the window guards share
 * one implementation.
 */
export interface TrustedUrlPolicy {
  /** Normalized absolute URL of the single trusted renderer document. */
  readonly allowedDocumentUrl: string;
}

/** Returns the normalized absolute href, or null when the value is not a URL. */
export const normalizeDocumentUrl = (value: string): string | null => {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
};

/** Builds a policy, normalizing the trusted URL once at construction time. */
export const createTrustedUrlPolicy = (documentUrl: string): TrustedUrlPolicy => {
  const normalized = normalizeDocumentUrl(documentUrl);
  if (normalized === null) {
    throw new Error('the trusted renderer document URL is not a valid URL');
  }
  return { allowedDocumentUrl: normalized };
};

/** Exact normalized equality; rejects suffixes, traversal, encoding tricks and queries. */
export const isTrustedDocumentUrl = (value: string, policy: TrustedUrlPolicy): boolean =>
  normalizeDocumentUrl(value) === policy.allowedDocumentUrl;
