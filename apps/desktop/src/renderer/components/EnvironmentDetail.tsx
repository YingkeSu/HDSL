import type { ReactElement } from 'react';
import { ENVIRONMENT_STATE_LABELS, shortDigest } from '../format.js';
import { selectedEnvironment, type RendererActions, type RendererState } from '../view-model.js';

export interface EnvironmentDetailProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function EnvironmentDetail({ state, actions }: EnvironmentDetailProps): ReactElement | null {
  const environment = selectedEnvironment(state);
  if (environment === null) return null;
  return (
    <section aria-labelledby="detail-heading" className="panel environment-overview">
      <div className="card-heading">
        <span className="muted">当前环境</span>
        <span className={`state-badge state-${environment.state}`}>
          {ENVIRONMENT_STATE_LABELS[environment.state]}
        </span>
      </div>
      <div className="environment-identity">
        <span className="environment-initial" aria-hidden="true">
          {Array.from(environment.name)[0]}
        </span>
        <div>
          <h2 id="detail-heading">{environment.name}</h2>
          <p className="muted">
            {environment.state === 'running'
              ? '环境已就绪，可以打开工作界面。'
              : environment.state === 'stopped'
                ? '环境已保存，启动后即可开始工作。'
                : environment.state === 'error'
                  ? '环境发生错误，请检查任务结果后重试。'
                  : '操作正在进行，可在任务中查看进度。'}
          </p>
        </div>
      </div>
      <div className="overview-meta">
        <span>
          组成修订 <strong>{environment.revision}</strong>
        </span>
        <span>独立运行数据</span>
      </div>
      <details className="technical-details" key={environment.id}>
        <summary>环境详情</summary>
        <dl className="environment-detail">
          <dt>环境 ID</dt>
          <dd>
            <code>{environment.id}</code>
          </dd>
          <dt>状态版本</dt>
          <dd>{environment.stateVersion}</dd>
          <dt>组成摘要</dt>
          <dd>
            {environment.compositionDigest === null
              ? '无活动代际'
              : shortDigest(environment.compositionDigest)}
          </dd>
        </dl>
        <button
          type="button"
          disabled={state.commandPending}
          onClick={() => {
            actions.exportDiagnostics();
          }}
        >
          导出诊断
        </button>
      </details>
      {state.webUIOrigin !== null && (
        <p className="webui-origin">
          工作界面已打开：<code>{state.webUIOrigin}</code>
        </p>
      )}
      {state.exportResult !== null && (
        <p className="export-result">
          {state.exportResult.exported ? '诊断已导出' : '诊断未导出'}
          {state.exportResult.redacted ? ' · 已脱敏' : ''} ·{' '}
          <code>{state.exportResult.exportId}</code>
        </p>
      )}
    </section>
  );
}
