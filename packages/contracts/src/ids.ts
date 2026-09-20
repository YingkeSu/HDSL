/**
 * Opaque identifier, revision and name rules.
 *
 * IDs are never paths or user-supplied text: they are short opaque tokens, so
 * every resource ID is validated structurally before it can reach the context
 * port. A malformed ID is `INVALID_INPUT`; a well-formed but unknown ID is
 * `NOT_FOUND` (handled by the dispatcher, which has execution state).
 */
import { sInteger, sString, type Schema } from './schema.js';

/** Environment/operation/subscription/generation/combination/export ids. */
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Idempotency keys. Slightly wider alphabet, still opaque and bounded. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Composition digest and artifact digests: 64 lowercase hex characters. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const ID_MAX_LENGTH = 64;
export const REQUEST_ID_MAX_LENGTH = 128;
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 80;

export const opaqueIdSchema = (kind: string): Schema<string> =>
  sString({
    minLength: 1,
    maxLength: ID_MAX_LENGTH,
    pattern: OPAQUE_ID_PATTERN,
    patternHint: `${kind} must be an opaque id (letters, digits, "_" or "-")`,
  });

export const environmentIdSchema = opaqueIdSchema('environmentId');
export const operationIdSchema = opaqueIdSchema('operationId');
export const subscriptionIdSchema = opaqueIdSchema('subscriptionId');
export const generationIdSchema = opaqueIdSchema('generationId');
export const catalogCombinationIdSchema = opaqueIdSchema('catalogCombinationId');
export const exportIdSchema = opaqueIdSchema('exportId');
export const pluginIdSchema = opaqueIdSchema('pluginId');

export const requestIdSchema = sString({
  minLength: 1,
  maxLength: REQUEST_ID_MAX_LENGTH,
  pattern: REQUEST_ID_PATTERN,
  patternHint: 'requestId must be a bounded opaque token',
});

export const sha256Schema = sString({
  minLength: 64,
  maxLength: 64,
  pattern: SHA256_PATTERN,
  patternHint: 'must be 64 lowercase hexadecimal characters',
});

/** Composition revision / state version / sequence counters. */
export const revisionSchema = sInteger({ min: 0 });

/**
 * Environment display name: 1–80 code points, no control characters, no path
 * separators and no leading/trailing whitespace. Names are never used as paths
 * (FR-001), so path-like input is rejected here rather than sanitized.
 */
export const nameSchema: Schema<string> = (value, path, issues) => {
  if (typeof value !== 'string') {
    issues.push({ path, message: 'must be a string' });
    return undefined;
  }
  const length = [...value].length;
  if (length < NAME_MIN_LENGTH || length > NAME_MAX_LENGTH) {
    issues.push({ path, message: `must be ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} characters` });
    return undefined;
  }
  if (value !== value.trim()) {
    issues.push({ path, message: 'must not start or end with whitespace' });
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    issues.push({ path, message: 'must not contain control characters' });
    return undefined;
  }
  if (/[\\/]/.test(value)) {
    issues.push({ path, message: 'must not contain path separators' });
    return undefined;
  }
  if (value === '.' || value === '..') {
    issues.push({ path, message: 'must not be a reserved path segment' });
    return undefined;
  }
  return value;
};
