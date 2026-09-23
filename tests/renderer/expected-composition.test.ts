/**
 * Renderer expected-composition panel tests (#118).
 *
 * Controller semantics run against the TEST-ONLY reference runtime; the markup
 * test renders the real component with `react-dom/server`. Neither is evidence
 * about a real managed dump or Electron.
 */
import type { ContractResponse, ExpectedCompositionView } from '@hdsl/contracts';
import { FIXTURE_IDS, FIXTURE_SEED } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import { renderExpectedComposition } from '../../apps/desktop/src/renderer/testing/render-markup.js';
import { INITIAL_STATE, type RendererActions } from '../../apps/desktop/src/renderer/view-model.js';
import {
  createDeferred,
  createStubRendererClient,
  createTestRendererClient,
  stubOk,
} from './support/contract-client.js';

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

  it('clears the previously loaded dump when the selected environment changes', async () => {
    const { client } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadExpectedComposition();
    await flush();
    const loaded = controller.getState().expectedComposition;
    expect(loaded).not.toBeNull();
    expect(loaded?.environmentId).toBe(FIXTURE_IDS.environment.running);

    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);
    expect(controller.getState().expectedComposition).toBeNull();
    await controller.dispose();
  });

  it('drops an in-flight dump for environment A after switching to B', async () => {
    const envA = FIXTURE_SEED.environments[0];
    const envB = FIXTURE_SEED.environments[1];
    if (envA === undefined || envB === undefined) {
      throw new Error('fixture environments are required');
    }
    const deferred = createDeferred<ContractResponse<unknown>>();
    const { client } = createStubRendererClient((method) => {
      if (method === 'environments.list') return stubOk([envA, envB]);
      if (method === 'catalog.list') return stubOk([]);
      if (method === 'compositions.expected') return stubOk({ operationId: 'op-composition' });
      if (method === 'operations.get') return deferred.promise;
      if (method === 'operations.subscribe') return stubOk({ subscriptionId: 'sub-1' });
      if (method === 'operations.unsubscribe') return stubOk(null);
      return stubOk(null);
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(envA.id);

    const pending = controller.loadExpectedComposition();
    await flush();
    // The user switches before the dump for A resolves.
    controller.selectEnvironment(envB.id);
    deferred.resolve(
      stubOk({
        id: 'op-composition',
        environmentId: envA.id,
        kind: 'composition',
        phase: 'finished',
        status: 'succeeded',
        sequence: 1,
        output: { ...view, environmentId: envA.id },
      }),
    );
    await pending;
    expect(controller.getState().expectedComposition).toBeNull();
    expect(controller.getState().selectedEnvironmentId).toBe(envB.id);
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

  it('does not render a dump that belongs to a different environment', () => {
    const html = renderExpectedComposition({
      state: {
        ...INITIAL_STATE,
        environments: FIXTURE_SEED.environments,
        selectedEnvironmentId: FIXTURE_IDS.environment.running,
        expectedComposition: { ...view, environmentId: FIXTURE_IDS.environment.stopped },
      },
      actions: noopActions,
    });
    // The panel still renders, but the stale dump body must not.
    expect(html).toContain('期望组成');
    expect(html).not.toContain('@deepseek-ai/dsh-session-persistence-jsonl');
    expect(html).not.toContain('warning: something happened');
  });
});
