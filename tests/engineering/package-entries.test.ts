/**
 * Smoke test: the workspace libraries resolve through the unit-test resolver.
 *
 * The libraries intentionally export no business API yet (T003 freezes the
 * contract, T004/T005 implement behavior), so this only proves that each
 * package entry compiles, is importable by name and has no import-time side
 * effects. It is not coverage of launcher behavior.
 */
import * as contracts from '@hdsl/contracts';
import * as core from '@hdsl/core';
import * as runtime from '@hdsl/runtime';
import { describe, expect, it } from 'vitest';

describe('workspace package entries', () => {
  it.each([
    ['@hdsl/contracts', contracts],
    ['@hdsl/core', core],
    ['@hdsl/runtime', runtime],
  ])('%s is importable as a module namespace', (_name, namespace) => {
    expect(namespace).toBeTypeOf('object');
    expect(namespace).not.toBeNull();
  });
});
