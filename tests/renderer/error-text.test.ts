/**
 * Localized error copy tests (#145).
 *
 * These pin the Chinese primary copy, the field-level hints and — most
 * importantly — that the expandable 技术详情 cannot become a leak: the detail is
 * re-sanitized with the shared `sanitizeContractMessage`, so a suspected token,
 * bearer credential, credential assignment, private path or raw upstream text
 * is still redacted even if a future `ContractError` bypassed construction-time
 * sanitization.
 */
import { ERROR_CODES, type ContractError } from '@hdsl/contracts';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODE_TITLES,
  fieldHintFromMessage,
  describeErrorLocalized,
  translateIssue,
} from '../../apps/desktop/src/renderer/error-text.js';

const error = (patch: Partial<ContractError> & Pick<ContractError, 'code'>): ContractError => ({
  message: 'controlled message',
  retryable: false,
  ...patch,
});

describe('ERROR_CODE_TITLES', () => {
  it('covers every frozen error code exactly once', () => {
    expect(Object.keys(ERROR_CODE_TITLES).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('never uses an English/raw code as the primary title', () => {
    for (const title of Object.values(ERROR_CODE_TITLES)) {
      expect(title).not.toMatch(/^[A-Z_]{4,}$/);
    }
  });
});

describe('describeErrorLocalized', () => {
  it.each([
    ['INVALID_INPUT', '输入不合法'],
    ['UNSUPPORTED_COMBINATION', '当前平台不支持该运行时组合'],
    ['NETWORK_UNAVAILABLE', '网络不可用'],
    ['RATE_LIMITED', '上游服务已限流'],
    ['SOURCE_ACCESS_DENIED', '上游拒绝访问（权限、认证或滥用防护）'],
    ['SOURCE_NOT_FOUND', '上游未找到该仓库、引用、提交或包'],
    ['ENVIRONMENT_BUSY', '环境忙碌或有其它事务进行中'],
  ] as const)('maps %s to the Chinese title %s', (code, title) => {
    const localized = describeErrorLocalized(error({ code }));
    expect(localized.title).toBe(title);
  });

  it('keeps the code and sanitized message available in the technical detail', () => {
    const localized = describeErrorLocalized(
      error({ code: 'INTERNAL_ERROR', message: 'unclassified internal error' }),
    );
    expect(localized.detail).toBe('INTERNAL_ERROR：unclassified internal error');
    expect(localized.code).toBe('INTERNAL_ERROR');
  });

  it('derives the retry hint from the retryable flag', () => {
    expect(describeErrorLocalized(error({ code: 'NETWORK_UNAVAILABLE', retryable: true })).retryHint).toBe(
      '该失败可重试。',
    );
    expect(describeErrorLocalized(error({ code: 'INVALID_INPUT' })).retryHint).toBe('该失败不可重试。');
  });

  it('parses a readable field label for name/query validation', () => {
    const name = describeErrorLocalized(
      error({
        code: 'INVALID_INPUT',
        message: 'invalid input (input.name: must not contain path separators)',
      }),
    );
    expect(name.fieldHint).toBe('环境名称：不能包含路径分隔符（/ 或 \\）');

    const length = describeErrorLocalized(
      error({
        code: 'INVALID_INPUT',
        message: 'invalid input (input.name: must be 1-80 characters)',
      }),
    );
    expect(length.fieldHint).toBe('环境名称：长度需为 1–80 个字符');

    const query = describeErrorLocalized(
      error({
        code: 'INVALID_INPUT',
        message: 'invalid input (input.query: must be at least 1 characters)',
      }),
    );
    expect(query.fieldHint).toBe('检索关键词：至少需要 1 个字符');
  });

  it('reports no field hint for non-validation codes', () => {
    expect(describeErrorLocalized(error({ code: 'NETWORK_UNAVAILABLE' })).fieldHint).toBeNull();
  });
});

describe('fieldHintFromMessage / translateIssue', () => {
  it('joins several structured issues', () => {
    expect(
      fieldHintFromMessage(
        'invalid input (input.name: must not start or end with whitespace; input.query: unknown field)',
      ),
    ).toBe('环境名称：首尾不能有空白字符；检索关键词：包含未知字段');
  });

  it('falls back to the structural issue text for unknown wording', () => {
    expect(translateIssue('must be an opaque id')).toBe('必须为 an opaque id');
    expect(fieldHintFromMessage('not a structural message')).toBeNull();
  });
});

describe('technical detail redaction boundary (#145)', () => {
  it('redacts a suspected API key assignment', () => {
    const localized = describeErrorLocalized(
      error({ code: 'INTERNAL_ERROR', message: 'failed with DEEPSEEK_API_KEY=sk-live-canary123' }),
    );
    expect(localized.detail).not.toContain('sk-live-canary123');
    expect(localized.detail).toContain('DEEPSEEK_API_KEY=***');
  });

  it('redacts a bearer credential', () => {
    const localized = describeErrorLocalized(
      error({ code: 'INTERNAL_ERROR', message: 'upstream rejected Bearer canary-bearer-token' }),
    );
    expect(localized.detail).not.toContain('canary-bearer-token');
    expect(localized.detail).toContain('Bearer ***');
  });

  it('redacts credential-shaped assignments and URL credentials', () => {
    const localized = describeErrorLocalized(
      error({
        code: 'INTERNAL_ERROR',
        message: 'secret: canary-secret and https://user:canary-pass@example.invalid/x',
      }),
    );
    expect(localized.detail).not.toContain('canary-secret');
    expect(localized.detail).not.toContain('canary-pass');
  });

  it('redacts private and absolute local paths', () => {
    const localized = describeErrorLocalized(
      error({ code: 'INTERNAL_ERROR', message: 'cannot read /Users/alice/.dsh/environments/e1' }),
    );
    expect(localized.detail).not.toContain('/Users/alice');
    expect(localized.detail).toContain('<path>');
  });

  it('does not invent a value that was never returned (raw upstream text stays redacted)', () => {
    const localized = describeErrorLocalized(
      error({
        code: 'DOWNLOAD_FAILED',
        message: 'token=canary-token path=/Users/bob/.ssh/id_ed25519',
      }),
    );
    expect(localized.detail).not.toContain('canary-token');
    expect(localized.detail).not.toContain('/Users/bob');
  });
});
