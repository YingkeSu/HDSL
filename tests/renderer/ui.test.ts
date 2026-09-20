/**
 * Renderer markup/accessibility matrix (T006a).
 *
 * Renders `AppView` with `react-dom/server` (no DOM dependency) and inspects
 * the produced HTML for the empty/loading/failed/running/in-progress states and
 * their accessible names. Keyboard operability is structural here (native
 * `button`/`form`/`label`/`select`/`progress`); the interactive pass is recorded
 * in the demo preview and the PR report, not claimed as Electron acceptance.
 */
import type { EnvironmentSummary } from '@hdsl/contracts';
import { describe, expect, it } from 'vitest';
import { renderAppView } from '../../apps/desktop/src/renderer/testing/render-markup.js';
import {
  INITIAL_STATE,
  type RendererActions,
  type RendererState,
} from '../../apps/desktop/src/renderer/view-model.js';

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
};

const environment = (
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary => ({
  id: 'env-1',
  name: '演示环境',
  revision: 2,
  stateVersion: 3,
  state: 'stopped',
  activeGenerationId: 'gen-1',
  compositionDigest: 'a'.repeat(64),
  ...overrides,
});

const state = (patch: Partial<RendererState>): RendererState => ({
  ...INITIAL_STATE,
  phase: 'ready',
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

const buttonNamed = (html: string, text: string): RenderedButton | undefined =>
  buttons(html).find((button) => button.text === text);

describe('AppView state matrix', () => {
  it('shows the mock-data banner only for an explicit demo client', () => {
    const demoHtml = renderAppView({ state: state({ demo: true }), actions: noopActions });
    expect(demoHtml).toContain('演示模式');
    expect(demoHtml).toContain('不是真实 DSH 进程或 Electron 实机运行');
    const productionHtml = renderAppView({ state: state({ demo: false }), actions: noopActions });
    expect(productionHtml).not.toContain('演示模式');
  });

  it('renders an empty state when no environment exists', () => {
    const html = renderAppView({ state: state({ environments: [] }), actions: noopActions });
    expect(html).toContain('还没有环境');
  });

  it('renders a loading state before the catalog is ready', () => {
    const html = renderAppView({
      state: state({ phase: 'loading' }),
      actions: noopActions,
    });
    expect(html).toContain('正在加载环境');
  });

  it('renders a load failure as a live alert', () => {
    const html = renderAppView({
      state: state({
        phase: 'failed',
        loadError: { code: 'INTERNAL_ERROR', message: 'unclassified internal error', retryable: true },
      }),
      actions: noopActions,
    });
    expect(html).toMatch(/role="alert"[\s\S]*加载失败/);
    expect(html).toContain('INTERNAL_ERROR');
  });

  it('disables start and enables stop for a running environment', () => {
    const html = renderAppView({
      state: state({ environments: [environment({ state: 'running' })], selectedEnvironmentId: 'env-1' }),
      actions: noopActions,
    });
    expect(buttonNamed(html, '启动')?.attrs).toContain('disabled');
    expect(buttonNamed(html, '停止')?.attrs ?? '').not.toContain('disabled');
    expect(buttonNamed(html, '打开 WebUI（主进程原生打开）')?.attrs ?? '').not.toContain(
      'disabled',
    );
  });

  it('enables start and disables WebUI for a stopped environment', () => {
    const html = renderAppView({
      state: state({ environments: [environment()], selectedEnvironmentId: 'env-1' }),
      actions: noopActions,
    });
    expect(buttonNamed(html, '启动')?.attrs ?? '').not.toContain('disabled');
    expect(buttonNamed(html, '停止')?.attrs).toContain('disabled');
    expect(buttonNamed(html, '打开 WebUI（主进程原生打开）')?.attrs).toContain('disabled');
  });

  it('renders progress with a real progressbar value when progress is known', () => {
    const html = renderAppView({
      state: state({
        environments: [environment({ state: 'running' })],
        selectedEnvironmentId: 'env-1',
        trackedOperation: {
          operationId: 'op-1',
          kind: 'start',
          phase: 'downloading',
          status: 'running',
          sequence: 3,
          progress: 40,
          environmentId: 'env-1',
          error: null,
        },
      }),
      actions: noopActions,
    });
    expect(html).toMatch(/<progress[^>]*max="100"[^>]*value="40"/);
    expect(html).toContain('40%');
  });

  it('does not invent a percentage when progress is unknown', () => {
    const html = renderAppView({
      state: state({
        trackedOperation: {
          operationId: 'op-1',
          kind: 'start',
          phase: 'starting',
          status: 'running',
          sequence: 1,
          progress: null,
          environmentId: 'env-1',
          error: null,
        },
      }),
      actions: noopActions,
    });
    expect(html).toContain('进度未知');
    expect(html).not.toContain('<progress');
  });

  it('renders a failed operation with its sanitized code and retry hint', () => {
    const html = renderAppView({
      state: state({
        trackedOperation: {
          operationId: 'op-1',
          kind: 'start',
          phase: 'failed',
          status: 'failed',
          sequence: 4,
          progress: null,
          environmentId: 'env-1',
          error: { code: 'START_TIMEOUT', message: 'the managed process did not become ready in time', retryable: true },
        },
      }),
      actions: noopActions,
    });
    expect(html).toMatch(/role="alert"[\s\S]*START_TIMEOUT/);
    expect(html).toContain('（可重试）');
  });

  it('renders a poll failure and an explicit retry entry when tracking is paused', () => {
    const html = renderAppView({
      state: state({
        trackedOperation: {
          operationId: 'op-1',
          kind: 'start',
          phase: 'starting',
          status: 'running',
          sequence: 1,
          progress: null,
          environmentId: 'env-1',
          error: null,
        },
        trackingError: {
          code: 'INTERNAL_ERROR',
          message: 'unclassified internal error',
          retryable: true,
        },
        trackingPaused: true,
      }),
      actions: noopActions,
    });
    expect(html).toMatch(/role="alert"[\s\S]*获取操作状态失败/);
    expect(buttonNamed(html, '重试获取状态')).toBeDefined();
  });

  it('disables command buttons while a command is pending', () => {
    const html = renderAppView({
      state: state({
        environments: [environment()],
        selectedEnvironmentId: 'env-1',
        createName: '待创建环境',
        commandPending: true,
      }),
      actions: noopActions,
    });
    expect(buttonNamed(html, '启动')?.attrs).toContain('disabled');
    expect(buttonNamed(html, '停止')?.attrs).toContain('disabled');
    expect(buttonNamed(html, '创建')?.attrs).toContain('disabled');
  });

  it('shows the loopback WebUI origin and the redacted export summary', () => {
    const html = renderAppView({
      state: state({
        environments: [environment({ state: 'running' })],
        selectedEnvironmentId: 'env-1',
        webUIOrigin: 'http://127.0.0.1:53123',
        exportResult: { exportId: 'export-1', exported: true, redacted: true },
      }),
      actions: noopActions,
    });
    expect(html).toContain('http://127.0.0.1:53123');
    expect(html).toContain('export-1');
    expect(html).toContain('redacted=true');
  });
});

describe('AppView accessibility basics', () => {
  it('associates every form control with a label', () => {
    const html = renderAppView({ state: state({ catalog: [] }), actions: noopActions });
    expect(html).toContain('for="create-name"');
    expect(html).toContain('id="create-name"');
    expect(html).toContain('for="create-combination"');
    expect(html).toContain('id="create-combination"');
  });

  it('marks the selected environment button with aria-pressed', () => {
    const html = renderAppView({
      state: state({
        environments: [environment({ id: 'env-1' }), environment({ id: 'env-2', name: '另一个' })],
        selectedEnvironmentId: 'env-2',
      }),
      actions: noopActions,
    });
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[\s\S]*演示环境/);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[\s\S]*另一个/);
  });

  it('does not remove interactive elements from the tab order', () => {
    const html = renderAppView({
      state: state({ environments: [environment({ state: 'running' })], selectedEnvironmentId: 'env-1' }),
      actions: noopActions,
    });
    expect(html).not.toContain('tabindex="-1"');
    expect(html).not.toContain('tabIndex="-1"');
  });
});
