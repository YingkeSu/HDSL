/**
 * Renderer plugin discovery tests (issue #75, S1).
 *
 * Controller semantics run against the TEST-ONLY reference runtime; the markup
 * test renders the real component with `react-dom/server`. Neither is evidence
 * about real GitHub/Electron behavior.
 */
import {
  API_VERSION,
  CONTRACT_METHODS,
  DEFAULT_PLUGIN_QUERY,
  GITHUB_SEARCH_RESULT_LIMIT,
  type PluginSearchResult,
} from '@hdsl/contracts';
import { FIXTURE_SEED } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import type { RendererContractClient } from '../../apps/desktop/src/renderer/contract.js';
import {
  renderPluginDiscovery,
} from '../../apps/desktop/src/renderer/testing/render-markup.js';
import {
  INITIAL_STATE,
  type RendererActions,
  type RendererState,
} from '../../apps/desktop/src/renderer/view-model.js';
import { createTestRendererClient } from './support/contract-client.js';

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
    applyPluginChange: () => undefined,
    cancelInstallOperation: () => undefined,
    loadGenerations: () => undefined,
    restoreGeneration: () => undefined,
    loadInstalledPlugins: () => undefined,
    selectInstalledPlugin: () => undefined,
    previewPluginRemoval: () => undefined,
};

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const state = (patch: Partial<RendererState>): RendererState => ({
  ...INITIAL_STATE,
  phase: 'ready',
  ...patch,
});

describe('RendererController plugin discovery', () => {
  it('sends the fixed default query unchanged and stores the validated result', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    await controller.runPluginSearch();
    await flush();

    const sent = calls.find((call) => call.method === 'plugins.search');
    expect(sent?.input).toMatchObject({ query: DEFAULT_PLUGIN_QUERY });
    const result = controller.getState().pluginSearch;
    expect(result?.query).toBe(DEFAULT_PLUGIN_QUERY);
    expect(result?.hits.length).toBeGreaterThan(0);
    expect(controller.getState().selectedPluginFullName).toBe(result?.hits[0]?.fullName);
    await controller.dispose();
  });

  it('sends an edited query character for character and can restore the default', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    controller.setPluginQuery('topic:custom-plugin');
    await controller.runPluginSearch();
    await flush();
    expect(calls.find((call) => call.method === 'plugins.search')?.input).toMatchObject({
      query: 'topic:custom-plugin',
    });
    expect(controller.getState().pluginSearch?.query).toBe('topic:custom-plugin');

    controller.resetPluginQuery();
    expect(controller.getState().pluginQuery).toBe(DEFAULT_PLUGIN_QUERY);
    await controller.dispose();
  });

  it('surfaces a rate limit with a retry hint and keeps no stale result', async () => {
    const { client } = createTestRendererClient({
      ...FIXTURE_SEED,
      pluginSearch: { failure: 'RATE_LIMITED', retryAfterSeconds: 60 },
    });
    const controller = new RendererController({ client });
    await controller.load();
    await controller.runPluginSearch();
    await flush();
    const tracked = controller.getState().trackedOperation;
    expect(tracked?.status).toBe('failed');
    expect(tracked?.error?.code).toBe('RATE_LIMITED');
    expect(tracked?.error?.retryAfterSeconds).toBe(60);
    expect(controller.getState().pluginSearch).toBeNull();
    await controller.dispose();
  });

  it('surfaces a network failure without changing any environment composition', async () => {
    const { client, port } = createTestRendererClient({
      ...FIXTURE_SEED,
      pluginSearch: { failure: 'NETWORK_UNAVAILABLE' },
    });
    const controller = new RendererController({ client });
    await controller.load();
    const environmentsBefore = controller.getState().environments;
    await controller.runPluginSearch();
    await flush();
    expect(controller.getState().trackedOperation?.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(controller.getState().environments).toEqual(environmentsBefore);
    // Only the discovery effect ran; no environment mutation was attempted.
    expect(port.effects.every((effect) => effect.startsWith('searchPlugins'))).toBe(true);
    await controller.dispose();
  });

  it('fetches authoritative repository detail through plugins.inspect for the selected hit', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    await controller.runPluginSearch();
    await flush();
    const selected = controller.getState().selectedPluginFullName;
    expect(selected).not.toBeNull();
    await controller.inspectSelectedPlugin();
    await flush();
    const inspectCall = calls.find((call) => call.method === 'plugins.inspect');
    expect(inspectCall?.input).toMatchObject({ source: { owner: 'octo', name: 'dsh-plugin-demo' } });
    expect(controller.getState().pluginInspection?.repository.fullName).toBe(selected);
    await controller.dispose();
  });

  it('cancels an in-flight search through operations.cancel without side effects', async () => {
    const base = createTestRendererClient().client;
    let cancelCalls = 0;
    const client: RendererContractClient = {
      apiVersion: API_VERSION,
      methods: CONTRACT_METHODS,
      call: async (method, input) => {
        if (method === 'plugins.search') {
          return { ok: true, apiVersion: API_VERSION, value: { operationId: 'op-search' } };
        }
        if (method === 'operations.get') {
          return {
            ok: true,
            apiVersion: API_VERSION,
            value: {
              id: 'op-search',
              environmentId: null,
              kind: 'search',
              phase: 'searching',
              status: 'running',
              sequence: 1,
            },
          };
        }
        if (method === 'operations.subscribe') {
          return { ok: true, apiVersion: API_VERSION, value: { subscriptionId: 'sub-1' } };
        }
        if (method === 'operations.cancel') {
          cancelCalls += 1;
          return {
            ok: true,
            apiVersion: API_VERSION,
            value: {
              id: 'op-search',
              environmentId: null,
              kind: 'search',
              phase: 'cancelled',
              status: 'cancelled',
              sequence: 2,
            },
          };
        }
        return base.call(method, input);
      },
    };
    const controller = new RendererController({ client, pollIntervalMs: 5 });
    await controller.load();
    await controller.runPluginSearch();
    await flush();
    await controller.cancelPluginSearch();
    await flush();
    expect(cancelCalls).toBe(1);
    const tracked = controller.getState().trackedOperation;
    expect(tracked?.status).toBe('cancelled');
    expect(tracked?.output).toBeNull();
    await controller.dispose();
  });
});

describe('PluginDiscovery markup', () => {
  const search = (overrides: Partial<PluginSearchResult> = {}): PluginSearchResult => ({
    query: 'topic:dsh-plugin fork:false archived:false',
    hits: [
      {
        fullName: 'octo/dsh-plugin-demo',
        owner: 'octo',
        name: 'dsh-plugin-demo',
        description: 'demo plugin',
        htmlUrl: 'https://github.com/octo/dsh-plugin-demo',
        stars: 1234,
        topics: ['dsh-plugin'],
        defaultBranch: 'main',
        updatedAt: '2026-01-02T03:04:05Z',
        archived: false,
        fork: false,
        license: 'MIT',
      },
    ],
    totalCount: 1,
    incompleteResults: false,
    hasMore: false,
    fetchedAt: '2026-01-02T03:04:05Z',
    fromCache: false,
    ...overrides,
  });

  it('shows the exact query, the discovery disclaimer and the non-safety metadata note', () => {
    const html = renderPluginDiscovery({
      state: state({
        pluginSearch: search(),
        selectedPluginFullName: 'octo/dsh-plugin-demo',
      }),
      actions: noopActions,
    });
    expect(html).toContain('topic:dsh-plugin fork:false archived:false');
    expect(html).toContain('发现不代表可安装或安全');
    expect(html).toContain('仅展示，不作为安全或可安装性依据');
    expect(html).toContain('复制查询');
  });

  it('distinguishes a truncated result and an incomplete_results response', () => {
    const html = renderPluginDiscovery({
      state: state({
        pluginSearch: search({
          totalCount: GITHUB_SEARCH_RESULT_LIMIT + 321,
          incompleteResults: true,
          hasMore: true,
        }),
      }),
      actions: noopActions,
    });
    expect(html).toContain(String(GITHUB_SEARCH_RESULT_LIMIT));
    expect(html).toContain('incomplete_results=true');
    expect(html).toContain('还有更多结果未显示');
  });

  it('shows the S2 preview entry as not implemented instead of faking success', () => {
    const html = renderPluginDiscovery({
      state: state({
        pluginSearch: search(),
        selectedPluginFullName: 'octo/dsh-plugin-demo',
      }),
      actions: noopActions,
    });
    expect(html).toContain('来源预览');
    expect(html).toContain('S2');
    expect(html).toContain('当前版本尚未实现');
    expect(html).toMatch(/<button type="button" disabled[^>]*>来源预览<\/button>/);
  });

  it('escapes untrusted repository text instead of interpreting it as markup', () => {
    const html = renderPluginDiscovery({
      state: state({
        pluginSearch: search({
          hits: [
            {
              fullName: 'octo/dsh-plugin-demo',
              owner: 'octo',
              name: 'dsh-plugin-demo',
              description: "<script>alert('x')</script>",
              htmlUrl: 'https://github.com/octo/dsh-plugin-demo',
              stars: 1,
              topics: ['<img src=x onerror="alert(1)">'],
              defaultBranch: 'main',
              updatedAt: '2026-01-02T03:04:05Z',
              archived: false,
              fork: false,
              license: '<b>MIT</b>',
            },
          ],
        }),
        selectedPluginFullName: 'octo/dsh-plugin-demo',
      }),
      actions: noopActions,
    });
    // React escapes text children; no raw tag/attribute may survive.
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the rate-limit retry hint from the operation error', () => {
    const html = renderPluginDiscovery({
      state: state({
        trackedOperation: {
          operationId: 'op-search',
          kind: 'search',
          phase: 'failed',
          status: 'failed',
          sequence: 2,
          progress: null,
          environmentId: null,
          error: {
            code: 'RATE_LIMITED',
            message: 'GitHub rate limit reached; retry after the reported time',
            retryable: true,
            retryAfterSeconds: 90,
          },
          output: null,
        },
      }),
      actions: noopActions,
    });
    expect(html).toContain('RATE_LIMITED');
    expect(html).toContain('90');
  });
});
