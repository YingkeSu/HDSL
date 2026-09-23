/**
 * Renderer in-environment version switch + restore downgrade warning (A2 / #114,
 * issue #132).
 *
 * Controller semantics run against the TEST-ONLY reference runtime or a stub
 * client; the markup tests render the real components with `react-dom/server`.
 * Neither is evidence about real managed installs, real DSH versions or
 * Electron.
 */
import type { DshVersionListing } from '@hdsl/contracts';
import { FIXTURE_IDS, FIXTURE_SEED } from '@hdsl/contracts/testing';
import { describe, expect, it } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import {
  renderPluginInstall,
  renderSwitchVersion,
} from '../../apps/desktop/src/renderer/testing/render-markup.js';
import {
  INITIAL_STATE,
  supportedCombinationIds,
  switchableCombinations,
  type RendererActions,
  type RendererState,
} from '../../apps/desktop/src/renderer/view-model.js';
import {
  createStubRendererClient,
  createTestRendererClient,
  stubFail,
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
  switchVersion: () => undefined,
  loadExpectedComposition: () => undefined,
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

const supportedListing: DshVersionListing = {
  source: { registry: 'https://registry.npmjs.org', packageName: '@deepseek-ai/dsh' },
  fetchedAt: '2026-01-02T03:04:05Z',
  distTags: [{ tag: 'latest', version: '0.1.5-rc.2' }],
  versions: [
    {
      version: '0.1.5-rc.2',
      distTags: ['latest'],
      publishedAt: '2025-12-01T00:00:00.000Z',
      supported: true,
      catalogCombinationIds: [FIXTURE_IDS.combination.verified],
    },
  ],
};

describe('view-model supported combination set', () => {
  it('is empty until the audited listing is loaded (unknown, never unsafe)', () => {
    expect(supportedCombinationIds(INITIAL_STATE).size).toBe(0);
    expect(switchableCombinations(INITIAL_STATE)).toHaveLength(0);
  });

  it('offers only verified catalog combinations referenced by a supported version', () => {
    const state: RendererState = {
      ...INITIAL_STATE,
      catalog: FIXTURE_SEED.catalog,
      dshVersions: supportedListing,
    };
    const ids = [...supportedCombinationIds(state)];
    expect(ids).toEqual([FIXTURE_IDS.combination.verified]);
    expect(switchableCombinations(state).map((entry) => entry.id)).toEqual([
      FIXTURE_IDS.combination.verified,
    ]);
  });
});

describe('RendererController environments.switchCombination', () => {
  it('dispatches a switch for the stopped environment, tracks it, and refreshes to revision+1', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    // Switch targets come from the audited `versions.dsh` listing (A1).
    await controller.loadDshVersions();
    await flush();
    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);
    const before = controller
      .getState()
      .environments.find((entry) => entry.id === FIXTURE_IDS.environment.stopped);
    expect(before?.revision).toBe(1);

    await controller.switchVersion(FIXTURE_IDS.combination.verified);
    await flush();

    const sent = calls.find((call) => call.method === 'environments.switchCombination');
    expect(sent).toBeDefined();
    expect(sent?.input).toMatchObject({
      environmentId: FIXTURE_IDS.environment.stopped,
      expectedRevision: before?.revision,
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    });
    expect(typeof (sent?.input as { requestId?: unknown }).requestId).toBe('string');

    const after = controller
      .getState()
      .environments.find((entry) => entry.id === FIXTURE_IDS.environment.stopped);
    expect(after?.revision).toBe((before?.revision ?? 0) + 1);
    expect(after?.state).toBe('stopped');
    expect(controller.getState().trackedOperation?.kind).toBe('switch');
    expect(controller.getState().trackedOperation?.status).toBe('succeeded');
    expect(controller.getState().actionError).toBeNull();
    await controller.dispose();
  });

  it('refuses to auto-stop: a running environment is rejected with ENVIRONMENT_BUSY and no dispatch', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadDshVersions();
    await flush();
    controller.selectEnvironment(FIXTURE_IDS.environment.running);
    const before = controller
      .getState()
      .environments.find((entry) => entry.id === FIXTURE_IDS.environment.running);

    await controller.switchVersion(FIXTURE_IDS.combination.verified);
    await flush();

    expect(calls.some((call) => call.method === 'environments.switchCombination')).toBe(false);
    expect(calls.some((call) => call.method === 'environments.stop')).toBe(false);
    expect(controller.getState().actionError?.code).toBe('ENVIRONMENT_BUSY');
    const after = controller
      .getState()
      .environments.find((entry) => entry.id === FIXTURE_IDS.environment.running);
    expect(after).toMatchObject({
      state: 'running',
      revision: before?.revision,
      stateVersion: before?.stateVersion,
    });
    await controller.dispose();
  });

  it('refuses an unsupported/unverified catalog combination locally, without dispatch', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadDshVersions();
    await flush();
    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);

    await controller.switchVersion(FIXTURE_IDS.combination.unverified);
    await flush();

    expect(calls.some((call) => call.method === 'environments.switchCombination')).toBe(false);
    expect(controller.getState().actionError?.code).toBe('UNSUPPORTED_COMBINATION');
    await controller.dispose();
  });

  it('surfaces a controlled pre-commit failure and keeps the old generation usable', async () => {
    const { client } = createStubRendererClient((method, input) => {
      switch (method) {
        case 'catalog.list':
          return stubOk(FIXTURE_SEED.catalog);
        case 'environments.list':
          return stubOk(FIXTURE_SEED.environments);
        case 'versions.dsh':
          return stubOk({ operationId: 'op-versions-1' });
        case 'operations.get': {
          const operationId = (input as { operationId?: string }).operationId;
          if (operationId === 'op-versions-1') {
            return stubOk({
              id: 'op-versions-1',
              environmentId: null,
              kind: 'versions',
              phase: 'finished',
              status: 'succeeded',
              sequence: 1,
              output: supportedListing,
            });
          }
          return stubFail('NOT_FOUND');
        }
        case 'operations.subscribe':
          return stubOk({ subscriptionId: 'sub-1' });
        case 'operations.unsubscribe':
          return stubOk(null);
        case 'environments.switchCombination':
          return stubFail('DOWNLOAD_FAILED', 'the managed runtime download failed', true);
        default:
          return stubFail('INTERNAL_ERROR');
      }
    });
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadDshVersions();
    await flush();
    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);

    await controller.switchVersion(FIXTURE_IDS.combination.verified);
    await flush();

    expect(controller.getState().actionError?.code).toBe('DOWNLOAD_FAILED');
    const after = controller
      .getState()
      .environments.find((entry) => entry.id === FIXTURE_IDS.environment.stopped);
    expect(after).toMatchObject({ revision: 1, state: 'stopped' });
    await controller.dispose();
  });

  it('surfaces a terminal switch failure without moving the environment', async () => {
    const { client } = createStubRendererClient((method, input) => {
      switch (method) {
        case 'catalog.list':
          return stubOk(FIXTURE_SEED.catalog);
        case 'environments.list':
          return stubOk(FIXTURE_SEED.environments);
        case 'versions.dsh':
          return stubOk({ operationId: 'op-versions-1' });
        case 'environments.switchCombination':
          return stubOk({ operationId: 'op-switch-1' });
        case 'operations.get': {
          const operationId = (input as { operationId?: string }).operationId;
          if (operationId === 'op-versions-1') {
            return stubOk({
              id: 'op-versions-1',
              environmentId: null,
              kind: 'versions',
              phase: 'finished',
              status: 'succeeded',
              sequence: 1,
              output: supportedListing,
            });
          }
          return stubOk({
            id: 'op-switch-1',
            environmentId: FIXTURE_IDS.environment.stopped,
            kind: 'switch',
            phase: 'failed',
            status: 'failed',
            sequence: 2,
            error: {
              code: 'DOWNLOAD_FAILED',
              message: 'the managed runtime download failed',
              retryable: true,
            },
          });
        }
        case 'operations.subscribe':
          return stubOk({ subscriptionId: 'sub-1' });
        case 'operations.unsubscribe':
          return stubOk(null);
        default:
          return stubFail('INTERNAL_ERROR');
      }
    });
    const controller = new RendererController({ client });
    await controller.load();
    await controller.loadDshVersions();
    await flush();
    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);

    await controller.switchVersion(FIXTURE_IDS.combination.verified);
    await flush();

    expect(controller.getState().trackedOperation?.kind).toBe('switch');
    expect(controller.getState().trackedOperation?.status).toBe('failed');
    expect(controller.getState().actionError?.code).toBe('DOWNLOAD_FAILED');
    const after = controller
      .getState()
      .environments.find((entry) => entry.id === FIXTURE_IDS.environment.stopped);
    expect(after).toMatchObject({ revision: 1, state: 'stopped' });
    await controller.dispose();
  });
});

const switchState = (patch: Partial<RendererState> = {}): RendererState => ({
  ...INITIAL_STATE,
  phase: 'ready',
  environments: FIXTURE_SEED.environments,
  selectedEnvironmentId: FIXTURE_IDS.environment.stopped,
  catalog: FIXTURE_SEED.catalog,
  dshVersions: supportedListing,
  ...patch,
});

interface RenderedButton {
  readonly attrs: string;
  readonly text: string;
}

const buttons = (html: string): RenderedButton[] =>
  [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    attrs: match[1] ?? '',
    text: (match[2] ?? '').replace(/<[^>]*>/g, '').trim(),
  }));

describe('SwitchVersion markup', () => {
  it('offers a switch only to the supported combination, never to unknown ones', () => {
    const html = renderSwitchVersion({
      state: switchState(),
      actions: noopActions,
    });
    expect(html).toContain('切换版本（同环境）');
    expect(html).toContain('已支持组合');
    expect(html).toContain(FIXTURE_IDS.combination.verified);
    expect(buttons(html).filter((button) => button.text === '切换到此组合')).toHaveLength(1);
    // The verified-but-not-supported and unverified combinations are not offered.
    expect(html).not.toContain(FIXTURE_IDS.combination.win32);
    expect(html).not.toContain(FIXTURE_IDS.combination.unverified);
  });

  it('disables the switch and asks the user to stop a running environment', () => {
    const html = renderSwitchVersion({
      state: switchState({
        selectedEnvironmentId: FIXTURE_IDS.environment.running,
      }),
      actions: noopActions,
    });
    expect(html).toContain('请先停止环境');
    const switchButton = buttons(html).find((button) => button.text === '切换到此组合');
    expect(switchButton).toBeDefined();
    expect(switchButton?.attrs).toContain('disabled');
  });

  it('asks for the audited listing instead of guessing while it is unknown', () => {
    const html = renderSwitchVersion({
      state: switchState({ dshVersions: null }),
      actions: noopActions,
    });
    expect(html).toContain('请先查询已支持组合');
    expect(html).toContain('查询已支持组合');
    expect(buttons(html).filter((button) => button.text === '切换到此组合')).toHaveLength(0);
  });

  it('shows a controlled, sanitized error hint instead of the raw message', () => {
    const html = renderSwitchVersion({
      state: switchState({
        actionError: {
          code: 'UNSUPPORTED_COMBINATION',
          message: 'raw port message must not lead',
          retryable: false,
        },
      }),
      actions: noopActions,
    });
    expect(html).toContain('该组合不是已支持组合');
    expect(html).toContain('UNSUPPORTED_COMBINATION');
  });

  it('does not mislabel an unrelated action error (for example the listing query) as a switch failure', () => {
    const html = renderSwitchVersion({
      state: switchState({
        actionError: {
          code: 'NETWORK_UNAVAILABLE',
          message: 'the registry is unreachable',
          retryable: true,
        },
      }),
      actions: noopActions,
    });
    expect(html).toContain('NETWORK_UNAVAILABLE');
    expect(html).not.toContain('切换未提交');
  });

  it('shows the switch-specific hint for a terminal switch failure', () => {
    const html = renderSwitchVersion({
      state: switchState({
        trackedOperation: {
          operationId: 'op-switch-1',
          kind: 'switch',
          phase: 'failed',
          status: 'failed',
          sequence: 2,
          progress: null,
          environmentId: FIXTURE_IDS.environment.stopped,
          error: {
            code: 'DOWNLOAD_FAILED',
            message: 'the managed runtime download failed',
            retryable: true,
          },
          output: null,
        },
        actionError: {
          code: 'DOWNLOAD_FAILED',
          message: 'the managed runtime download failed',
          retryable: true,
        },
      }),
      actions: noopActions,
    });
    expect(html).toContain('运行时下载或校验失败');
    expect(html).toContain('DOWNLOAD_FAILED');
  });

  it('renders nothing when no environment is selected', () => {
    const html = renderSwitchVersion({
      state: switchState({ selectedEnvironmentId: null }),
      actions: noopActions,
    });
    expect(html).toBe('');
  });
});

describe('RendererController generations.restore downgrade warning', () => {
  const warning =
    'the target generation runs DSH 0.1.4, older than the last successfully started DSH 0.1.5-rc.2; workspace data written by the newer version is not guaranteed to be compatible';

  const restoreClient = (compatWarning: string | null) =>
    createStubRendererClient((method, input) => {
      switch (method) {
        case 'catalog.list':
          return stubOk(FIXTURE_SEED.catalog);
        case 'environments.list':
          return stubOk(FIXTURE_SEED.environments);
        case 'generations.restore':
          return stubOk({ operationId: 'op-restore-1' });
        case 'operations.get': {
          const operationId = (input as { operationId?: string }).operationId;
          if (operationId !== 'op-restore-1') {
            return stubFail('NOT_FOUND');
          }
          return stubOk({
            id: 'op-restore-1',
            environmentId: FIXTURE_IDS.environment.stopped,
            kind: 'restore',
            phase: 'finished',
            status: 'succeeded',
            sequence: 1,
            output: {
              generationId: 'gen-0000000000000002',
              environmentId: FIXTURE_IDS.environment.stopped,
              compositionDigest: 'a'.repeat(64),
              profileName: null,
              active: true,
              createdAt: '2026-09-20T00:00:00.000Z',
              dshCompatibilityWarning: compatWarning,
            },
          });
        }
        case 'operations.subscribe':
          return stubOk({ subscriptionId: 'sub-1' });
        case 'operations.unsubscribe':
          return stubOk(null);
        default:
          return stubFail('INTERNAL_ERROR');
      }
    });

  it('stores the non-blocking downgrade warning from the terminal restore output', async () => {
    const { client } = restoreClient(warning);
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);
    await controller.restoreGeneration('gen-0000000000000002');
    await flush();
    expect(controller.getState().restoreWarning).toBe(warning);
    await controller.dispose();
  });

  it('stores no warning for the same-version / unknown-version case', async () => {
    const { client } = restoreClient(null);
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(FIXTURE_IDS.environment.stopped);
    await controller.restoreGeneration('gen-0000000000000002');
    await flush();
    expect(controller.getState().restoreWarning).toBeNull();
    await controller.dispose();
  });
});

describe('PluginInstall restore downgrade warning markup', () => {
  it('shows the raw warning non-blockingly without undoing data', () => {
    const html = renderPluginInstall({
      state: {
        ...INITIAL_STATE,
        phase: 'ready',
        environments: FIXTURE_SEED.environments,
        selectedEnvironmentId: FIXTURE_IDS.environment.stopped,
        restoreWarning: 'older DSH target; workspace data may not be compatible',
      },
      actions: noopActions,
    });
    expect(html).toContain('数据兼容提示（非阻断）');
    expect(html).toContain('older DSH target; workspace data may not be compatible');
    expect(html).toContain('不改写任何已写数据');
  });

  it('shows no warning when the contract reports none', () => {
    const html = renderPluginInstall({
      state: {
        ...INITIAL_STATE,
        phase: 'ready',
        environments: FIXTURE_SEED.environments,
        selectedEnvironmentId: FIXTURE_IDS.environment.stopped,
        restoreWarning: null,
      },
      actions: noopActions,
    });
    expect(html).not.toContain('数据兼容提示');
  });
});
