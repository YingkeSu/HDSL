import type { ReactElement } from 'react';
import { ENVIRONMENT_STATE_LABELS, OPERATION_STATUS_LABELS } from '../format.js';
import {
  canStart,
  canStop,
  isBusy,
  selectedEnvironment,
  type RendererActions,
  type RendererState,
} from '../view-model.js';
import { Icon } from './Icon.js';

export function LaunchBar({
  state,
  actions,
  onShowTasks,
}: {
  readonly state: RendererState;
  readonly actions: RendererActions;
  readonly onShowTasks: () => void;
}): ReactElement {
  const environment = selectedEnvironment(state);
  const running = environment?.state === 'running';
  const busy = isBusy(state);
  const operation = state.trackedOperation;
  const taskLabel =
    state.trackingError !== null
      ? '状态获取失败 · 查看任务'
      : state.pendingOperationId !== null
        ? '正在获取任务状态…'
        : operation !== null
          ? `最近操作：${OPERATION_STATUS_LABELS[operation.status]}`
          : '暂无进行中的任务';
  const label = running
    ? '打开工作界面'
    : environment?.state === 'error'
      ? '重试启动'
      : environment?.state === 'starting'
        ? '启动中…'
        : environment?.state === 'creating'
          ? '创建中…'
          : environment?.state === 'stopping'
            ? '停止中…'
            : '启动环境';
  return (
    <footer className="launchbar" aria-label="环境启动操作">
      <button
        className={`task-link text-button${state.trackingError !== null ? ' danger' : ''}`}
        type="button"
        onClick={onShowTasks}
      >
        {taskLabel}
      </button>
      <div className="launch-context">
        <strong>{environment?.name ?? '尚未选择环境'}</strong>
        <span>
          {environment === null ? '请先创建环境' : ENVIRONMENT_STATE_LABELS[environment.state]}
        </span>
      </div>
      <div className="launch-actions">
        {environment !== null && canStop(environment) && (
          <button
            type="button"
            disabled={busy || state.phase !== 'ready'}
            onClick={() => {
              actions.stopSelected();
            }}
          >
            <Icon name="stop" />
            停止
          </button>
        )}
        <button
          type="button"
          className="launch-button"
          aria-label={label}
          disabled={
            environment === null ||
            state.phase !== 'ready' ||
            busy ||
            (!running && !canStart(environment))
          }
          onClick={() => {
            if (running) actions.openWebUI();
            else actions.startSelected();
          }}
        >
          <Icon name="play" />
          <span>
            {label}
            <small>{environment?.name ?? '选择你的工作环境'}</small>
          </span>
        </button>
      </div>
    </footer>
  );
}
