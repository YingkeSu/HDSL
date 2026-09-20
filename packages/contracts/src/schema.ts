/**
 * Minimal, dependency-free schema combinators used to validate every shared
 * DTO and method input at runtime.
 *
 * TypeScript types do not validate data that crosses the preload bridge, so
 * the same schema both produces the static type (`Infer`) and performs the
 * runtime check. Schemas never include the received value in an issue message,
 * which keeps secrets and local paths out of contract errors.
 *
 * T003 owns this stateless layer. State-dependent semantics (idempotency,
 * revision and resource existence) live in the dispatcher and its context
 * port, not here.
 */

/** A single structural problem found while validating a value. */
export interface ValidationIssue {
  /** Dot/bracket path to the offending field, e.g. `input.name`. */
  readonly path: string;
  /** Value-free explanation of the problem, safe to surface to the caller. */
  readonly message: string;
}

/**
 * Validates `value` and returns the normalized value, or `undefined` after
 * pushing one or more {@link ValidationIssue}s into `issues`.
 */
export type Schema<T> = (
  value: unknown,
  path: string,
  issues: ValidationIssue[],
) => T | undefined;

/** Extracts the validated type produced by a {@link Schema}. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

const OPTIONAL: unique symbol = Symbol('hdsl.contracts.optional');

/** A schema that tolerates an absent key but validates it when present. */
export type OptionalSchema<T> = Schema<T | undefined> & { readonly [OPTIONAL]: true };

/** True when the schema was produced by {@link sOptional}. */
export const isOptionalSchema = (schema: Schema<unknown>): schema is OptionalSchema<unknown> =>
  (schema as { [OPTIONAL]?: unknown })[OPTIONAL] === true;

/** True for a JSON-like object: plain prototype (`Object.prototype` or `null`). */
export const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const codePointLength = (value: string): number => [...value].length;

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  /** Value-free hint used when `pattern` does not match. */
  readonly patternHint?: string;
}

export const sString =
  (options: StringOptions = {}): Schema<string> =>
  (value, path, issues) => {
    if (typeof value !== 'string') {
      issues.push({ path, message: 'must be a string' });
      return undefined;
    }
    const length = codePointLength(value);
    if (options.minLength !== undefined && length < options.minLength) {
      issues.push({ path, message: `must be at least ${options.minLength} characters` });
      return undefined;
    }
    if (options.maxLength !== undefined && length > options.maxLength) {
      issues.push({ path, message: `must be at most ${options.maxLength} characters` });
      return undefined;
    }
    if (options.pattern !== undefined && !options.pattern.test(value)) {
      issues.push({ path, message: options.patternHint ?? 'has an invalid format' });
      return undefined;
    }
    return value;
  };

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
}

export const sInteger =
  (options: NumberOptions = {}): Schema<number> =>
  (value, path, issues) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      issues.push({ path, message: 'must be an integer' });
      return undefined;
    }
    if (!Number.isSafeInteger(value)) {
      issues.push({ path, message: 'must be a safe integer' });
      return undefined;
    }
    const tooSmall = options.min !== undefined && value < options.min;
    const tooLarge = options.max !== undefined && value > options.max;
    if (tooSmall || tooLarge) {
      issues.push({ path, message: 'is outside the allowed range' });
      return undefined;
    }
    return value;
  };

export const sNumber =
  (options: NumberOptions = {}): Schema<number> =>
  (value, path, issues) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path, message: 'must be a finite number' });
      return undefined;
    }
    const tooSmall = options.min !== undefined && value < options.min;
    const tooLarge = options.max !== undefined && value > options.max;
    if (tooSmall || tooLarge) {
      issues.push({ path, message: 'is outside the allowed range' });
      return undefined;
    }
    return value;
  };

export const sLiteral =
  <const T extends readonly string[]>(...values: T): Schema<T[number]> =>
  (value, path, issues) => {
    if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
      issues.push({ path, message: `must be one of: ${values.join(', ')}` });
      return undefined;
    }
    return value as T[number];
  };

export const sBooleanLiteral =
  <const T extends boolean>(expected: T): Schema<T> =>
  (value, path, issues) => {
    if (value !== expected) {
      issues.push({ path, message: `must be ${String(expected)}` });
      return undefined;
    }
    return expected;
  };

export interface ArrayOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
}

export const sBoolean: Schema<boolean> = (value, path, issues) => {
  if (typeof value !== 'boolean') {
    issues.push({ path, message: 'must be a boolean' });
    return undefined;
  }
  return value;
};

export const sArray =
  <T>(item: Schema<T>, options: ArrayOptions = {}): Schema<T[]> =>
  (value, path, issues) => {
    if (!Array.isArray(value)) {
      issues.push({ path, message: 'must be an array' });
      return undefined;
    }
    if (options.minLength !== undefined && value.length < options.minLength) {
      issues.push({ path, message: `must have at least ${options.minLength} items` });
      return undefined;
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      issues.push({ path, message: `must have at most ${options.maxLength} items` });
      return undefined;
    }
    const output: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const parsed = item(value[index], `${path}[${index}]`, issues);
      if (parsed === undefined) {
        return undefined;
      }
      output.push(parsed);
    }
    return output;
  };

export const sNullable =
  <T>(schema: Schema<T>): Schema<T | null> =>
  (value, path, issues) => {
    if (value === null) {
      return null;
    }
    return schema(value, path, issues);
  };

export const sOptional = <T>(schema: Schema<T>): OptionalSchema<T> => {
  const optional = ((value: unknown, path: string, issues: ValidationIssue[]) =>
    value === undefined ? undefined : schema(value, path, issues)) as OptionalSchema<T>;
  Object.defineProperty(optional, OPTIONAL, { value: true, enumerable: false });
  return optional;
};

/** Accepts any value; used for the untyped slot of the request envelope. */
export const sUnknown = (): Schema<unknown> => (value) => value;

type OptionalKeys<Shape extends Record<string, Schema<unknown>>> = {
  [K in keyof Shape]: Shape[K] extends OptionalSchema<unknown> ? K : never;
}[keyof Shape];

type RequiredKeys<Shape extends Record<string, Schema<unknown>>> = Exclude<
  keyof Shape,
  OptionalKeys<Shape>
>;

/** The validated object type produced by {@link sObject}. */
export type ObjectOutput<Shape extends Record<string, Schema<unknown>>> = {
  [K in RequiredKeys<Shape>]: Infer<Shape[K]>;
} & {
  [K in OptionalKeys<Shape>]?: Infer<Shape[K]>;
};

/**
 * Strict, unknown-field-rejecting object schema. Absent optional keys are
 * omitted from the output, matching `exactOptionalPropertyTypes`.
 */
const MAX_UNKNOWN_FIELD_REPORTS = 20;
const MAX_FIELD_NAME_LENGTH = 64;

export const sObject =
  <Shape extends Record<string, Schema<unknown>>>(shape: Shape): Schema<ObjectOutput<Shape>> =>
  (value, path, issues) => {
    if (!isPlainRecord(value)) {
      issues.push({ path, message: 'must be a plain object' });
      return undefined;
    }
    const start = issues.length;
    const record = value;
    let unknownFields = 0;
    for (const key of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) {
        unknownFields += 1;
        if (unknownFields <= MAX_UNKNOWN_FIELD_REPORTS) {
          const name = key.length > MAX_FIELD_NAME_LENGTH ? `${key.slice(0, MAX_FIELD_NAME_LENGTH)}…` : key;
          issues.push({ path: `${path}.${name}`, message: 'unknown field' });
        }
      }
    }
    if (unknownFields > MAX_UNKNOWN_FIELD_REPORTS) {
      issues.push({ path, message: `${unknownFields - MAX_UNKNOWN_FIELD_REPORTS} more unknown field(s)` });
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const schema = shape[key];
      if (schema === undefined) {
        continue;
      }
      const optional = isOptionalSchema(schema);
      const present = Object.prototype.hasOwnProperty.call(record, key);
      if (!present) {
        if (!optional) {
          issues.push({ path: `${path}.${key}`, message: 'is required' });
          return undefined;
        }
        continue;
      }
      const raw = record[key];
      if (optional && raw === undefined) {
        continue;
      }
      const parsed = schema(raw, `${path}.${key}`, issues);
      if (parsed === undefined) {
        return undefined;
      }
      output[key] = parsed;
    }
    if (issues.length > start) {
      return undefined;
    }
    return output as unknown as ObjectOutput<Shape>;
  };
