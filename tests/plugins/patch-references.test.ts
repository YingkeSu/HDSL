/**
 * #77 S3: AST-based reference detection for user/bundle patches (yaml@2.9.1 +
 * DSH patch field semantics). Quoted scalars at reference positions ARE
 * references; comments and ordinary data are not; everything unresolvable fails
 * closed (unknown ⇒ the removal is blocked).
 */
import { describe, expect, it } from 'vitest';
import { PATCH_SCAN_MAX, scanPatchReferences } from '@hdsl/runtime';

describe('scanPatchReferences (AST + rc.2 patch semantics)', () => {
  it('finds plain and quoted references at reference positions', () => {
    const scan = scanPatchReferences('user patch', [
      'demo-plugin: { enabled: true }',
      'inject: ["other-plugin", \'third-plugin\']',
      '"quoted-key":',
      '  exclude: []',
    ].join('\n'));
    expect(scan.unknown).toEqual([]);
    expect(scan.references).toEqual(['demo-plugin', 'other-plugin', 'quoted-key', 'third-plugin']);
  });

  it('honours block sequences under inject and ignores comments', () => {
    const scan = scanPatchReferences('bundle @deepseek-ai/dsh-web-app', [
      '# demo-plugin appears only in this comment',
      'inject:',
      '  - real-plugin # trailing comment',
      '  - "another-plugin"',
      'plugin-b:',
    ].join('\n'));
    expect(scan.unknown).toEqual([]);
    expect(scan.references).toEqual(['another-plugin', 'plugin-b', 'real-plugin']);
  });

  it('never reports configuration data, description strings or non-inject lists', () => {
    const scan = scanPatchReferences('profile patch', [
      'plugin-a:',
      '  description: "demo-plugin reference in prose"',
      '  config:',
      '    note: demo-plugin',
      '  enabled: true',
      '  excluded:',
      '    - demo-plugin',
      '  script: |',
      '    demo-plugin --flag',
    ].join('\n'));
    expect(scan.unknown).toEqual([]);
    expect(scan.references).toEqual(['plugin-a']);
  });

  it('fails closed on aliases, merge keys and explicit tags (real AST negatives)', () => {
    const scan = scanPatchReferences('other bundle', [
      'base: &anchor',
      '  inject: [demo-plugin]',
      'derived:',
      '  <<: *anchor',
      'tagged: !include demo-plugin',
    ].join('\n'));
    // Top-level keys are still references; the unresolvable constructs block.
    expect(scan.references).toContain('base');
    expect(scan.references).toContain('derived');
    expect(scan.references).toContain('tagged');
    expect(scan.unknown.some((entry) => entry.reason.includes('alias'))).toBe(true);
    expect(scan.unknown.some((entry) => entry.reason.includes('merge key'))).toBe(true);
    expect(scan.unknown.some((entry) => entry.reason.includes('tag'))).toBe(true);
  });

  it('rejects multiple documents, tabs, block scalars in a reference field and oversized input', () => {
    const multi = scanPatchReferences('user patch', 'a: 1\n---\nb: 2\n');
    expect(multi.references).toEqual([]);
    expect(multi.unknown[0]?.reason).toContain('multiple YAML documents');

    const tabbed = scanPatchReferences('user patch', '\tbad: indent\n');
    expect(tabbed.references).toEqual([]);
    expect(tabbed.unknown.length).toBeGreaterThanOrEqual(1);

    const blockInject = scanPatchReferences('user patch', 'inject: |\n  demo-plugin\n');
    expect(blockInject.unknown.some((entry) => entry.reason.includes('block scalar'))).toBe(true);

    const oversized = scanPatchReferences('user patch', 'x'.repeat(PATCH_SCAN_MAX + 1));
    expect(oversized.references).toEqual([]);
    expect(oversized.unknown[0]?.reason).toContain('bounded parse size');
  });

  it('rejects complex mapping keys and never leaks a local absolute path', () => {
    const complex = scanPatchReferences('user patch', '? [a, b]\n: value\n');
    expect(complex.unknown.length).toBeGreaterThanOrEqual(1);

    const alias = scanPatchReferences('user patch', 'a: &x 1\nb: *x\n');
    expect(alias.unknown[0]?.source).toBe('user patch');
    expect(JSON.stringify(alias)).not.toContain('/Users');
  });
});
