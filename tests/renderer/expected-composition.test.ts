/**
 * Renderer expected-composition panel tests (#118).
 *
 * Controller semantics run against the TEST-ONLY reference runtime; the markup
 * test renders the real component with `react-dom/server`. Neither is evidence
 * about a real managed dump or Electron.
 */
import type { ExpectedCompositionView } from '@hdsl/contracts';
import { FIXTURE_IDS, FIXTURE_SEED } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import { renderExpectedComposition } from '../../apps/desktop/src/renderer/testing/render-markup.js';
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
  loadExpectedComposition: () => undefined,
};

const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('RendererController compositions.expected', () => {
  it('dispatches compositions.expected for the selected environment and stores the view', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadExpectedComposition();
    await flush();

    const sent = calls.find((call) => call.method === 'compositions.expected');
    expect(sent).toBeDefined();
    const input = sent?.input as { requestId?: unknown; environmentId?: unknown };
    expect(typeof input.requestId).toBe('string');
    expect(input.environmentId).toBe(FIXTURE_IDS.environment.running);

    const view = controller.getState().expectedComposition;
    expect(view).not.toBeNull();
    expect(view?.basis).toBe('dump-config');
    expect(view?.runtimeVerification).toBe('unavailable');
    expect(view?.groups.length).toBeGreaterThan(0);
    await controller.dispose();
  });

  it('surfaces a controlled failure without storing a stale view', async () => {
    const { client } = createTestRendererClient({
      ...FIXTURE_SEED,
      expectedComposition: { failure: 'INTERNAL_ERROR' },
    });
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadExpectedComposition();
    await flush();
    const tracked = controller.getState().trackedOperation;
    expect(tracked?.kind).toBe('composition');
    expect(tracked?.status).toBe('failed');
    expect(tracked?.error?.code).toBe('INTERNAL_ERROR');
    expect(controller.getState().expectedComposition).toBeNull();
    await controller.dispose();
  });
});

const view: ExpectedCompositionView = {
  environmentId: FIXTURE_IDS.environment.stopped,
  revision: 1,
  generationId: 'gen-0000000000000001',
  profileName: 'hdsl-gen-0000000000000001',
  basis: 'dump-config',
  runtimeVerification: 'unavailable',
  bundles: ['@deepseek-ai/dsh-base'],
  patchReload: 'live',
  groups: [
    {
      label: '@deepseek-ai/dsh-base',
      rows: [
        {
          id: 'sessions',
          name: '@deepseek-ai/dsh-session-persistence-jsonl',
          nameKnown: true,
          disabled: null,
          disabledKnown: false,
          config: {
            text: "root: !!js dshHomePath('sessions')",
            truncated: false,
            unevaluated: true,
          },
        },
      ],
    },
  ],
  rowCount: 1,
  stdoutBytes: 128,
  stderr: 'warning: something happened\n',
  exitCode: 0,
  timedOut: false,
  diagnostics: [
    {
      code: 'unresolved-construct',
      message: 'explicit tag in disabled is not interpreted',
      groupLabel: '@deepseek-ai/dsh-base',
      line: 3,
    },
  ],
  observedAt: '2026-09-23T00:00:00.000Z',
};

describe('ExpectedComposition markup', () => {
  it('renders the mandatory expected != ACTIVE label and the dump metadata', () => {
    const html = renderExpectedComposition({
      state: {
        ...INITIAL_STATE,
        environments: FIXTURE_SEED.environments,
        selectedEnvironmentId: FIXTURE_IDS.environment.stopped,
        expectedComposition: view,
      },
      actions: noopActions,
    });
    expect(html).toContain('期望组成');
    expect(html).toContain('≠');
    expect(html).toContain('运行期 ACTIVE');
    expect(html).toContain('hdsl-gen-0000000000000001');
    expect(html).toContain('@deepseek-ai/dsh-base');
    expect(html).toContain('patchReload');
  });

  it('shows stderr warnings and parse diagnostics as-is', () => {
    const html = renderExpectedComposition({
      state: {
        ...INITIAL_STATE,
        environments: FIXTURE_SEED.environments,
        selectedEnvironmentId: FIXTURE_IDS.environment.stopped,
        expectedComposition: view,
      },
      actions: noopActions,
    });
    expect(html).toContain('stderr 警告');
    expect(html).toContain('warning: something happened');
    expect(html).toContain('解析诊断');
    expect(html).toContain('unresolved-construct');
    // `!!js` text is rendered verbatim, not evaluated.
    expect(html).toContain('!!js');
  });

  it('renders nothing when no environment is selected', () => {
    const html = renderExpectedComposition({
      state: { ...INITIAL_STATE, selectedEnvironmentId: null, expectedComposition: view },
      actions: noopActions,
    });
    expect(html).toBe('');
  });
});
