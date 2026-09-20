/**
 * Fixture-driven contract checks.
 *
 * `ALL_CONTRACT_FIXTURES` is the checkable form of the
 * 「方法 × 合法/非法 fixture × 期望错误码」table in
 * `specs/001-environment-lifecycle/contracts/local-api.md`. These tests run the
 * dispatcher against the TEST-ONLY in-memory port and assert the recorded
 * outcome, so the table and the runtime cannot drift.
 */
import {
  ALL_CONTRACT_FIXTURES,
  CONTRACT_FIXTURES,
  CONTRACT_METHODS,
  ERROR_CODES,
  evaluateContractFixture,
  isErrorCode,
  type ContractFixture,
} from '@hdsl/contracts';
import { describe, expect, it } from 'vitest';

describe('contract fixture table', () => {
  it.each(ALL_CONTRACT_FIXTURES)('$id ($kind) → $expected', (fixture: ContractFixture) => {
    const observation = evaluateContractFixture(fixture);
    expect(observation.outcome).toBe(fixture.expected);
  });
});

describe('fixture table coverage', () => {
  it('has unique fixture ids', () => {
    const ids = ALL_CONTRACT_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every frozen method with at least one legal and one illegal fixture', () => {
    for (const method of CONTRACT_METHODS) {
      const fixtures = CONTRACT_FIXTURES.filter((fixture) => fixture.method === method);
      expect(fixtures.length, `${method} has fixtures`).toBeGreaterThan(0);
      expect(
        fixtures.some((fixture) => fixture.kind === 'legal'),
        `${method} has a legal fixture`,
      ).toBe(true);
      expect(
        fixtures.some((fixture) => fixture.kind === 'illegal'),
        `${method} has an illegal fixture`,
      ).toBe(true);
    }
  });

  it('only expects valid error codes, and never "ok" for an illegal fixture', () => {
    for (const fixture of ALL_CONTRACT_FIXTURES) {
      if (fixture.kind === 'illegal') {
        expect(fixture.expected, fixture.id).not.toBe('ok');
      }
      if (fixture.expected !== 'ok') {
        expect(isErrorCode(fixture.expected), fixture.id).toBe(true);
      }
    }
  });

  it('freezes the error-code vocabulary in the documented order', () => {
    const documented = [
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
    ];
    expect([...ERROR_CODES].sort()).toEqual([...documented].sort());
  });
});
