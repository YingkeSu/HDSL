/**
 * Renderer upstream DSH version panel tests (A1 / #113).
 *
 * Controller semantics run against the TEST-ONLY reference runtime; the markup
 * test renders the real component with `react-dom/server`. Neither is evidence
 * about the real npm registry or Electron.
 */
import type { DshVersionListing } from '@hdsl/contracts';
import { FIXTURE_SEED } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import { renderDshVersions } from '../../apps/desktop/src/renderer/testing/render-markup.js';
import { INITIAL_STATE, type RendererActions } from '../../apps/desktop/src/renderer/view-model.js';
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
};

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('RendererController versions.dsh', () => {
  it('dispatches versions.dsh with a requestId and stores the validated listing', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadDshVersions();
    await flush();

    const sent = calls.find((call) => call.method === 'versions.dsh');
    expect(sent).toBeDefined();
    expect(typeof (sent?.input as { requestId?: unknown })?.requestId).toBe('string');
    const listing = controller.getState().dshVersions;
    expect(listing).not.toBeNull();
    expect(listing?.source.packageName).toBe('@deepseek-ai/dsh');
    expect(listing?.versions.some((entry) => entry.supported)).toBe(true);
    expect(listing?.versions.some((entry) => !entry.supported)).toBe(true);
    await controller.dispose();
  });

  it('surfaces a controlled registry failure without storing a stale listing', async () => {
    const { client } = createTestRendererClient({
      ...FIXTURE_SEED,
      dshVersions: { failure: 'NETWORK_UNAVAILABLE' },
    });
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadDshVersions();
    await flush();
    const tracked = controller.getState().trackedOperation;
    expect(tracked?.kind).toBe('versions');
    expect(tracked?.status).toBe('failed');
    expect(tracked?.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(controller.getState().dshVersions).toBeNull();
    await controller.dispose();
  });
});

const listing: DshVersionListing = {
  source: { registry: 'https://registry.npmjs.org', packageName: '@deepseek-ai/dsh' },
  fetchedAt: '2026-09-23T00:00:00.000Z',
  distTags: [{ tag: 'latest', version: '0.1.5-rc.2' }],
  versions: [
    {
      version: '0.1.5-rc.3',
      distTags: ['next'],
      publishedAt: null,
      supported: false,
      catalogCombinationIds: [],
    },
    {
      version: '0.1.5-rc.2',
      distTags: ['latest'],
      publishedAt: '2025-12-01T00:00:00.000Z',
      supported: true,
      catalogCombinationIds: ['combo-a'],
    },
  ],
};

describe('DshVersions markup', () => {
  it('labels audited and unaudited versions distinctly and shows source/time', () => {
    const html = renderDshVersions({
      state: { ...INITIAL_STATE, dshVersions: listing },
      actions: noopActions,
    });
    expect(html).toContain('上游 DSH 版本');
    expect(html).toContain('registry.npmjs.org');
    expect(html).toContain('2026-09-23 00:00:00.000 UTC');
    expect(html).toContain('已受审');
    expect(html).toContain('未支持');
    expect(html).toContain('latest=0.1.5-rc.2');
  });

  it('labels the unaudited version explicitly as unsupported', () => {
    const html = renderDshVersions({
      state: { ...INITIAL_STATE, dshVersions: listing },
      actions: noopActions,
    });
    expect(html).toContain('未支持：不在受审组合白名单内');
    expect(html).toContain('已受审：可经既有受管安装新建环境');
  });
});
