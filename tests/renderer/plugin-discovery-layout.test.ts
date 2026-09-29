/**
 * Plugin discovery layout/accessibility regression (issue #148).
 *
 * The plugins.search page carries up to `PLUGIN_SEARCH_PAGE_SIZE` (100) hits
 * and the component keeps them all in the DOM; the GitHub search ceiling
 * (`GITHUB_SEARCH_RESULT_LIMIT` = 1000) is a different number shown as copy in
 * the counts panel. The list therefore has to live in a bounded,
 * keyboard-focusable scroll region, otherwise the source
 * preview/install/generation/uninstall panels are pushed many screens down.
 *
 * These assertions are structural (react-dom/server, no DOM/CSS layout), so
 * they cannot measure real reachability. Real-browser evidence for focus,
 * wheel and ArrowDown scrolling is recorded separately (independent Chrome/CDP
 * review on PR #154 and the 1086x773 / 420x740 harness measurements); this file
 * deliberately claims only the markup/scoping contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_SEARCH_RESULT_LIMIT,
  PLUGIN_SEARCH_PAGE_SIZE,
  type PluginSearchHit,
  type PluginSearchResult,
} from '@hdsl/contracts';
import { describe, expect, it } from 'vitest';
import { renderPluginDiscovery } from '../../apps/desktop/src/renderer/testing/render-markup.js';
import {
  INITIAL_STATE,
  type RendererActions,
  type RendererState,
} from '../../apps/desktop/src/renderer/view-model.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const noopActions: RendererActions = {
  load: () => undefined,
  refresh: () => undefined,
  setCreateName: () => undefined,
  setCreateCombinationId: () => undefined,
  createEnvironment: () => undefined,
  selectEnvironment: () => undefined,
  startSelected: () => undefined,
  stopSelected: () => undefined,
  openWebUI: () => undefined,
  exportDiagnostics: () => undefined,
  cancelTrackedOperation: () => undefined,
  retryTracking: () => undefined,
  setPluginQuery: () => undefined,
  resetPluginQuery: () => undefined,
  runPluginSearch: () => undefined,
  inspectSelectedPlugin: () => undefined,
  selectPlugin: () => undefined,
  cancelPluginSearch: () => undefined,
  setInstallSource: () => undefined,
  previewPluginChange: () => undefined,
  setBuildAuthorizationConfirmed: () => undefined,
  applyPluginChange: () => undefined,
  cancelInstallOperation: () => undefined,
  loadGenerations: () => undefined,
  restoreGeneration: () => undefined,
  loadInstalledPlugins: () => undefined,
  selectInstalledPlugin: () => undefined,
  previewPluginRemoval: () => undefined,
  loadDshVersions: () => undefined,
  switchVersion: () => undefined,
  loadExpectedComposition: () => undefined,
  setEntryPatchRowId: () => undefined,
  setEntryPatchConfigText: () => undefined,
  patchEntry: () => undefined,
  restartSelected: () => undefined,
};

const state = (patch: Partial<RendererState>): RendererState => ({
  ...INITIAL_STATE,
  phase: 'ready',
  ...patch,
});

const hit = (index: number): PluginSearchHit => {
  const slug = `dsh-plugin-${String(index).padStart(3, '0')}`;
  return {
    fullName: `octo/${slug}`,
    owner: 'octo',
    name: slug,
    description: `演示插件 ${String(index)}`,
    htmlUrl: `https://github.com/octo/${slug}`,
    stars: index,
    topics: ['dsh-plugin'],
    defaultBranch: 'main',
    updatedAt: '2026-01-02T03:04:05Z',
    archived: false,
    fork: false,
    license: 'MIT',
  };
};

const searchWith = (hits: readonly PluginSearchHit[]): PluginSearchResult => ({
  query: 'topic:dsh-plugin fork:false archived:false',
  hits: [...hits],
  totalCount: hits.length === 0 ? 0 : 15881,
  incompleteResults: false,
  hasMore: hits.length >= PLUGIN_SEARCH_PAGE_SIZE,
  fetchedAt: '2026-01-02T03:04:05Z',
  fromCache: false,
});

/** Extracts the `.plugin-results-scroll` region; it contains only list markup. */
const scrollRegion = (html: string): string => {
  const start = html.indexOf('class="plugin-results-scroll"');
  expect(start, 'a scroll region must exist').toBeGreaterThanOrEqual(0);
  const end = html.indexOf('</div>', start);
  return html.slice(start, end);
};

const render = (hits: readonly PluginSearchHit[]): string =>
  renderPluginDiscovery({
    state: state({
      pluginSearch: searchWith(hits),
      selectedPluginFullName: hits[0]?.fullName ?? null,
    }),
    actions: noopActions,
  });

describe('PluginDiscovery bounded result list (#148)', () => {
  it('keeps the full 100-hit search page in one focusable, labelled scroll region', () => {
    // Anchor the fixture to the product page size instead of a bare literal.
    expect(PLUGIN_SEARCH_PAGE_SIZE).toBe(100);
    const hits = Array.from({ length: PLUGIN_SEARCH_PAGE_SIZE }, (_, index) => hit(index));
    const html = render(hits);
    const region = scrollRegion(html);

    // The designed first-page cap is preserved and nothing is virtualized away.
    expect([...region.matchAll(/<li>/g)]).toHaveLength(PLUGIN_SEARCH_PAGE_SIZE);
    expect(region).toContain('octo/dsh-plugin-000');
    expect(region).toContain('octo/dsh-plugin-099');

    // Keyboard reachability: the region itself is focusable and named exactly
    // for the rendered page size (not the GitHub 1000-result ceiling).
    expect(region).toContain('role="group"');
    expect(region).toContain('tabindex="0"');
    expect(region).toContain('aria-label="命中结果列表（100 条，可滚动）"');
    expect(region).not.toContain('1000');
    expect(region).toContain('aria-describedby="plugin-results-hint"');

    // A visible hint explains the independent scroll to sighted keyboard users.
    expect(html).toContain('id="plugin-results-hint"');
    expect(html).toContain('列表可独立滚动');
  });

  it('keeps the GitHub 1000-result ceiling distinct from the 100-hit page', () => {
    const hits = Array.from({ length: PLUGIN_SEARCH_PAGE_SIZE }, (_, index) => hit(index));
    const html = render(hits);
    const region = scrollRegion(html);
    // The region labels the page it renders (100), never the GitHub ceiling...
    expect(region).toContain('aria-label="命中结果列表（100 条，可滚动）"');
    expect(region).not.toContain('1000');
    // ...while the ceiling stays visible as copy in the counts panel.
    expect(html).toContain(String(GITHUB_SEARCH_RESULT_LIMIT));
    expect(GITHUB_SEARCH_RESULT_LIMIT).toBe(1000);
  });

  it('uses the same bounded region for a single-hit result', () => {
    const html = render([hit(0)]);
    const region = scrollRegion(html);
    expect([...region.matchAll(/<li>/g)]).toHaveLength(1);
    expect(region).toContain('octo/dsh-plugin-000');
    expect(region).toMatch(/aria-label="[^"]*1 条[^"]*"/);
    expect(region).toContain('tabindex="0"');
  });

  it('renders no scroll region when nothing matched', () => {
    const html = render([]);
    expect(html).toContain('没有匹配的公开仓库');
    expect(html).not.toContain('plugin-results-scroll');
  });

  it('bounds the list height in the discovery-scoped stylesheet', () => {
    const css = readFileSync(
      join(root, 'apps/desktop/src/renderer/styles.css'),
      'utf8',
    );
    const rule = /\.plugin-results-scroll\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, '.plugin-results-scroll rule must exist').toBeDefined();
    expect(rule).toContain('overflow-y: auto');
    // A viewport-relative bound keeps the region from growing with 100 hits.
    expect(rule).toMatch(/max-height:\s*min\([^)]*vh[^)]*\)/);
    // The scroll behaviour stays scoped to the discovery selector.
    expect(css).not.toMatch(/^ul\s*\{[^}]*overflow-y:\s*auto/m);
  });
});
