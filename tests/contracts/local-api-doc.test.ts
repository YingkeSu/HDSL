/**
 * Doc-consistency checks for the frozen local API contract.
 *
 * `specs/001-environment-lifecycle/contracts/local-api.md` is the human-readable
 * summary; `packages/contracts/src/{version,methods,errors}.ts` and the
 * executable fixture table are the authority. These tests fail loudly when the
 * two drift, so the 1.1 freeze cannot silently lose a method, an error code, or
 * a retryability classification.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  API_VERSION,
  CONTRACT_METHODS,
  ERROR_CODES,
  isRetryable,
  type ErrorCode,
} from '@hdsl/contracts';
import { ALL_CONTRACT_FIXTURES } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(
  fileURLToPath(
    new URL('../../specs/001-environment-lifecycle/contracts/local-api.md', import.meta.url),
  ),
  'utf8',
);

/** Markdown body of one `## <heading>` section, up to the next `## ` heading. */
const section = (heading: string): string => {
  const start = doc.indexOf(heading);
  if (start === -1) {
    throw new Error(`local-api.md is missing the section ${heading}`);
  }
  const body = doc.slice(start + heading.length);
  const end = body.indexOf('\n## ');
  return end === -1 ? body : body.slice(0, end);
};

const methodTable = section('## 方法');
const errorTable = section('## 错误码');
const fixtureTable = section('## 契约 fixture 表');

const documentedMethods = [...methodTable.matchAll(/^\|\s*([a-zA-Z]+\.[A-Za-z]+)\s*\|/gm)].map(
  (match) => match[1] as string,
);

const documentedErrors = [...errorTable.matchAll(/^\|\s*([A-Z_]+)\s*\|\s*(是|否)\s*\|/gm)].map(
  (match) => ({ code: match[1] as ErrorCode, retryable: match[2] === '是' }),
);

describe('local-api.md matches the frozen 1.1 contract', () => {
  it('declares the frozen wire version and drops the draft framing', () => {
    expect(API_VERSION).toBe('1.1');
    expect(doc).toContain(`本地 API 契约 v${API_VERSION}（冻结）`);
    expect(doc).not.toContain('草案');
    expect(doc).not.toContain('实施前修订');
  });

  it('lists every callable method exactly once and no unknown method', () => {
    expect([...documentedMethods].sort()).toEqual([...CONTRACT_METHODS].sort());
    expect(new Set(documentedMethods).size).toBe(documentedMethods.length);
  });

  it('lists every error code exactly once and no unknown code', () => {
    const codes = documentedErrors.map((entry) => entry.code);
    expect([...codes].sort()).toEqual([...ERROR_CODES].sort());
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('marks the retryable subset consistently with the executable registry', () => {
    for (const { code, retryable } of documentedErrors) {
      expect(retryable, `${code} retryable flag`).toBe(isRetryable(code));
    }
    expect(documentedErrors.filter((entry) => entry.retryable)).toHaveLength(
      ERROR_CODES.filter((code) => isRetryable(code)).length,
    );
  });

  it('names every method in the fixture table', () => {
    for (const method of CONTRACT_METHODS) {
      expect(fixtureTable, `fixture table is missing ${method}`).toContain(method);
    }
  });

  it('covers every method with executable legal and illegal fixtures', () => {
    for (const method of CONTRACT_METHODS) {
      const fixtures = ALL_CONTRACT_FIXTURES.filter((fixture) => fixture.method === method);
      expect(fixtures.length, `${method} has no fixture`).toBeGreaterThan(0);
      expect(
        fixtures.some((fixture) => fixture.kind === 'legal'),
        `${method} has no legal fixture`,
      ).toBe(true);
      expect(
        fixtures.some((fixture) => fixture.kind === 'illegal'),
        `${method} has no illegal fixture`,
      ).toBe(true);
    }
  });

  it('keeps the service-verification policy out of the contract gate', () => {
    expect(doc).not.toContain('unknown ⇒ 一律阻塞');
    expect(doc).toContain('不做静态服务依赖证明门禁');
  });
});
