/**
 * Plugin install flow (issue #76, S2): direct repository input -> preview ->
 * confirm -> apply -> progress/result.
 *
 * Risk copy is exact and non-overstated: `none-detected` is a parse result and
 * is NOT a sandbox/safety guarantee; `unknown` means the dependency closure was
 * not fully enumerated; `detected` requires the S4 build-authorization slice,
 * which this version does not provide (so apply is explicitly refused, never
 * faked). The terminal payload is the single source of truth.
 */
import type { ReactElement } from 'react';
import type { ChangePlan, ContractError } from '@hdsl/contracts';
import { selectedEnvironment, type RendererActions, type RendererState } from '../view-model.js';

const SCRIPT_LABEL: Record<ChangePlan['scriptAssessment'], string> = {
  'none-detected': '未在已解析的清单中发现安装期脚本（仅为解析结论，不构成安全保证）',
  detected: '检测到安装期脚本',
  unknown: '无法确定：依赖闭包未完全解析，可能仍存在安装期脚本',
};

const errorHint = (error: ContractError): string => {
  // An old generation without a recorded runtime identity cannot be reused
  // safely. There is no automatic repair entry in production yet, so guide a
  // safe rebuild rather than implying a one-click fix.
  if (error.code === 'INTERNAL_ERROR' && error.message.includes('not recorded')) {
    return '该环境代际缺少运行时身份记录，无法安全复用。请安全重建该环境（重新安装受管运行时）；本版本不提供自动修复。';
  }
  switch (error.code) {
    case 'REVISION_CONFLICT':
      return '环境组成已变化。请重新预览以获取新的变更计划。';
    case 'PLAN_EXPIRED':
      return '该变更计划已过期。请重新预览。';
    case 'PLAN_CONSUMED':
      return '该变更计划已被另一个请求使用。请重新预览。';
    case 'PLAN_STALE':
      return '环境侧输入已变化。请重新预览。';
    case 'ENVIRONMENT_BUSY':
      return '环境正在运行或有其他事务进行中。请停止环境或稍后重试。';
    case 'BUILD_NOT_AUTHORIZED':
      return '该来源需要执行安装期构建脚本；本版本默认拒绝执行，需走独立的构建授权（S4）。';
    case 'EXECUTOR_UNAVAILABLE':
      return '受管执行器不可用或身份不符。安装未开始，环境组成不变。';
    case 'RATE_LIMITED':
      return 'GitHub 限流。请稍后重试。';
    case 'NETWORK_UNAVAILABLE':
      return '网络不可用。请检查网络后重试。';
    default:
      return error.retryable ? '该失败可重试。' : '该失败不可重试。';
  }
};

export function PluginInstall({ state, actions }: { state: RendererState; actions: RendererActions }): ReactElement {
  const environment = selectedEnvironment(state);
  const tracked = state.trackedOperation;
  const previewRunning = tracked?.kind === 'preview' && tracked.status !== 'succeeded' && tracked.status !== 'failed' && tracked.status !== 'cancelled';
  const applyRunning = tracked?.kind === 'apply' && tracked.status !== 'succeeded' && tracked.status !== 'failed' && tracked.status !== 'cancelled';
  const plan = state.changePlan;
  const blockedByBuild = plan !== null && plan.requiresBuildAuthorization;

  return (
    <section className="panel" aria-labelledby="plugin-install-heading">
      <h2 id="plugin-install-heading">来源预览与安装（S2）</h2>
      <p className="muted">
        直接输入公开 GitHub 仓库引用。预览会解析精确 commit、包 manifest、依赖闭包中的安装期脚本与风险，
        并生成带修订号与有效期的变更计划；确认后才执行安装。
      </p>
      <p className="muted" role="note">
        安装与运行会在你的机器上加载该插件代码，且不受 HDSL 或 DSH 沙箱保护；发现不代表可安装或安全。
      </p>

      <fieldset disabled={state.commandPending}>
        <legend>目标环境</legend>
        <p>
          {environment === null
            ? '请先在“环境”页选择一个环境。'
            : `${environment.name}（修订 ${String(environment.revision)}，状态 ${environment.state}）`}
        </p>
      </fieldset>

      <fieldset disabled={state.commandPending}>
        <legend>仓库引用</legend>
        <label>
          所有者（owner）
          <input
            value={state.installSource.owner}
            onChange={(event) => {
              actions.setInstallSource('owner', event.target.value);
            }}
          />
        </label>
        <label>
          仓库（name）
          <input
            value={state.installSource.name}
            onChange={(event) => {
              actions.setInstallSource('name', event.target.value);
            }}
          />
        </label>
        <label>
          引用（ref，可选）
          <input
            value={state.installSource.ref}
            onChange={(event) => {
              actions.setInstallSource('ref', event.target.value);
            }}
          />
        </label>
        <button type="button" onClick={() => { actions.previewPluginChange(); }} disabled={environment === null}>
          预览变更计划
        </button>
      </fieldset>

      {(previewRunning || applyRunning) && (
        <p role="status">
          {previewRunning ? '正在解析来源并生成计划…' : '正在执行安装事务…'}
          {tracked?.progress !== null && tracked?.progress !== undefined ? ` ${String(tracked.progress)}%` : ''}
          <button type="button" onClick={() => { actions.cancelInstallOperation(); }}>
            取消
          </button>
        </p>
      )}

      {plan !== null && (
        <div className="plugin-plan">
          <h3>变更计划（{plan.planId}）</h3>
          <ul>
            <li>目标环境修订：{String(plan.baseRevision)}</li>
            <li>有效期至：{plan.expiresAt}</li>
            <li>动作：{plan.action.kind === 'install' ? '安装' : '移除'}</li>
            {plan.sourceLock !== null && (
              <>
                <li>精确 commit：<code>{plan.sourceLock.commitSha}</code></li>
                <li>包：{plan.sourceLock.packageName}@{plan.sourceLock.packageVersion}</li>
                <li>manifest 摘要：<code>{plan.sourceLock.manifestSha256}</code></li>
                <li>
                  闭包锁定摘要：{plan.sourceLock.closureLockSha256 === null ? '未知（未获得完全 pin 的 lockfile）' : <code>{plan.sourceLock.closureLockSha256}</code>}
                </li>
              </>
            )}
            <li>脚本评估：{SCRIPT_LABEL[plan.scriptAssessment]}</li>
            {plan.scripts.length > 0 && (
              <li>
                已识别脚本：
                <ul>
                  {plan.scripts.map((script) => (
                    <li key={`${script.packageName}:${script.script}`}>
                      {script.packageName}@{script.packageVersion} — {script.script}（{script.source}）
                    </li>
                  ))}
                </ul>
              </li>
            )}
            <li>执行器：{plan.executor === null ? '未知' : `${plan.executor.id}@${plan.executor.version}`}</li>
          </ul>
          {blockedByBuild ? (
            <p role="alert">
              该来源需要执行安装期构建脚本（{plan.scriptAssessment}）。本版本默认拒绝执行；请等待独立的构建授权（S4）。
            </p>
          ) : (
            <button type="button" onClick={() => { actions.applyPluginChange(); }} disabled={state.commandPending}>
              确认安装
            </button>
          )}
        </div>
      )}

      {state.changeApplication !== null && (
        <p role="status">
          安装已提交：新代际 {state.changeApplication.generationId}（组成摘要 {state.changeApplication.compositionDigest}）。
          重启环境后生效。
        </p>
      )}
      <div className="plugin-generations">
        <h3>代际</h3>
        <button type="button" onClick={() => { actions.loadGenerations(); }} disabled={environment === null || state.commandPending}>
          加载代际列表
        </button>
        {state.generations.length === 0 ? (
          <p className="muted">尚无代际列表数据。</p>
        ) : (
          <ul>
            {state.generations.map((generation) => (
              <li key={generation.generationId}>
                代际 {generation.generationId}
                {generation.active ? '（活动）' : ''}
                {' '}
                <code>{generation.compositionDigest.slice(0, 12)}…</code>
                {!generation.active && (
                  <button
                    type="button"
                    onClick={() => { actions.restoreGeneration(generation.generationId); }}
                    disabled={state.commandPending}
                  >
                    恢复此代际
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          恢复只切换活动代际指针：共享的 home/data（会话、存储、凭据产物）与其它代际目录不会被删除或回滚；运行中的环境拒绝恢复。
        </p>
      </div>

      {state.actionError !== null && (
        <p role="alert">{errorHint(state.actionError)}（{state.actionError.code}）</p>
      )}

      {tracked?.kind === 'preview' && tracked.status === 'failed' && (
        <p role="status">
          <button type="button" onClick={() => { actions.previewPluginChange(); }} disabled={environment === null || state.commandPending}>
            重试预览
          </button>
        </p>
      )}
    </section>
  );
}
