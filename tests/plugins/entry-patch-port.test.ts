/**
 * #135 E1-T1: runtime adapter for `entries.patch`.
 *
 * It pins the honest semantics at the runtime seam: the adapter writes ONLY
 * inside the caller-provided home root, reuses the E1a fail-loud parse (0-byte /
 * mapping root / multi-document / non-sequence `insert` are `INVALID_INPUT` and
 * never overwrite the original file), reports `remove` misses as `NOT_FOUND`,
 * and always returns `saved: true` + `runtime: 'pending'` +
 * `runtimeVerification: 'unavailable'` with an activation derived from
 * `patchReload`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEntryPatchPort } from '@hdsl/runtime';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Home {
  readonly root: string;
  readonly patchPath: string;
}

const tempHome = (contents?: string): Home => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-entry-patch-'));
  cleanup.push(root);
  const patchPath = join(root, 'cordis.patch.yml');
  if (contents !== undefined) {
    writeFileSync(patchPath, contents);
  }
  return { root, patchPath };
};

const port = createEntryPatchPort();

describe('createEntryPatchPort', () => {
  it('writes a legal non-empty top-level array when the file is absent (empty is the caller default)', () => {
    const home = tempHome();
    const outcome = port.applyPatch({
      operation: { kind: 'disable', rowId: 'timer' },
      homeRoot: home.root,
      patchPath: home.patchPath,
      text: '[]',
      reloadMode: 'startup',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.saved).toBe(true);
    expect(outcome.value.runtime).toBe('pending');
    expect(outcome.value.runtimeVerification).toBe('unavailable');
    expect(outcome.value.activation).toBe('restart-required');
    expect(outcome.value.restartRequired).toBe(true);
    expect(outcome.value.reloadMode).toBe('startup');
    const written = readFileSync(home.patchPath, 'utf8');
    expect(written.trimStart().startsWith('-')).toBe(true);
    expect(written).toContain('timer');
  });

  it('reports a live profile as unverified (never ACTIVE) and a startup profile as restart-required', () => {
    for (const [mode, activation, restartRequired] of [
      ['live', 'live-reload-unverified', false],
      ['startup', 'restart-required', true],
      ['unknown', 'restart-required', true],
    ] as const) {
      const home = tempHome('[]\n');
      const outcome = port.applyPatch({
        operation: { kind: 'disable', rowId: 'timer' },
        homeRoot: home.root,
        patchPath: home.patchPath,
        text: '[]',
        reloadMode: mode,
      });
      expect(outcome.ok, mode).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.activation, mode).toBe(activation);
      expect(outcome.value.restartRequired, mode).toBe(restartRequired);
    }
  });

  it.each([
    ['0-byte', ''],
    ['mapping root', 'name: demo\nid: demo\n'],
    ['multi-document', ['- insert:', '    - id: a', '---', '- insert:', '    - id: b'].join('\n')],
    ['non-sequence insert', '- insert: { id: a }\n'],
  ])('rejects a %s patch with INVALID_INPUT and never rewrites the file', (_label, text) => {
    const home = tempHome(text);
    const before = readFileSync(home.patchPath);
    const outcome = port.applyPatch({
      operation: { kind: 'disable', rowId: 'timer' },
      homeRoot: home.root,
      patchPath: home.patchPath,
      text,
      reloadMode: 'startup',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('INVALID_INPUT');
    expect(readFileSync(home.patchPath)).toEqual(before);
  });

  it('returns NOT_FOUND for remove when the row is absent from the home patch', () => {
    const home = tempHome('- insert:\n    - id: timer\n');
    const outcome = port.applyPatch({
      operation: { kind: 'remove', rowId: 'missing' },
      homeRoot: home.root,
      patchPath: home.patchPath,
      text: '- insert:\n    - id: timer\n',
      reloadMode: 'live',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_FOUND');
  });

  it('anchors the write to the home root: a path outside it is INVALID_INPUT', () => {
    const home = tempHome('[]\n');
    const outside = tempHome('[]\n');
    const outcome = port.applyPatch({
      operation: { kind: 'disable', rowId: 'timer' },
      homeRoot: home.root,
      patchPath: outside.patchPath,
      text: '[]',
      reloadMode: 'startup',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('INVALID_INPUT');
    // The out-of-root file is untouched.
    expect(readFileSync(outside.patchPath, 'utf8')).toBe('[]\n');
  });

  it('maps row and diagnostic views without leaking a config value', () => {
    const home = tempHome();
    const outcome = port.applyPatch({
      operation: {
        kind: 'config',
        rowId: 'sessions',
        config: { root: "!!js dshHomePath('sessions')" },
      },
      homeRoot: home.root,
      patchPath: home.patchPath,
      text: '[]',
      reloadMode: 'live',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.rows).toEqual([
      {
        id: 'sessions',
        kind: 'override',
        name: null,
        nameKnown: true,
        disabled: null,
        hasConfig: true,
      },
    ]);
    // No local path is part of the DTO surface.
    expect(JSON.stringify(outcome.value)).not.toContain(home.root);
  });
});
