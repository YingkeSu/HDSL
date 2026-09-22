/**
 * #77 S3: AST reference detection against the REAL rc.2 Cordis patch schema
 * (verified from the managed install's own bundle patches: root sequence,
 * `- insert: [{id, name}]`, `- id: X` overrides, `inject` = services).
 */
import { describe, expect, it } from 'vitest';
import { PATCH_SCAN_MAX, scanPatchReferences } from '@hdsl/runtime';

/** Trimmed from the managed `@deepseek-ai/dsh-base/cordis.patch.yml` shape. */
const REAL_BUNDLE_PATCH = [
  '# The dsh-base bundle patch: applied as ONE insert over the empty profile root.',
  '- insert:',
  '    - id: timer',
  "      name: '@deepseek-ai/cordis-plugin-timer'",
  '    - id: hmr',
  '      name: "@deepseek-ai/cordis-plugin-hmr"',
  '      disabled: true',
  '      config:',
  "        root: ['.']",
  '- id: system-prompt',
  '  config:',
  '    personaPrefix: >-',
  '      You are an agent; demo-plugin is only prose here.',
  '    inject: [webStartup, loader]',
].join('\n');

describe('scanPatchReferences (real rc.2 Cordis patch schema)', () => {
  it('reads package references from insert rows and row names only', () => {
    const scan = scanPatchReferences('bundle @deepseek-ai/dsh-base', REAL_BUNDLE_PATCH);
    expect(scan.unknown).toEqual([]);
    expect(scan.references).toEqual(['@deepseek-ai/cordis-plugin-hmr', '@deepseek-ai/cordis-plugin-timer']);
    expect(scan.rowIds).toEqual(['hmr', 'timer']);
    expect(scan.rowTargets).toEqual(['system-prompt']);
  });

  it('never treats inject services, config data, ids or prose as package references', () => {
    const scan = scanPatchReferences('bundle @deepseek-ai/dsh-web-app', REAL_BUNDLE_PATCH);
    expect(scan.references).not.toContain('webStartup');
    expect(scan.references).not.toContain('loader');
    expect(scan.references).not.toContain('system-prompt');
    expect(scan.references).not.toContain('demo-plugin');
  });

  it('blocks a bundle that inserts the removed plugin by name', () => {
    const scan = scanPatchReferences('bundle @deepseek-ai/dsh-acp-app', ['- insert:', '    - id: demo', '      name: demo-plugin'].join('\n'));
    expect(scan.unknown).toEqual([]);
    expect(scan.references).toEqual(['demo-plugin']);
  });

  it('accepts a mapping root as one implicit row', () => {
    const scan = scanPatchReferences('user patch', 'name: demo-plugin\nid: demo\nconfig:\n  inject: [webStartup]\n');
    expect(scan.unknown).toEqual([]);
    expect(scan.references).toEqual(['demo-plugin']);
    expect(scan.rowTargets).toEqual(['demo']);
  });

  it('fails closed on aliases, merge keys, tags, multi-document and bad insert shapes', () => {
    const alias = scanPatchReferences('user patch', 'a: &x 1\nb: *x\n');
    expect(alias.unknown.some((entry) => entry.reason.includes('alias'))).toBe(true);

    const merge = scanPatchReferences('user patch', '- id: a\n  <<: *x\n');
    expect(merge.unknown.some((entry) => entry.reason.includes('merge key') || entry.reason.includes('alias'))).toBe(true);

    const tagged = scanPatchReferences('user patch', '- insert: !include rows\n');
    expect(tagged.unknown.some((entry) => entry.reason.includes('tag'))).toBe(true);

    const multi = scanPatchReferences('user patch', '- id: a\n---\n- id: b\n');
    expect(multi.references).toEqual([]);
    expect(multi.unknown[0]?.reason).toContain('multiple YAML documents');

    const badInsert = scanPatchReferences('user patch', '- insert: x\n');
    expect(badInsert.unknown.some((entry) => entry.reason.includes('not a sequence of rows'))).toBe(true);

    const blockName = scanPatchReferences('user patch', '- insert:\n    - id: a\n      name: |\n        demo-plugin\n');
    expect(blockName.unknown.some((entry) => entry.reason.includes('block scalar'))).toBe(true);

    const scalarRoot = scanPatchReferences('user patch', 'just-a-string\n');
    expect(scalarRoot.unknown.length).toBeGreaterThanOrEqual(1);

    const oversized = scanPatchReferences('user patch', 'x'.repeat(PATCH_SCAN_MAX + 1));
    expect(oversized.references).toEqual([]);
    expect(oversized.unknown[0]?.reason).toContain('bounded parse size');
  });

  it('never emits a local absolute path in a source label', () => {
    const scan = scanPatchReferences('user patch', 'a: &x 1\nb: *x\n');
    expect(scan.unknown[0]?.source).toBe('user patch');
    expect(JSON.stringify(scan)).not.toContain('/Users');
  });
});
