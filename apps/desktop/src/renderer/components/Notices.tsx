/**
 * Status/notice region (T006a).
 *
 * Errors are announced with `role="alert"`; a successful notice uses a polite
 * live region. Only contract-provided, already-sanitized text is rendered.
 */
import type { ReactElement } from 'react';
import { describeError, NO_INSTALLABLE_COMBINATION_NOTICE } from '../format.js';
import type { RendererState } from '../view-model.js';

export function Notices({ state }: { readonly state: RendererState }): ReactElement {
  return (
    <div className="notices">
      {state.phase === 'ready' && state.catalog.length === 0 && (
        <p role="note" className="notice">
          {NO_INSTALLABLE_COMBINATION_NOTICE}
        </p>
      )}
      {state.loadError !== null && (
        <p role="alert" className="notice notice-error">
          加载失败：{describeError(state.loadError)}
        </p>
      )}
      {state.actionError !== null && (
        <p role="alert" className="notice notice-error">
          操作失败：{describeError(state.actionError)}
        </p>
      )}
      {state.notice !== null && (
        <p role="status" aria-live="polite" className="notice">
          {state.notice}
        </p>
      )}
    </div>
  );
}

/**
 * Visible marker for the explicitly injected mock client.
 *
 * The demo must never be presented as a real DSH/Electron run.
 */
export function DemoBanner(): ReactElement {
  return (
    <p role="note" className="demo-banner">
      演示模式：以下为模拟数据，不是真实 DSH 进程或 Electron 实机运行结果。
    </p>
  );
}
