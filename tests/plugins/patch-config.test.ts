/**
 * #116 E1: desired-config boundary for the runtime entry axis.
 *
 * These tests pin the *honest* semantics: a saved patch file is desired config
 * only, never a claimed ACTIVE runtime set, and an invalid (0-byte / non-array /
 * malformed) patch is an explainable error rather than a silent no-op.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PatchConfigDocument,
  activationOf,
  applyPatchOperation,
  resolvePatchReloadMode,
  writePatchFileAtomic,
} from '@hdsl/runtime';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
const tempFile = (contents: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'hdsl-patch-config-'));
  cleanup.push(directory);
  const path = join(directory, 'cordis.patch.yml');
  writeFileSync(path, contents);
  return path;
};

const SAMPLE = [
  '# profile patch',
  '- insert:',
  '    - id: alpha',
  '      name: alpha-pkg',
  '    - id: beta',
  '      name: beta-pkg',
  '      disabled: true',
  '      config:',
  '        keep: !!js 1 + 1',
  '- id: base-row',
  '  disabled: true',
].join('\n');

describe('PatchConfigDocument.parse (legal array)', () => {
  it('accepts a legal sequence root and lists insert/override rows', () => {
    const parsed = PatchConfigDocument.parse(SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rows()).toEqual([
      { id: 'alpha', kind: 'insert', name: 'alpha-pkg', nameKnown: true, disabled: undefined, hasConfig: false },
      { id: 'beta', kind: 'insert', name: 'beta-pkg', nameKnown: true, disabled: true, hasConfig: true },
      { id: 'base-row', kind: 'override', name: undefined, nameKnown: true, disabled: true, hasConfig: false },
    ]);
    expect(parsed.value.diagnostics()).toEqual([]);
  });

  it('accepts a legal empty array as "no overlay" but rejects a 0-byte file', () => {
    const empty = PatchConfigDocument.parse('[]\n');
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.rows()).toEqual([]);
    }
    const blank = PatchConfigDocument.parse('');
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.code).toBe('INVALID_INPUT');
      expect(blank.message).toContain('top-level YAML array');
    }
  });

  it('rejects a mapping root and invalid YAML with an explainable error', () => {
    const mapping = PatchConfigDocument.parse('name: demo\nid: demo\n');
    expect(mapping.ok).toBe(false);
    if (!mapping.ok) expect(mapping.code).toBe('INVALID_INPUT');
    const broken = PatchConfigDocument.parse('- insert: [\n');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe('INVALID_INPUT');
  });

  it('rejects an insert value that is not a sequence of rows', () => {
    const bad = PatchConfigDocument.parse('- insert: { id: a, name: pkg }\n');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe('INVALID_INPUT');
      expect(bad.message).toBe('the insert value must be a sequence of loader rows');
    }

    const scalarInsert = PatchConfigDocument.parse('- insert: nope\n');
    expect(scalarInsert.ok).toBe(false);
    if (!scalarInsert.ok) expect(scalarInsert.code).toBe('INVALID_INPUT');
  });

  it('never collapses a tagged name into a literal package name', () => {
    const parsed = PatchConfigDocument.parse(['- insert:', '    - id: tagged', '      name: !!js someExpression'].join('\n'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const row = parsed.value.rows().find((entry) => entry.id === 'tagged');
    expect(row).toBeDefined();
    expect(row?.name).toBeUndefined();
    expect(row?.nameKnown).toBe(false);
    expect(parsed.value.diagnostics().some((entry) => entry.code === 'row-name-not-plain-scalar')).toBe(true);
  });

  it('reports a non-boolean disabled as a diagnostic instead of guessing', () => {
    const parsed = PatchConfigDocument.parse(['- insert:', '    - id: odd', '      name: pkg', '      disabled: nope'].join('\n'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rows().find((entry) => entry.id === 'odd')?.disabled).toBeUndefined();
    expect(parsed.value.diagnostics().some((entry) => entry.code === 'row-disabled-not-boolean')).toBe(true);
  });
});

describe('PatchConfigDocument edits', () => {
  it('enable clears disabled on the insert row and prunes the empty override', () => {
    const parsed = PatchConfigDocument.parse(['- insert:', '    - id: beta', '      name: beta-pkg', '      disabled: true', '- id: beta', '  disabled: true'].join('\n'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const edited = parsed.value.edit({ kind: 'enable', rowId: 'beta' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const text = edited.value.document.toText();
    expect(text).not.toMatch(/disabled/);
    expect(edited.value.document.rows()).toEqual([
      { id: 'beta', kind: 'insert', name: 'beta-pkg', nameKnown: true, disabled: undefined, hasConfig: false },
    ]);
  });

  it('disable sets disabled on the insert row without touching siblings', () => {
    const parsed = PatchConfigDocument.parse(SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const edited = parsed.value.edit({ kind: 'disable', rowId: 'alpha' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.document.rows().find((row) => row.id === 'alpha')?.disabled).toBe(true);
    expect(edited.value.document.rows().find((row) => row.id === 'beta')?.disabled).toBe(true);
    expect(edited.value.document.toText()).toContain('alpha-pkg');
  });

  it('disable of a bundle/base row adds an explicit override', () => {
    const parsed = PatchConfigDocument.parse('[]\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const edited = parsed.value.edit({ kind: 'disable', rowId: 'web-note' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.document.toText()).toContain('- id: web-note');
    expect(edited.value.document.rows()).toEqual([
      { id: 'web-note', kind: 'override', name: undefined, nameKnown: true, disabled: true, hasConfig: false },
    ]);
  });

  it('config replaces the whole config and preserves unrelated !!js and comments', () => {
    const parsed = PatchConfigDocument.parse(SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const edited = parsed.value.edit({ kind: 'config', rowId: 'alpha', config: { nested: { answer: 42 } } });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const text = edited.value.document.toText();
    expect(text).toContain('# profile patch');
    expect(text).toContain('keep: !!js 1 + 1');
    expect(text).toContain('answer: 42');
    expect(edited.value.document.rows().find((row) => row.id === 'alpha')?.hasConfig).toBe(true);
  });

  it('remove deletes the insert row and its override, keeping the sibling', () => {
    const parsed = PatchConfigDocument.parse(SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const edited = parsed.value.edit({ kind: 'remove', rowId: 'beta' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const ids = edited.value.document.rows().map((row) => row.id);
    expect(ids).toContain('alpha');
    expect(ids).not.toContain('beta');
    expect(edited.value.document.toText()).not.toContain('beta-pkg');
  });

  it('reports NOT_FOUND for enable/remove of an unknown row and INVALID_INPUT for a config edit without a value', () => {
    const parsed = PatchConfigDocument.parse(SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const missing = parsed.value.edit({ kind: 'remove', rowId: 'nope' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND');
    const noConfig = parsed.value.edit({ kind: 'config', rowId: 'alpha' });
    expect(noConfig.ok).toBe(false);
    if (!noConfig.ok) expect(noConfig.code).toBe('INVALID_INPUT');
  });
});

describe('runtime-state honesty', () => {
  it('resolvePatchReloadMode reads only an explicit live/startup value', () => {
    expect(resolvePatchReloadMode('{"dsh":{"profile":{"patchReload":"live"}}}')).toBe('live');
    expect(resolvePatchReloadMode('{"dsh":{"profile":{"patchReload":"startup"}}}')).toBe('startup');
    expect(resolvePatchReloadMode('{"dsh":{"profile":{}}}')).toBe('unknown');
    expect(resolvePatchReloadMode('not json')).toBe('unknown');
  });

  it('activationOf never claims a live effect for unknown reload or composition changes', () => {
    expect(activationOf('patch-entry', 'live')).toBe('live-reload-unverified');
    expect(activationOf('patch-entry', 'startup')).toBe('restart-required');
    expect(activationOf('patch-entry', 'unknown')).toBe('restart-required');
    expect(activationOf('composition', 'live')).toBe('restart-required');
  });

  it('applyPatchOperation saves desired config with pending runtime state and writes atomically', () => {
    const path = tempFile(SAMPLE);
    const live = applyPatchOperation({
      patchPath: path,
      text: readFileSync(path, 'utf8'),
      operation: { kind: 'disable', rowId: 'alpha' },
      reloadMode: 'live',
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(live.value.saved).toBe(true);
    expect(live.value.runtime).toBe('pending');
    expect(live.value.runtimeVerification).toBe('unavailable');
    expect(live.value.activation).toBe('live-reload-unverified');
    expect(live.value.restartRequired).toBe(false);
    expect(JSON.parse(JSON.stringify(live.value))).not.toHaveProperty('active');
    expect(readFileSync(path, 'utf8')).toContain('disabled: true');

    const startup = applyPatchOperation({
      patchPath: path,
      text: readFileSync(path, 'utf8'),
      operation: { kind: 'enable', rowId: 'alpha' },
      reloadMode: 'unknown',
    });
    expect(startup.ok).toBe(true);
    if (!startup.ok) return;
    expect(startup.value.activation).toBe('restart-required');
    expect(startup.value.restartRequired).toBe(true);
  });

  it('applyPatchOperation refuses a 0-byte patch instead of silently treating it as removal', () => {
    const path = tempFile('');
    const result = applyPatchOperation({
      patchPath: path,
      text: readFileSync(path, 'utf8'),
      operation: { kind: 'remove', rowId: 'alpha' },
      reloadMode: 'live',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_INPUT');
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('writePatchFileAtomic never leaves a partial file visible', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hdsl-patch-atomic-'));
    cleanup.push(directory);
    const path = join(directory, 'cordis.patch.yml');
    writePatchFileAtomic(path, '[]\n');
    expect(readFileSync(path, 'utf8')).toBe('[]\n');
  });
});
