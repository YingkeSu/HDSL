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

/** Builds a secret-free contract error; the message is always sanitized. */
export const contractError = (
  code: ErrorCode,
  message: string,
  options: ContractErrorOptions = {},
): ContractError => {
  const sanitized = sanitizeContractMessage(message);
  if (options.operationId === undefined) {
    return { code, message: sanitized, retryable: isRetryable(code) };
  }
  return { code, message: sanitized, retryable: isRetryable(code), operationId: options.operationId };
};

/** Renders structural issues without echoing any received value. */
export const formatValidationIssues = (issues: readonly ValidationIssue[]): string => {
  const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  return `invalid input (${summary})`;
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
