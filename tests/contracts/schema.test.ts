/**
 * Schema combinator behavior: strict unknown-field rejection, required vs
 * optional keys, code-point length and name safety rules.
 */
import {
  nameSchema,
  sInteger,
  sObject,
  sOptional,
  sString,
  type ValidationIssue,
} from '@hdsl/contracts';
import { describe, expect, it } from 'vitest';

const issues = (): ValidationIssue[] => [];

describe('sObject', () => {
  const schema = sObject({
    required: sString({ minLength: 1 }),
    optional: sOptional(sInteger({ min: 0 })),
  });

  it('accepts a strict object with optional keys absent', () => {
    const found = issues();
    expect(schema({ required: 'x' }, 'input', found)).toEqual({ required: 'x' });
    expect(found).toEqual([]);
  });

  it('accepts a present optional key', () => {
    const found = issues();
    expect(schema({ required: 'x', optional: 3 }, 'input', found)).toEqual({
      required: 'x',
      optional: 3,
    });
    expect(found).toEqual([]);
  });

  it('rejects unknown fields', () => {
    const found = issues();
    expect(schema({ required: 'x', extra: 1 }, 'input', found)).toBeUndefined();
    expect(found).toContainEqual({ path: 'input.extra', message: 'unknown field' });
  });

  it('rejects a missing required field and keeps the value out of the issue', () => {
    const found = issues();
    expect(schema({}, 'input', found)).toBeUndefined();
    expect(found).toContainEqual({ path: 'input.required', message: 'is required' });
  });

  it('rejects an invalid present optional field', () => {
    const found = issues();
    expect(schema({ required: 'x', optional: 'nope' }, 'input', found)).toBeUndefined();
    expect(found).toContainEqual({ path: 'input.optional', message: 'must be an integer' });
  });

  it('rejects arrays and null', () => {
    expect(schema([], 'input', issues())).toBeUndefined();
    expect(schema(null, 'input', issues())).toBeUndefined();
  });
});

describe('sString length', () => {
  it('counts code points, not UTF-16 units', () => {
    const found = issues();
    expect(sString({ maxLength: 1 })('😀', 'input', found)).toBe('😀');
    expect(found).toEqual([]);
    expect(sString({ maxLength: 1 })('😀😀', 'input', issues())).toBeUndefined();
  });
});

describe('environment name rules', () => {
  it('accepts unicode names up to 80 code points with spaces', () => {
    const found = issues();
    expect(nameSchema('工作 环境', 'input.name', found)).toBe('工作 环境');
    expect(nameSchema('😀'.repeat(80), 'input.name', issues())).toBe('😀'.repeat(80));
    expect(found).toEqual([]);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    [' leading', 'leading whitespace'],
    ['trailing ', 'trailing whitespace'],
    ['a/b', 'path separator'],
    ['a\\b', 'windows path separator'],
    ['..', 'reserved segment'],
    ['line\nbreak', 'control character'],
    ['x'.repeat(81), 'too long'],
  ])('rejects %j (%s)', (value) => {
    expect(nameSchema(value, 'input.name', issues())).toBeUndefined();
  });
});
