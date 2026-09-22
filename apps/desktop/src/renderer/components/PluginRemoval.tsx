/**
 * Plugin removal flow (issue #77, S3): installed list -> precise selection ->
 * remove preview -> three explicit branches (remove / retention / blocked) ->
 * confirm -> apply -> progress/result.
 *
 * The list is the authoritative `plugins.installed` view of the ACTIVE
 * generation; direct input is not used here, so the removal target is always a
 * real composition member (no wildcard, no free-text package name). The remove
 * plan is read only from the terminal `changes.preview` output.
 *
 * Honesty constraints (ADR 0005 D15/D21/D20):
 * - a `blockingReferences` entry with an unverified service dependency shows
 *   "无法验证服务依赖，暂不能卸载" and NEVER "插件安全/无影响";
 * - a builtin target is refused with `BUILTIN_BUNDLE_PROTECTED` and there is no
 *   confirm button;
 * - retaining shared/transitive dependencies is EXPECTED and is shown as such.
 */
import type { ReactElement } from 'react';
import type { ChangePlan, ContractError } from '@hdsl/contracts';
import { selectedEnvironment, selectedInstalledPlugin, type RendererActions, type RendererState } from '../view-model.js';

const UNVERIFIED_SERVICE_MARKER = 'service dependencies for this plugin are not verified';

const isUnverifiedService = (plan: ChangePlan): boolean =>
  plan.blockingReferences.some((reference) => reference.detail.includes(UNVERIFIED_SERVICE_MARKER));

const blockerLabel = (plan: ChangePlan): string => {
  if (isUnverifiedService(plan)) {
    return '无法验证服务依赖，暂不能卸载。';
  }
  return '移除会破坏其它 bundle 或配置解析。';
};

const removalErrorHint = (error: ContractError): string => {
  switch (error.code) {
    case 'BUILTIN_BUNDLE_PROTECTED':
      return '该插件是当前受管 DSH 安装的内置 bundle，受保护，不能卸载（无任何副作用）。';
    case 'REFERENCED_BY_OTHER':
      return '该插件被其它 bundle、配置或用户 patch 引用，暂不能卸载。请先处理引用来源。';
    case 'REVISION_CONFLICT':
      return '环境组成已变化。请重新加载列表并重新预览。';
    case 'PLAN_EXPIRED':
      return '该变更计划已过期。请重新预览。';
    case 'PLAN_CONSUMED':
      return '该变更计划已被另一个请求使用。请重新预览。';
    case 'PLAN_STALE':
      return '环境侧输入已变化（引用或用户 patch 漂移）。请重新预览。';
    case 'ENVIRONMENT_BUSY':
      return '环境正在运行或有其它事务进行中。请停止环境或稍后重试。';
    case 'EXECUTOR_UNAVAILABLE':
      return '受管执行器制品不可用或身份不符。卸载未开始，环境组成不变。'; // 仅指执行器制品，不覆盖包获取失败
    case 'NETWORK_UNAVAILABLE':
      return '网络不可用（连接未建立）。卸载未提交，环境组成不变；请检查网络后重试。';
    case 'DOWNLOAD_FAILED':
      return '包获取或完整性校验失败（连接建立后中断）。卸载未提交，环境组成不变；请稍后重试。';
    case 'RATE_LIMITED':
      return 'registry 限流。卸载未提交，环境组成不变；请按提示稍后重试。';
    case 'CANNOT_CANCEL':
      return '事务已提交，不能再取消。可在代际列表显式恢复到上一代。';
    case 'NOT_FOUND':
      return '目标不在活动代际的插件组成中。请重新加载列表。';
    default:
      return error.retryable ? '该失败可重试。' : '该失败不可重试。';
  }
};

export function PluginRemoval({ state, actions }: { state: RendererState; actions: RendererActions }): ReactElement {
  const environment = selectedEnvironment(state);
  const view = state.installedPlugins;
  const selected = selectedInstalledPlugin(state);
  const tracked = state.trackedOperation;
  const previewRunning = tracked?.kind === 'preview' && !['succeeded', 'failed', 'cancelled'].includes(tracked.status);
  const applyRunning = tracked?.kind === 'apply' && !['succeeded', 'failed', 'cancelled'].includes(tracked.status);
  const plan = state.changePlan !== null && state.changePlan.action.kind === 'remove' ? state.changePlan : null;
  const blocked = plan !== null && plan.blockingReferences.length > 0;
  const staleList = view !== null && environment !== null && view.revision !== environment.revision;

  return (
    <section className="panel" aria-labelledby="plugin-removal-heading">
      <h2 id="plugin-removal-heading">卸载与合法保留（S3）</h2>
      <p className="muted">
        从活动代际记录中精确选择要移除的插件。预览会列出将移除的直接依赖与启用引用、将保留的依赖与数据，
        并在会破坏其它 bundle/配置解析或服务依赖无法核验时明确拦截。
      </p>
      <p className="muted" role="note">
        卸载只移除本次事务的直接依赖条目与启用引用，不做通配清理；共享/传递依赖按完全 pin 的 lockfile 保留是预期行为。
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
        <legend>已安装插件（活动代际）</legend>
        <button type="button" onClick={() => { actions.loadInstalledPlugins(); }} disabled={environment === null}>
          加载已安装插件
        </button>
        {view === null ? (
          <p className="muted">尚未加载列表。</p>
        ) : view.plugins.length === 0 ? (
          <p className="muted">活动代际的插件组成为空。</p>
        ) : (
          <ul className="plugin-installed">
            {view.plugins.map((plugin) => (
              <li key={plugin.id}>
                <label>
                  <input
                    type="radio"
                    name="installed-plugin"
                    checked={state.selectedInstalledPluginId === plugin.id}
                    onChange={() => { actions.selectInstalledPlugin(plugin.id); }}
                  />
                  {' '}
                  <code>{plugin.id}</code>@{plugin.version}
                </label>
                {plugin.isBuiltin && <span className="badge" role="note">内置（受保护）</span>}
                {plugin.enabledBundle && <span className="badge">已启用 bundle</span>}
                {plugin.source !== null && (
                  <span className="muted">
                    {' '}来源 {plugin.source.owner}/{plugin.source.name}
                    {plugin.source.commitSha === null ? '' : `@${plugin.source.commitSha.slice(0, 12)}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {staleList && (
          <p role="alert">列表属于较早的修订，已过期。请重新加载后再卸载。</p>
        )}
        <button
          type="button"
          onClick={() => { actions.previewPluginRemoval(); }}
          disabled={environment === null || selected === null || staleList || state.commandPending}
        >
          预览卸载
        </button>
      </fieldset>

      {(previewRunning || applyRunning) && (
        <p role="status">
          {previewRunning ? '正在解析移除项与保留项…' : '正在执行卸载事务…'}
          <button type="button" onClick={() => { actions.cancelInstallOperation(); }}>
            取消
          </button>
        </p>
      )}

      {plan !== null && (
        <div className="plugin-plan">
          <h3>移除计划（{plan.planId}）</h3>
          <ul>
            <li>目标环境修订：{String(plan.baseRevision)}</li>
            <li>有效期至：{plan.expiresAt}</li>
            <li>目标插件：{plan.action.kind === 'remove' ? plan.action.pluginId : ''}</li>
          </ul>
          <h4>将移除</h4>
          <ul>
            {plan.removals.length === 0 ? <li className="muted">无直接条目</li> : plan.removals.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
          <h4>将保留</h4>
          <ul>
            {plan.retention.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
          <h4>风险说明</h4>
          <ul>
            {plan.riskItems.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>

          {blocked ? (
            <div role="alert">
              <p>{blockerLabel(plan)}</p>
              <ul>
                {plan.blockingReferences.map((reference) => (
                  <li key={`${reference.kind}:${reference.detail}`}>
                    [{reference.kind}] {reference.detail}
                  </li>
                ))}
              </ul>
              <p className="muted">未发生任何副作用；请处理后重新预览。</p>
            </div>
          ) : (
            <button type="button" onClick={() => { actions.applyPluginChange(); }} disabled={state.commandPending}>
              确认卸载
            </button>
          )}
        </div>
      )}

      {state.changeApplication !== null && (
        <p role="status">
          卸载已提交：新代际 {state.changeApplication.generationId}（组成摘要 {state.changeApplication.compositionDigest}）。
          重启环境后生效；活动代际记录与离线解析的组合树都不再包含该包。
        </p>
      )}

      {state.actionError !== null && (
        <p role="alert">{removalErrorHint(state.actionError)}（{state.actionError.code}）</p>
      )}

      {tracked?.kind === 'preview' && tracked.status === 'failed' && (
        <p role="status">
          <button type="button" onClick={() => { actions.previewPluginRemoval(); }} disabled={environment === null || selected === null || state.commandPending}>
            重试预览
          </button>
        </p>
      )}
    </section>
  );
}
