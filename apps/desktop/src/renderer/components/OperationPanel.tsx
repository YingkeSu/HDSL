/**
 * Tracked-operation progress (T006a).
 *
 * Uses the native `<progress>` element so assistive technology gets a real
 * `progressbar` with `value`/`max`; when the contract reports no progress the
 * UI says so instead of inventing a percentage. The cancel button is only shown
 * while the operation is not terminal (`CANNOT_CANCEL` otherwise).
 *
 * Issue #40: the **first** `operations.get` can fail before any snapshot exists
 * (`trackedOperation === null`). In that case the panel still renders the real
 * `pendingOperationId`, the sanitized error and the explicit retry entry, so a
 * dispatched command is never silently untrackable. It never fabricates a
 * phase/status/progress for the missing snapshot, and the retry only re-observes
 * the same operation.
 */
import type { ReactElement } from 'react';
import {
  clampProgress,
  describeError,
  OPERATION_KIND_LABELS,
  OPERATION_STATUS_LABELS,
} from '../format.js';
import { isOperationTerminal, type RendererActions, type RendererState } from '../view-model.js';

export interface OperationPanelProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function OperationPanel({ state, actions }: OperationPanelProps): ReactElement | null {
  const operation = state.trackedOperation;
  const pendingOperationId = state.pendingOperationId;
  const terminal = operation !== null && isOperationTerminal(operation.status);
  // The recovery entry must not depend on a snapshot: while the first fetch is
  // failing there is no `trackedOperation`, only the recorded operationId. For a
  // tracked operation the explicit entry stays tied to `trackingPaused` (a
  // transient poll failure already has its own bounded auto-retry).
  const canRetryTracking =
    state.trackingError !== null &&
    ((operation === null && pendingOperationId !== null) ||
      (operation !== null && !terminal && state.trackingPaused));
  if (operation === null && !canRetryTracking) {
    return null;
  }
  const operationId = operation?.operationId ?? pendingOperationId;
  const progress = operation?.progress ?? null;
  return (
    <section aria-labelledby="operation-heading" className="panel">
      <h2 id="operation-heading">当前操作</h2>
      {operation?.environmentId != null && (
        <p className="muted">
          环境：
          {state.environments.find((entry) => entry.id === operation.environmentId)?.name ??
            operation.environmentId}
        </p>
      )}
      {operation === null ? (
        <p>
          操作 ID：<code>{operationId}</code>
        </p>
      ) : (
        <>
          <details className="technical-details">
            <summary>操作详情</summary>
            <p>
              操作 ID：<code>{operation.operationId}</code>；类型：
              {operation.kind === null
                ? '未知'
                : (OPERATION_KIND_LABELS[operation.kind] ?? operation.kind)}
              ；阶段：{operation.phase}
            </p>
          </details>
          <p role="status" aria-live="polite">
            {`状态：${OPERATION_STATUS_LABELS[operation.status]}`}
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
        </>
      )}
      {operation === null && state.trackingError !== null && (
        <p role="status" aria-live="polite">
          尚未获取到操作状态快照，可重试获取。
        </p>
      )}
      {state.trackingError !== null && (
        <p role="alert" className="notice notice-error">
          获取操作状态失败：{describeError(state.trackingError)}
        </p>
      )}
      {state.trackingPaused && <p>连续多次获取操作状态失败，已暂停自动刷新。</p>}
      {canRetryTracking && (
        <p>
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
      {operation !== null && !terminal && (
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
