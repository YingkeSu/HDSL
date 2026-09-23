/**
 * Renderer removal flow (issue #77, S3): installed list -> precise selection ->
 * remove preview -> three branches (remove / retention / blocked) -> apply.
 *
 * Runs against the TEST-ONLY reference runtime with a seeded installed view and
 * remove plan. This proves renderer semantics (exact target, revision binding,
 * honest blocked/builtin copy), never real removal behavior.
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_IDS, FIXTURE_SEED } from '@hdsl/contracts/testing';
import type { ChangePlan, InstalledPluginsView } from '@hdsl/contracts';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import { renderPluginRemoval } from '../../apps/desktop/src/renderer/testing/render-markup.js';
import { INITIAL_STATE, type RendererActions, type RendererState } from '../../apps/desktop/src/renderer/view-model.js';
import { createTestRendererClient } from './support/contract-client.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

const ENVIRONMENT_ID = FIXTURE_IDS.environment.stopped;
const PLUGIN_ID = 'hdsl-plugin-e2e-fixture';

const installedView = (revision: number): InstalledPluginsView => ({
  environmentId: ENVIRONMENT_ID,
  revision,
  generationId: 'gen-plugin-00000001',
  plugins: [
    { id: '@deepseek-ai/dsh-base', version: '0.1.5-rc.2', sha256: 'a'.repeat(64), isBuiltin: true, enabledBundle: true, source: null },
    {
      id: PLUGIN_ID,
      version: '0.0.1',
      sha256: 'b'.repeat(64),
      isBuiltin: false,
      enabledBundle: true,
      source: { owner: 'YingkeSu', name: 'hdsl-plugin-e2e-fixture', commitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838' },
    },
  ],
});

const removePlan = (overrides: Partial<ChangePlan> = {}): ChangePlan => ({
  planId: 'plan-0000000000000002',
  environmentId: ENVIRONMENT_ID,
  baseRevision: 1,
  action: { kind: 'remove', pluginId: PLUGIN_ID },
  createdAt: '2026-09-20T00:00:00.000Z',
  expiresAt: '2026-09-20T00:15:00.000Z',
  sourceLock: null,
  scriptAssessment: 'none-detected',
  scripts: [],
  requiresBuildAuthorization: false,
  riskItems: ['no static reference does not prove the removal is free of impact'],
  removals: [`dependency entry ${PLUGIN_ID}@0.0.1`, `enabled bundle reference ${PLUGIN_ID}`],
  retention: ['user patch layer (home cordis.patch.yml)', 'environment data (home/ and data/)', 'shared/transitive dependencies remain in the profile lock'],
  blockingReferences: [],
  executor: null,
  planInputsDigest: 'd'.repeat(64),
  ...overrides,
});

const actions: RendererActions = {
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
};

const state = (patch: Partial<RendererState>): RendererState => ({ ...INITIAL_STATE, ...patch });

describe('RendererController plugin removal', () => {
  it('lists installed plugins, previews the exact selected target and applies it', async () => {
    const { client, calls } = createTestRendererClient({
      ...FIXTURE_SEED,
      installedPlugins: { [ENVIRONMENT_ID]: installedView(1) },
    });
    const controller = new RendererController({ client });
    await controller.load();
    const stopped = controller.getState().environments.find((environment) => environment.id === ENVIRONMENT_ID);
    expect(stopped).toBeDefined();
    if (stopped === undefined) {
      return;
    }
    controller.selectEnvironment(stopped.id);

    controller.loadInstalledPlugins();
    await flush();
    expect(controller.getState().installedPlugins?.plugins).toHaveLength(2);

    controller.selectInstalledPlugin(PLUGIN_ID);
    expect(controller.getState().selectedInstalledPluginId).toBe(PLUGIN_ID);

    await controller.previewPluginRemoval();
    await flush();
    const preview = calls.find((call) => call.method === 'changes.preview');
    expect(preview?.input).toMatchObject({
      environmentId: stopped.id,
      expectedRevision: stopped.revision,
      action: { kind: 'remove', pluginId: PLUGIN_ID },
    });
    const plan = controller.getState().changePlan;
    expect(plan?.action).toEqual({ kind: 'remove', pluginId: PLUGIN_ID });
    expect(plan?.sourceLock).toBeNull();
    expect(plan?.removals.length).toBeGreaterThan(0);
    expect(plan?.retention.length).toBeGreaterThan(0);

    await controller.applyPluginChange();
    await flush();
    const apply = calls.find((call) => call.method === 'changes.apply');
    expect(apply?.input).toMatchObject({ environmentId: stopped.id, planId: plan?.planId });
    expect(controller.getState().changeApplication).not.toBeNull();
    expect(controller.getState().lastChangeAction).toBe('remove');

    await controller.dispose();
  });

  it('keeps a blocked remove plan visible (real static reference) and never auto-applies', async () => {
    const blocked = removePlan({
      blockingReferences: [{ pluginId: PLUGIN_ID, kind: 'userPatch', detail: 'home/cordis.patch.yml' }],
    });
    const { client } = createTestRendererClient({
      ...FIXTURE_SEED,
      installedPlugins: { [ENVIRONMENT_ID]: installedView(1) },
      removal: { plan: blocked },
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(ENVIRONMENT_ID);
    controller.loadInstalledPlugins();
    await flush();
    controller.selectInstalledPlugin(PLUGIN_ID);
    await controller.previewPluginRemoval();
    await flush();
    const plan = controller.getState().changePlan;
    expect(plan?.blockingReferences).toHaveLength(1);
    expect(controller.getState().changeApplication).toBeNull();
    await controller.dispose();
  });

  it('surfaces BUILTIN_BUNDLE_PROTECTED as a failed preview with no plan and no side effect', async () => {
    const { client } = createTestRendererClient({
      ...FIXTURE_SEED,
      installedPlugins: { [ENVIRONMENT_ID]: installedView(1) },
      removal: { failure: 'BUILTIN_BUNDLE_PROTECTED' },
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(ENVIRONMENT_ID);
    controller.loadInstalledPlugins();
    await flush();
    controller.selectInstalledPlugin('@deepseek-ai/dsh-base');
    await controller.previewPluginRemoval();
    await flush();
    expect(controller.getState().changePlan).toBeNull();
    expect(controller.getState().actionError?.code).toBe('BUILTIN_BUNDLE_PROTECTED');
    await controller.dispose();
  });

  it('renders a pre-S3 installed plugin (source: null) and allows removal (service axis is informational)', async () => {
    const preS3View: InstalledPluginsView = {
      ...installedView(1),
      plugins: [
        { id: PLUGIN_ID, version: '0.0.1', sha256: 'b'.repeat(64), isBuiltin: false, enabledBundle: true, source: null },
      ],
    };
    const { client } = createTestRendererClient({
      ...FIXTURE_SEED,
      installedPlugins: { [ENVIRONMENT_ID]: preS3View },
      removal: { plan: removePlan() },
    });
    const controller = new RendererController({ client });
    await controller.load();
    controller.selectEnvironment(ENVIRONMENT_ID);
    controller.loadInstalledPlugins();
    await flush();
    expect(controller.getState().installedPlugins?.plugins[0]?.source).toBeNull();
    controller.selectInstalledPlugin(PLUGIN_ID);
    await controller.previewPluginRemoval();
    await flush();
    expect(controller.getState().changePlan?.blockingReferences).toEqual([]);
    const html = renderPluginRemoval({
      state: state({
        phase: 'ready',
        installedPlugins: controller.getState().installedPlugins,
        selectedInstalledPluginId: PLUGIN_ID,
        changePlan: controller.getState().changePlan,
      }),
      actions,
    });
    expect(html).toContain('确认卸载');
    await controller.dispose();
  });
});

describe('renderer removal markup (DOM-free real React)', () => {
  it('shows removals, retention and a confirm button for a clean plan', () => {
    const html = renderPluginRemoval({
      state: state({
        phase: 'ready',
        installedPlugins: installedView(1),
        selectedInstalledPluginId: PLUGIN_ID,
        changePlan: removePlan(),
      }),
      actions,
    });
    expect(html).toContain('将移除');
    expect(html).toContain('将保留');
    expect(html).toContain('确认卸载');
    expect(html).toContain('shared/transitive dependencies remain in the profile lock');
  });

  it('shows the static-reference blocker message and NO confirm button for a blocked plan', () => {
    const html = renderPluginRemoval({
      state: state({
        phase: 'ready',
        changePlan: removePlan({
          blockingReferences: [{ pluginId: PLUGIN_ID, kind: 'userPatch', detail: 'home/cordis.patch.yml' }],
        }),
      }),
      actions,
    });
    expect(html).toContain('移除会破坏其它 bundle 或配置解析');
    expect(html).not.toContain('确认卸载');
    expect(html).not.toContain('插件安全');
    expect(html).not.toContain('无法验证服务依赖');
  });

  it('shows the builtin protection copy and no confirm button', () => {
    const html = renderPluginRemoval({
      state: state({
        phase: 'ready',
        actionError: { code: 'BUILTIN_BUNDLE_PROTECTED', message: 'protected', retryable: false },
      }),
      actions,
    });
    expect(html).toContain('内置 bundle');
    expect(html).toContain('不能卸载');
    expect(html).not.toContain('确认卸载');
  });

  it('shows a retryable network failure with the confirm action still available for a new attempt', () => {
    const html = renderPluginRemoval({
      state: state({
        phase: 'ready',
        changePlan: removePlan(),
        actionError: { code: 'NETWORK_UNAVAILABLE', message: 'network error', retryable: true },
      }),
      actions,
    });
    expect(html).toContain('网络不可用');
    expect(html).toContain('确认卸载');
  });

  it('never claims a registry rate limit on the removal path (no reliable signal exists, #95)', () => {
    const html = renderPluginRemoval({
      state: state({
        phase: 'ready',
        actionError: { code: 'RATE_LIMITED', message: 'unexpected', retryable: true },
      }),
      actions,
    });
    expect(html).not.toContain('registry 限流');
  });
});
