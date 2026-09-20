/**
 * Selected-environment detail and action buttons (T006a).
 *
 * Start/stop disable themselves from the environment state so the UI cannot
 * issue an obviously-busy command; the contract still enforces the same rule in
 * main. `expectedRevision` is taken from `EnvironmentSummary.revision`.
 */
import type { ReactElement } from 'react';
import { ENVIRONMENT_STATE_LABELS, shortDigest } from '../format.js';
import {
  canStart,
  canStop,
  isOperationTerminal,
  selectedEnvironment,
  type RendererActions,
  type RendererState,
} from '../view-model.js';

export interface EnvironmentDetailProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function EnvironmentDetail({
  state,
  actions,
}: EnvironmentDetailProps): ReactElement | null {
  const environment = selectedEnvironment(state);
  if (environment === null) {
    return null;
  }
  const tracked = state.trackedOperation;
  const busy = tracked !== null && !isOperationTerminal(tracked.status);
  return (
    <section aria-labelledby="detail-heading" className="panel">
      <h2 id="detail-heading">环境详情</h2>
      <dl className="environment-detail">
        <dt>名称</dt>
        <dd>{environment.name}</dd>
        <dt>环境 ID</dt>
        <dd>
          <code>{environment.id}</code>
        </dd>
        <dt>状态</dt>
        <dd>{ENVIRONMENT_STATE_LABELS[environment.state]}</dd>
        <dt>组成修订</dt>
        <dd>{environment.revision}</dd>
        <dt>状态版本</dt>
        <dd>{environment.stateVersion}</dd>
        <dt>组成摘要</dt>
        <dd>
          {environment.compositionDigest === null
            ? '无活动代际'
            : shortDigest(environment.compositionDigest)}
        </dd>
      </dl>
      <div className="action-row">
        <button
          type="button"
          disabled={!canStart(environment) || busy}
          onClick={() => {
            actions.startSelected();
          }}
        >
          启动
        </button>
        <button
          type="button"
          disabled={!canStop(environment) || busy}
          onClick={() => {
            actions.stopSelected();
          }}
        >
          停止
        </button>
        <button
          type="button"
          disabled={environment.state !== 'running'}
          onClick={() => {
            actions.openWebUI();
          }}
        >
          打开 WebUI（主进程原生打开）
        </button>
        <button
          type="button"
          onClick={() => {
            actions.exportDiagnostics();
          }}
        >
          导出诊断
        </button>
      </div>
      {state.webUIOrigin !== null && (
        <p className="webui-origin">
          WebUI loopback 地址：<code>{state.webUIOrigin}</code>（由主进程打开；renderer
          不接收携带 token 的 URL）
        </p>
      )}
      {state.exportResult !== null && (
        <p className="export-result">
          最近导出：<code>{state.exportResult.exportId}</code>
          {`（exported=${String(state.exportResult.exported)}, redacted=${String(
            state.exportResult.redacted,
          )}；不含本地路径）`}
        </p>
      )}
    </section>
  );
}
