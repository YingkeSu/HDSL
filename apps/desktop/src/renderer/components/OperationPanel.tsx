/**
 * Tracked-operation progress (T006a).
 *
 * Uses the native `<progress>` element so assistive technology gets a real
 * `progressbar` with `value`/`max`; when the contract reports no progress the
 * UI says so instead of inventing a percentage. The cancel button is only shown
 * while the operation is not terminal (`CANNOT_CANCEL` otherwise).
 */
import type { ReactElement } from 'react';
import { clampProgress, describeError, OPERATION_KIND_LABELS, OPERATION_STATUS_LABELS } from '../format.js';
import { isOperationTerminal, type RendererActions, type RendererState } from '../view-model.js';

export interface OperationPanelProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function OperationPanel({ state, actions }: OperationPanelProps): ReactElement | null {
  const operation = state.trackedOperation;
  if (operation === null) {
    return null;
  }
  const terminal = isOperationTerminal(operation.status);
  const progress = operation.progress;
  return (
    <section aria-labelledby="operation-heading" className="panel">
      <h2 id="operation-heading">当前操作</h2>
      <p>
        操作 ID：<code>{operation.operationId}</code>；类型：
        {operation.kind === null ? '未知' : (OPERATION_KIND_LABELS[operation.kind] ?? operation.kind)}
        ；阶段：{operation.phase}
      </p>
      <p role="status" aria-live="polite">
        {`状态：${OPERATION_STATUS_LABELS[operation.status]}（sequence ${operation.sequence}）`}
      </p>
      {progress === null ? (
        <p>进度未知，暂不显示百分比。</p>
      ) : (
        <p className="progress-row">
          <label htmlFor="operation-progress">进度</label>
          <progress id="operation-progress" max={100} value={clampProgress(progress)}>
            {`${clampProgress(progress)}%`}
          </progress>
          <span>{`${clampProgress(progress)}%`}</span>
        </p>
      )}
      {operation.error !== null && (
        <p role="alert" className="notice notice-error">
          操作失败：{describeError(operation.error)}
        </p>
      )}
      {state.trackingError !== null && (
        <p role="alert" className="notice notice-error">
          获取操作状态失败：{describeError(state.trackingError)}
        </p>
      )}
      {state.trackingPaused && (
        <p>
          连续多次获取操作状态失败，已暂停自动刷新。
          <button
            type="button"
            onClick={() => {
              actions.retryTracking?.();
            }}
          >
            重试获取状态
          </button>
        </p>
      )}
      {!terminal && (
        <button
          type="button"
          disabled={state.commandPending}
          onClick={() => {
            actions.cancelTrackedOperation();
          }}
        >
          取消操作
        </button>
      )}
    </section>
  );
}
