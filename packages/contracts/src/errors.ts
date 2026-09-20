/**
 * Contract error codes, the discriminated success/failure envelope and the
 * helpers that keep error messages secret-free.
 *
 * Both the main process and the renderer import these types so a failure can
 * never drift into two dialects. Messages are sanitized on construction; no
 * validator embeds the received value in an issue.
 */
import { sanitizeContractMessage } from './redaction.js';
import { sBoolean, sLiteral, sObject, sOptional, sString, type ValidationIssue } from './schema.js';

/** Every error code defined by `contracts/local-api.md`. */
export const ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'CONTRACT_VERSION_MISMATCH',
  'UNSUPPORTED_COMBINATION',
  'REVISION_CONFLICT',
  'ENVIRONMENT_BUSY',
  'WEBUI_UNAVAILABLE',
  'DOWNLOAD_FAILED',
  'DIGEST_MISMATCH',
  'DISK_FULL',
  'START_TIMEOUT',
  'PORT_UNAVAILABLE',
  'PROCESS_EXITED',
  'CANNOT_CANCEL',
  'EXPORT_FAILED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = sLiteral(...ERROR_CODES);

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);

/**
 * Retry semantics frozen for v1.0. Retryable failures are those caused by
 * transient local state; deterministic rejections (validation, revision,
 * version, unsupported combination, digest mismatch, cancellation) are not.
 */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'ENVIRONMENT_BUSY',
  'WEBUI_UNAVAILABLE',
  'DOWNLOAD_FAILED',
  'DISK_FULL',
  'START_TIMEOUT',
  'PORT_UNAVAILABLE',
  'PROCESS_EXITED',
  'EXPORT_FAILED',
]);

export const isRetryable = (code: ErrorCode): boolean => RETRYABLE_CODES.has(code);

/**
 * Controlled, secret-free message per code. Used for every value that crosses
 * the boundary from a downstream port: the port's own message text is never
 * forwarded (security review P2-3), only its code is trusted.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: 'input is invalid',
  NOT_FOUND: 'the requested resource was not found',
  IDEMPOTENCY_CONFLICT: 'requestId was already used with different parameters',
  CONTRACT_VERSION_MISMATCH: 'the request apiVersion does not match the main process',
  UNSUPPORTED_COMBINATION: 'the requested combination is not supported on this host',
  REVISION_CONFLICT: 'expectedRevision does not match the current composition revision',
  ENVIRONMENT_BUSY: 'the environment is busy or a request is already in progress',
  WEBUI_UNAVAILABLE: 'the managed WebUI endpoint is unavailable',
  DOWNLOAD_FAILED: 'the download failed',
  DIGEST_MISMATCH: 'the artifact digest does not match the audited catalog',
  DISK_FULL: 'there is not enough disk space',
  START_TIMEOUT: 'the managed process did not become ready in time',
  PORT_UNAVAILABLE: 'the requested port is not available',
  PROCESS_EXITED: 'the managed process exited unexpectedly',
  CANNOT_CANCEL: 'the operation already committed and cannot be cancelled',
  EXPORT_FAILED: 'the diagnostic export failed',
  INTERNAL_ERROR: 'unclassified internal error',
};

export interface ContractError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly operationId?: string;
}

export const contractErrorSchema = sObject({
  code: errorCodeSchema,
  message: sString({ minLength: 1, maxLength: 512 }),
  retryable: sBoolean,
  operationId: sOptional(sString({ minLength: 1, maxLength: 64 })),
});

export interface ContractErrorOptions {
  readonly operationId?: string | undefined;
}

/** Contract error messages never exceed this length (also enforced by `contractErrorSchema`). */
export const MAX_ERROR_MESSAGE_LENGTH = 512;

const boundMessage = (message: string): string =>
  message.length <= MAX_ERROR_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;

/** Builds a secret-free contract error; the message is always sanitized and bounded. */
export const contractError = (
  code: ErrorCode,
  message: string,
  options: ContractErrorOptions = {},
): ContractError => {
  const sanitized = boundMessage(sanitizeContractMessage(message));
  if (options.operationId === undefined) {
    return { code, message: sanitized, retryable: isRetryable(code) };
  }
  return { code, message: sanitized, retryable: isRetryable(code), operationId: options.operationId };
};

/** Controlled-message error for a downstream result; the port text is dropped. */
export const contractErrorForCode = (
  code: ErrorCode,
  options: ContractErrorOptions = {},
): ContractError => contractError(code, ERROR_MESSAGES[code], options);

/** Cap on reported validation issues, so untrusted input cannot inflate the response. */
export const MAX_REPORTED_ISSUES = 20;
const MAX_ISSUE_PATH_LENGTH = 80;

/** Renders structural issues without echoing any received value. */
export const formatValidationIssues = (issues: readonly ValidationIssue[]): string => {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path =
      issue.path.length > MAX_ISSUE_PATH_LENGTH
        ? `${issue.path.slice(0, MAX_ISSUE_PATH_LENGTH)}…`
        : issue.path;
    return `${path}: ${issue.message}`;
  });
  if (issues.length > MAX_REPORTED_ISSUES) {
    shown.push(`${issues.length - MAX_REPORTED_ISSUES} more issue(s)`);
  }
  return `invalid input (${shown.join('; ')})`;
};

export const invalidInput = (issues: readonly ValidationIssue[]): ContractError =>
  contractError('INVALID_INPUT', formatValidationIssues(issues));

/** Success envelope variant. */
export interface ContractSuccess<T> {
  readonly ok: true;
  readonly apiVersion: string;
  readonly value: T;
}

/** Failure envelope variant. */
export interface ContractFailure {
  readonly ok: false;
  readonly apiVersion: string;
  readonly error: ContractError;
}

export type ContractResponse<T = unknown> = ContractSuccess<T> | ContractFailure;

export const contractOk = <T>(apiVersion: string, value: T): ContractSuccess<T> => ({
  ok: true,
  apiVersion,
  value,
});

export const contractFail = (apiVersion: string, error: ContractError): ContractFailure => ({
  ok: false,
  apiVersion,
  error,
});
