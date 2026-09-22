/**
 * Real React component markup acceptance (independent QA).
 *
 * This file exercises the DOM-free real component render path
 * (`renderAppView` -> `react-dom/server`) for empty / failure / progress /
 * accessibility state. Live Electron interaction is covered in tests/e2e;
 * the vanilla demo is a separate implementation and is not evidence here.
 */
import { describe, expect, it } from 'vitest';
import { contractError } from '@hdsl/contracts';
import { renderAppView } from '../../../apps/desktop/src/renderer/testing/render-markup.js';
import { INITIAL_STATE, type RendererActions, type RendererState } from '../../../apps/desktop/src/renderer/view-model.js';
import { FIXTURE_SEED } from '@hdsl/contracts/testing';

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
  selectPlugin: () => undefined,
  cancelPluginSearch: () => undefined,
};

const state = (patch: Partial<RendererState>): RendererState => ({ ...INITIAL_STATE, ...patch });

describe('renderer static markup acceptance (DOM-free real React)', () => {
  it('renders an explicit empty state with no alerts', () => {
    const html = renderAppView({ state: state({ phase: 'ready' }), actions });

    expect(html).toContain('还没有环境');
    expect(html).toContain('暂无已核验的运行时组合');
    expect(html).not.toContain('role="alert"');
  });

  it('renders a failure state as role="alert"', () => {
    const html = renderAppView({
      state: state({ phase: 'failed', loadError: contractError('INTERNAL_ERROR', 'controlled failure') }),
      actions,
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain('加载失败');
  });

  it('exposes native, keyboard-operable controls (button/label/select/progress)', () => {
    const html = renderAppView({
      state: state({
        phase: 'ready',
        catalog: FIXTURE_SEED.catalog,
        environments: FIXTURE_SEED.environments,
        selectedEnvironmentId: FIXTURE_SEED.environments[1]?.id ?? null,
        createCombinationId: FIXTURE_SEED.catalog[0]?.id ?? null,
        trackedOperation: {
          operationId: 'op-1',
          kind: 'start',
          phase: 'running',
          status: 'running',
          sequence: 2,
          progress: 55,
          environmentId: FIXTURE_SEED.environments[1]?.id ?? null,
          output: null,
          error: null,
        },
      }),
      actions,
    });

    expect(html).toContain('<button type="button" aria-pressed="true"');
    expect(html).toContain('<select');
    expect(html).toContain('<label');
    expect(html).toContain('<progress');
    expect(html).toContain('value="55"');
    expect(html).toContain('max="100"');
  });

  it('does not invent a percentage when progress is unknown', () => {
    const html = renderAppView({
      state: state({
        phase: 'ready',
        trackedOperation: {
          operationId: 'op-1',
          kind: 'start',
          phase: 'running',
          status: 'running',
          sequence: 1,
          progress: null,
          environmentId: null,
          output: null,
          error: null,
        },
      }),
      actions,
    });

    expect(html).toContain('进度未知，暂不显示百分比');
    expect(html).not.toContain('<progress');
  });
});
