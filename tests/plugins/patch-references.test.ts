/**
 * #77 S3: conservative structural reference detection for user/bundle patches.
 * Quoted scalars at reference positions ARE references; comments never are; any
 * unresolvable construct is reported as unknown so callers fail closed.
 */
import { describe, expect, it } from 'vitest';
import { scanPatchReferences } from '@hdsl/runtime';

describe('scanPatchReferences (rc.2 patch semantics)', () => {
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

  it('does not treat configuration data, block scalars or non-inject lists as references', () => {
    const scan = scanPatchReferences('profile patch', [
      'plugin-a:',
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

  it('reports anchors, aliases, merge keys, tags, tabs and multi-document markers as unknown', () => {
    const scan = scanPatchReferences('other bundle', [
      'base: &anchor',
      '  inject: [demo-plugin]',
      'derived:',
      '  <<: *anchor',
      'tagged: !include demo-plugin',
      '---',
      '\tbad: indent',
    ].join('\n'));
    expect(scan.references).toContain('base');
    expect(scan.unknown.length).toBeGreaterThanOrEqual(4);
    expect(scan.unknown.every((entry) => entry.source === 'other bundle')).toBe(true);
    expect(scan.unknown.some((entry) => entry.reason.includes('merge key'))).toBe(true);
  });

  it('never emits a local absolute path in the unknown source', () => {
    const scan = scanPatchReferences('user patch', '&x demo-plugin');
    expect(scan.unknown[0]?.source).toBe('user patch');
    expect(JSON.stringify(scan)).not.toContain('/');
  });
});
