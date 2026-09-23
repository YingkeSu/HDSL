/**
 * #118: read-only EXPECTED composition parser + managed invocation boundaries.
 *
 * These tests pin the honest semantics:
 * - grouped `# == <label>` YAML is parsed per section (never as one logical
 *   document), rows are `(id, name, disabled, config?)`;
 * - `!!js` expressions are preserved **verbatim and never evaluated**;
 * - malformed sections/rows, unresolved constructs and unknown values become
 *   explicit diagnostics, never a silent drop;
 * - the view is always the expected/desired composition, never the runtime
 *   ACTIVE set (`basis`/`runtimeVerification` are fixed by the schema).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectedCompositionViewSchema } from '@hdsl/contracts';
import {
  createExpectedCompositionPort,
  parseExpectedCompositionDump,
} from '@hdsl/runtime';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A representative grouped dump: two `# ==` sections, a `!!js` config whose text
 * must survive verbatim, an unevaluated `disabled`, and a `name` that is an
 * explicit tag (unknown).
 */
const REPRESENTATIVE_DUMP = [
  '# == @deepseek-ai/dsh-base',
  '- id: timer',
  "  name: '@deepseek-ai/cordis-plugin-timer'",
  '- id: hv',
  '  name: hmr',
  '  disabled: true',
  '  config:',
  '    root:',
  '      - .',
  '- id: sessions',
  "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
  '  config:',
  '    root: !!js dshHomePath(\'sessions\')',
  '    mode: !!js process.env.DSH_TOOLS_MODE',
  "- id: platform",
  '  disabled: !!js process.platform === \'win32\'',
  '# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app',
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  '  disabled: true',
  '',
].join('\n');

describe('parseExpectedCompositionDump', () => {
  it('preserves group labels and parses rows across sections', () => {
    const parsed = parseExpectedCompositionDump(REPRESENTATIVE_DUMP);
    expect(parsed.groups.map((group) => group.label)).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app',
    ]);
    expect(parsed.rowCount).toBe(5);
    const rows = parsed.groups.flatMap((group) => group.rows);
    expect(rows.map((row) => row.id)).toEqual(['timer', 'hv', 'sessions', 'platform', 'tool-bash']);
    expect(rows[0]?.name).toBe('@deepseek-ai/cordis-plugin-timer');
    expect(rows[0]?.nameKnown).toBe(true);
    expect(rows[1]?.disabled).toBe(true);
    expect(rows[1]?.disabledKnown).toBe(true);
    expect(rows[1]?.config?.text).toContain('root:');
    expect(rows[1]?.config?.unevaluated).toBe(false);
  });

  it('preserves !!js config text verbatim and flags it as unevaluated', () => {
    const parsed = parseExpectedCompositionDump(REPRESENTATIVE_DUMP);
    const sessions = parsed.groups
      .flatMap((group) => group.rows)
      .find((row) => row.id === 'sessions');
    expect(sessions?.config?.text).toContain("root: !!js dshHomePath('sessions')");
    expect(sessions?.config?.text).toContain('mode: !!js process.env.DSH_TOOLS_MODE');
    expect(sessions?.config?.unevaluated).toBe(true);
    // The expression is never evaluated: no home path and no process env value.
    expect(sessions?.config?.text).not.toContain('/Users/');
    expect(sessions?.config?.text).not.toContain('mode: undefined');
  });

  it('keeps an unevaluated !!js disabled as unknown instead of guessing', () => {
    const parsed = parseExpectedCompositionDump(REPRESENTATIVE_DUMP);
    const platform = parsed.groups
      .flatMap((group) => group.rows)
      .find((row) => row.id === 'platform');
    expect(platform?.disabled).toBeNull();
    expect(platform?.disabledKnown).toBe(false);
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes('disabled'))).toBe(true);
  });

  it('reports malformed sections and continues with later sections', () => {
    const text = [
      '# == section-a',
      '- id: one',
      '  name: a',
      '- id: broken',
      '  name: [unclosed',
      '# == section-b',
      '- id: two',
      '  name: b',
      '',
    ].join('\n');
    const parsed = parseExpectedCompositionDump(text);
    expect(parsed.groups.map((group) => group.label)).toEqual(['section-a', 'section-b']);
    expect(parsed.groups[0]?.rows).toHaveLength(0);
    expect(parsed.groups[1]?.rows.map((row) => row.id)).toEqual(['two']);
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'group-parse-failed')).toBe(true);
  });

  it('reports a section whose root is not a sequence', () => {
    const parsed = parseExpectedCompositionDump('# == mapping-root\nid: not-a-sequence\n');
    expect(parsed.groups[0]?.rows).toHaveLength(0);
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'group-parse-failed')).toBe(true);
  });

  it('ignores rows without a literal id and reports them', () => {
    const parsed = parseExpectedCompositionDump(
      ['# == section', '- name: orphan', '  disabled: true', '- id: kept', '  name: kept', ''].join('\n'),
    );
    expect(parsed.groups[0]?.rows.map((row) => row.id)).toEqual(['kept']);
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'row-ignored')).toBe(true);
  });

  it('reports content before the first section header', () => {
    const parsed = parseExpectedCompositionDump(['- id: preamble', '# == section', '- id: real', ''].join('\n'));
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'preamble-ignored')).toBe(true);
    expect(parsed.groups.flatMap((group) => group.rows).map((row) => row.id)).toEqual(['real']);
  });

  it('flags merge keys and aliases as unresolved instead of resolving them', () => {
    const text = [
      '# == section',
      '- id: base',
      '  name: base-name',
      '  config: &shared',
      '    a: 1',
      '- id: merge-key',
      '  <<: { id: other }',
      '- id: uses-alias',
      '  name: uses-alias',
      '  config:',
      '    nested: *shared',
      '',
    ].join('\n');
    const parsed = parseExpectedCompositionDump(text);
    // The merge key and the alias are reported, never silently resolved/merged.
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes('merge'))).toBe(true);
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes('alias'))).toBe(true);
    const usesAlias = parsed.groups[0]?.rows.find((row) => row.id === 'uses-alias');
    expect(usesAlias?.config?.unevaluated).toBe(true);
  });

  it('does not treat an explicitly tagged name as a literal package reference', () => {
    const parsed = parseExpectedCompositionDump(
      ['# == section', '- id: tagged', '  name: !!js someExpression()', ''].join('\n'),
    );
    const row = parsed.groups[0]?.rows[0];
    expect(row?.name).toBeNull();
    expect(row?.nameKnown).toBe(false);
    expect(parsed.diagnostics.some((diagnostic) => diagnostic.message.includes('explicit tag'))).toBe(true);
  });

  it('parses an empty section and empty input without inventing rows', () => {
    expect(parseExpectedCompositionDump('').groups).toHaveLength(0);
    const parsed = parseExpectedCompositionDump('# == empty\n');
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.rows).toHaveLength(0);
  });

  it('treats a comment-only section as empty, not a parse failure', () => {
    const parsed = parseExpectedCompositionDump('# == comments\n# only a comment\n');
    expect(parsed.groups[0]?.rows).toHaveLength(0);
    expect(parsed.diagnostics).toHaveLength(0);
  });
});

const realDsh = process.env['HDSL_EXPECTED_COMPOSITION_DSH'];
const realEnabled = process.env['HDSL_EXPECTED_COMPOSITION_REAL'] === '1' && realDsh !== undefined;

describe.skipIf(!realEnabled)('managed --dump-config (opt-in evidence)', () => {
  it('runs the real managed dump offline and parses it with !!js preserved', async () => {
    const nodeExecutable = process.env['HDSL_EXPECTED_COMPOSITION_NODE'] ?? process.execPath;
    const home = mkdtempSync(join(tmpdir(), 'hdsl-expected-dump-'));
    cleanup.push(home);
    const data = mkdtempSync(join(tmpdir(), 'hdsl-expected-data-'));
    cleanup.push(data);
    const port = createExpectedCompositionPort({ timeoutMs: 120_000 });
    const controller = new AbortController();
    const outcome = await port.describeExpectedComposition(
      {
        nodeExecutable,
        dshEntrypoint: realDsh as string,
        profileName: 'web',
        homeDirectory: home,
        cwd: data,
      },
      controller.signal,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.exitCode).toBe(0);
    expect(outcome.value.rowCount).toBeGreaterThan(0);
    const hasJs = outcome.value.groups
      .flatMap((group) => group.rows)
      .some((row) => row.config?.text.includes('!!js') === true);
    expect(hasJs).toBe(true);
    // The invariant label is enforced by the schema the service builds; the
    // parser itself never sets a runtime-verification claim.
    const viewLike = {
      environmentId: 'env-0000000000000001',
      revision: 1,
      generationId: 'gen-0000000000000001',
      profileName: 'web',
      basis: 'dump-config',
      runtimeVerification: 'unavailable',
      bundles: [],
      patchReload: 'unknown',
      groups: outcome.value.groups,
      rowCount: outcome.value.rowCount,
      stdoutBytes: outcome.value.stdoutBytes,
      stderr: outcome.value.stderr.slice(0, 8192),
      exitCode: outcome.value.exitCode,
      timedOut: outcome.value.timedOut,
      diagnostics: outcome.value.diagnostics,
      observedAt: outcome.value.observedAt,
    };
    expect(expectedCompositionViewSchema(viewLike, 'view', [])).toBeDefined();
  }, 180_000);
});
