/**
 * In-environment version switch control (A2 / #114, #132).
 *
 * It offers a switch ONLY to combinations that are both verified on this host
 * in `catalog.list` AND referenced by a supported upstream `versions.dsh` entry
 * (the same 「已支持组合」 set A1 exposes). Unknown or unsupported combinations
 * are never presented as switchable. Only a `stopped` environment may switch;
 * a running/starting/stopping environment disables the action and asks the user
 * to stop first — it never auto-stops a managed process; the transaction, its
 * revision guard, rollback and failure semantics live in core; this component
 * only dispatches `environments.switchCombination` through the controller and
 * relies on the shared OperationPanel for terminal tracking.
 */
import type { ReactElement } from 'react';
import type { ContractError } from '@hdsl/contracts';
import { ENVIRONMENT_STATE_LABELS } from '../format.js';
import {
  canSwitchVersion,
  isOperationTerminal,
  selectedEnvironment,
  switchableCombinations,
  type RendererActions,
  type RendererState,
} from '../view-model.js';
import { ErrorNotice } from './ErrorNotice.js';

/** Source-neutral hints; the raw core message is never the primary copy. */
const SWITCH_ERROR_HINT: Readonly<Record<string, string>> = {
  ENVIRONMENT_BUSY: '环境正在运行或有其它事务进行中。请先停止环境后重试。',
  REVISION_CONFLICT: '环境组成已变化。请刷新环境后重试。',
  NOT_FOUND: '目标组合不存在。请重新查询已支持组合。',
  UNSUPPORTED_COMBINATION: '该组合不是已支持组合，不能切换。',
  DOWNLOAD_FAILED: '运行时下载或校验失败；切换未提交，环境仍使用旧代。',
  DISK_FULL: '磁盘空间不足；切换未提交，环境仍使用旧代。',
  EXECUTOR_UNAVAILABLE: '受管执行器不可用；切换未提交，环境仍使用旧代。',
  NETWORK_UNAVAILABLE: '网络不可用；切换未提交，环境仍使用旧代。',
  INTERNAL_ERROR: '切换失败；环境仍使用旧代，可重试。',
};

const switchHint = (error: ContractError): string =>
  SWITCH_ERROR_HINT[error.code] ?? (error.retryable ? '该失败可重试。' : '该失败不可重试。');

/** Local guard codes that only this control can raise (no switch operation yet). */
const SWITCH_GUARD_CODES: ReadonlySet<string> = new Set([
  'ENVIRONMENT_BUSY',
  'REVISION_CONFLICT',
  'NOT_FOUND',
  'UNSUPPORTED_COMBINATION',
]);

export interface SwitchVersionProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function SwitchVersion({ state, actions }: SwitchVersionProps): ReactElement | null {
  const environment = selectedEnvironment(state);
  if (environment === null) {
    return null;
  }
  const tracked = state.trackedOperation;
  const switching =
    tracked !== null && tracked.kind === 'switch' && !isOperationTerminal(tracked.status);
  const options = switchableCombinations(state);
  const versionsLoaded = state.dshVersions !== null;
  const stopped = canSwitchVersion(environment);
  const activityLabels = environment.state === 'running' || environment.state === 'starting' || environment.state === 'stopping';
  const disabledReason = !stopped
    ? activityLabels
      ? '请先停止环境；版本切换不会自动停止运行中的进程。'
      : '当前状态不可切换版本；仅停止状态的环境可切换。'
    : !versionsLoaded
      ? '请先查询已支持组合。'
      : options.length === 0
        ? '没有已知的已支持组合可切换到该环境。'
        : null;
  // A switch-server failure is shown with switch-specific copy; any unrelated
  // action error (for example the `versions.dsh` query above) falls back to the
  // shared sanitized `CODE：message` so a registry failure is never mislabelled
  // as a switch failure.
  const switchError =
    tracked !== null && tracked.kind === 'switch' && tracked.error !== null
      ? tracked.error
      : state.actionError !== null && SWITCH_GUARD_CODES.has(state.actionError.code)
        ? state.actionError
        : null;
  const otherError =
    switchError === null && state.actionError !== null ? state.actionError : null;
  return (
    <section className="panel" aria-labelledby="switch-version-heading">
      <h2 id="switch-version-heading">切换版本（同环境）</h2>
      <p className="muted">
        只把已有环境的活动组成切到另一个<strong>已支持组合</strong>；新代安装并验证成功后原子切换，
        切换前失败保留旧代。仅停止状态的环境可切换，且不会自动停止正在运行的进程。
      </p>
      <p className="muted">
        目标环境：{environment.name}（修订 {environment.revision}，状态{' '}
        {ENVIRONMENT_STATE_LABELS[environment.state]}）
      </p>
      {!versionsLoaded && (
        <button
          type="button"
          disabled={state.commandPending}
          onClick={() => {
            actions.loadDshVersions();
          }}
        >
          查询已支持组合
        </button>
      )}
      {disabledReason !== null && <p className="muted">{disabledReason}</p>}
      {options.map((combination) => (
        <div className="runtime-row" key={combination.id}>
          <div>
            <strong>DSH {combination.dsh.version}</strong>
            <small>
              Node {combination.node.version} · {combination.platform}/{combination.arch} · 组合{' '}
              <code>{combination.id}</code>
            </small>
          </div>
          <button
            type="button"
            disabled={state.commandPending || switching || disabledReason !== null}
            onClick={() => {
              actions.switchVersion(combination.id);
            }}
          >
            切换到此组合
          </button>
        </div>
      ))}
      {switching && (
        <p role="status">
          正在切换到新组合…（{tracked?.phase ?? 'switch'}）
          <button
            type="button"
            onClick={() => {
              actions.cancelTrackedOperation();
            }}
          >
            取消
          </button>
        </p>
      )}
      {switchError !== null && <ErrorNotice error={switchError} title={switchHint(switchError)} />}
      {otherError !== null && <ErrorNotice error={otherError} />}
    </section>
  );
}
