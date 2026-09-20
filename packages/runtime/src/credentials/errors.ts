/**
 * Value-free credential failures.
 *
 * Every message is a fixed, value-free string per code, optionally extended
 * with a caller detail (a variable name, a store name, sanitized `security`
 * stderr) and passed through the contracts redactor + 512-codepoint bound, so a
 * resolved secret can never surface through an error even if a downstream
 * process printed it. The code is the machine-readable discriminant; callers
 * must not match on message text.
 */
import { sanitizeBoundedMessage } from '@hdsl/contracts';

export type CredentialFailureCode =
  /** The reference or its environment-variable name is malformed or unsafe. */
  | 'INVALID_REFERENCE'
  /** No credential reference is configured, so launch cannot proceed. */
  | 'MISSING_REFERENCE'
  /** The OS store has no item for the reference (or it resolves to an empty value). */
  | 'CREDENTIAL_NOT_FOUND'
  /** The user cancelled the OS authorization prompt; HDSL never retries interactively. */
  | 'CREDENTIAL_ACCESS_CANCELLED'
  /** The OS store refused access (ACL, locked keychain, malformed stderr, ...). */
  | 'CREDENTIAL_ACCESS_DENIED'
  /** The OS store tool failed for an unclassified reason. */
  | 'CREDENTIAL_STORE_UNAVAILABLE'
  /** The store tool did not answer within the timeout (for example a modal auth UI). */
  | 'RESOLUTION_TIMEOUT'
  /** No provider is implemented/tested for this platform (Windows in this slice). */
  | 'UNSUPPORTED_PLATFORM';

const MESSAGES: Record<CredentialFailureCode, string> = {
  INVALID_REFERENCE: 'credential reference is not usable',
  MISSING_REFERENCE: 'no credential reference is configured for this environment',
  CREDENTIAL_NOT_FOUND: 'the OS credential store has no item for the configured reference',
  CREDENTIAL_ACCESS_CANCELLED: 'the OS credential authorization was cancelled',
  CREDENTIAL_ACCESS_DENIED: 'the OS credential store refused access to the configured reference',
  CREDENTIAL_STORE_UNAVAILABLE: 'the OS credential store is unavailable',
  RESOLUTION_TIMEOUT: 'the OS credential store did not answer before the timeout',
  UNSUPPORTED_PLATFORM: 'OS credential reference resolution is not implemented for this platform',
};

/** Bound applied to the sanitized message, matching the contract error bound. */
const MESSAGE_MAX_LENGTH = 512;

/** A value-free credential resolution failure. */
export class CredentialFailure extends Error {
  readonly code: CredentialFailureCode;

  constructor(code: CredentialFailureCode, detail?: string) {
    const base = MESSAGES[code];
    const message =
      detail === undefined || detail.length === 0
        ? base
        : `${base}: ${sanitizeBoundedMessage(detail, MESSAGE_MAX_LENGTH)}`;
    super(message);
    this.name = 'CredentialFailure';
    this.code = code;
  }
}
