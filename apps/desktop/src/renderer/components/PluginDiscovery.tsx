/**
 * Plugin discovery page (issue #75, S1).
 *
 * Renders the fixed GitHub read-only search: the **exact** query string that is
 * sent (copyable), result counts with the 1000-result ceiling made explicit,
 * metadata marked as display-only, a repository detail panel and the S2 source
 * preview entry point. The preview body is **not** implemented in this slice
 * and is reported as such rather than faked.
 */
import { useState, type ReactElement } from 'react';
import {
  GITHUB_SEARCH_RESULT_LIMIT,
  type ContractError,
  type PluginInspection,
  type PluginSearchHit,
} from '@hdsl/contracts';
import { Icon } from './Icon.js';
import { ErrorDetail } from './ErrorNotice.js';
import { formatOperationKind, formatTimestamp } from '../format.js';
import { selectedPluginHit, type RendererActions, type RendererState } from '../view-model.js';

const METADATA_DISCLAIMER = '仅展示，不作为安全或可安装性依据';
const DISCOVERY_DISCLAIMER =
  '发现不代表可安装或安全；安装前的风险判定由变更预览（S2）负责。';

const formatStars = (stars: number): string => stars.toLocaleString('en-US');

const errorHint = (error: ContractError): string => {
  if (error.code === 'RATE_LIMITED') {
    const seconds = error.retryAfterSeconds;
    return seconds === undefined
      ? 'GitHub 限流。请稍后重试，并使用新的请求标识。'
      : `GitHub 限流。请等待约 ${String(seconds)} 秒后重试，并使用新的请求标识。`;
  }
  if (error.code === 'NETWORK_UNAVAILABLE') {
    return '网络不可用或连接中断。请检查网络后重试；检索不会改变任何环境组成。';
  }
  if (error.code === 'SOURCE_ACCESS_DENIED') {
    return 'GitHub 拒绝了该来源的访问（权限、认证或滥用防护），这不是限流，不可重试。请确认来源是公开可读的仓库。';
  }
  if (error.code === 'SOURCE_NOT_FOUND') {
    return 'GitHub 上找不到该仓库或引用。';
  }
  return error.retryable ? '该失败可重试；重试请使用新的请求标识。' : '该失败不可重试。';
};

function DetailPanel({
  hit,
  inspection,
  onInspect,
  onClose,
}: {
  readonly hit: PluginSearchHit;
  readonly inspection: PluginInspection | null;
  readonly onInspect: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const inspected =
    inspection !== null &&
    inspection.source.owner === hit.owner &&
    inspection.source.name === hit.name;
  return (
    <section className="panel plugin-detail" aria-label={`仓库详情 ${hit.fullName}`}>
      <div className="plugin-detail-head">
        <h3>{hit.fullName}</h3>
        <button className="text-button" type="button" onClick={onClose}>
          <Icon name="close" />
          关闭详情
        </button>
      </div>
      <p>{hit.description ?? '（无描述）'}</p>
      <dl className="plugin-facts">
        <div>
          <dt>来源</dt>
          <dd>
            <code>{hit.htmlUrl}</code>
          </dd>
        </div>
        <div>
          <dt>Star</dt>
          <dd>
            ★ {formatStars(hit.stars)} <small>（{METADATA_DISCLAIMER}）</small>
          </dd>
        </div>
        <div>
          <dt>Topics</dt>
          <dd>
            {hit.topics.length === 0 ? '（无）' : hit.topics.join(', ')}{' '}
            <small>（{METADATA_DISCLAIMER}）</small>
          </dd>
        </div>
        <div>
          <dt>默认分支</dt>
          <dd>{hit.defaultBranch}</dd>
        </div>
        <div>
          <dt>许可</dt>
          <dd>{hit.license ?? '（未声明）'}</dd>
        </div>
        <div>
          <dt>最近更新</dt>
          <dd>{hit.updatedAt}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>
            {hit.archived ? '已归档' : '活动'}
            {hit.fork ? ' · fork' : ''}
          </dd>
        </div>
      </dl>
      <div className="plugin-inspect-entry">
        <button type="button" onClick={onInspect}>
          获取来源详情（plugins.inspect）
        </button>
        {inspected ? (
          <p className="muted" role="status">
            已由 plugins.inspect 重新获取：{inspection.repository.fullName} · ★{' '}
            {formatStars(inspection.repository.stars)} · 默认分支{' '}
            {inspection.repository.defaultBranch} · 许可{' '}
            {inspection.repository.license ?? '（未声明）'} · 获取时间{' '}
            {formatTimestamp(inspection.fetchedAt)}。
          </p>
        ) : (
          <p className="muted">
            当前展示的是检索命中元数据；点击按钮通过 plugins.inspect 重新获取该仓库的公开详情。
          </p>
        )}
      </div>
      <p className="boundary-note">
        默认查询已排除 fork 与 archived；结果元数据（star/topic）不作为安全或可安装性依据。
      </p>
      <div className="plugin-preview-entry">
        <button type="button" disabled aria-describedby="preview-s2-note">
          来源预览
        </button>
        <p id="preview-s2-note" className="muted">
          来源预览入口已预留；预览本体（commit 锁定、manifest/脚本风险、变更计划）属于 S2，
          当前版本尚未实现，不在此显示任何预览结论。
        </p>
      </div>
    </section>
  );
}

export function PluginDiscovery({
  state,
  actions,
}: {
  readonly state: RendererState;
  readonly actions: RendererActions;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const search = state.pluginSearch;
  const detail = selectedPluginHit(state);
  const tracked = state.trackedOperation;
  const trackedIsPlugin = tracked !== null && (tracked.kind === 'search' || tracked.kind === 'inspect');
  const searchRunning =
    trackedIsPlugin && tracked.status !== 'succeeded' && tracked.status !== 'failed' && tracked.status !== 'cancelled';
  const truncated =
    search !== null && search.totalCount > GITHUB_SEARCH_RESULT_LIMIT;

  const copyQuery = (): void => {
    const query = search?.query ?? state.pluginQuery;
    const clipboard = (globalThis as { readonly navigator?: { readonly clipboard?: { writeText(text: string): Promise<void> } } })
      .navigator?.clipboard;
    if (clipboard === undefined) {
      return;
    }
    void clipboard.writeText(query).then(() => {
      setCopied(true);
    });
  };

  return (
    <section className="plugin-discovery" aria-labelledby="plugin-discovery-heading">
      <div className="panel">
        <h2 id="plugin-discovery-heading">发现插件</h2>
        <p className="muted">
          GitHub 公开仓库只读检索；不需要 GitHub 凭据，不读取环境数据，也不会改变任何环境组成。
        </p>
        <form
          className="plugin-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            actions.runPluginSearch();
          }}
        >
          <label htmlFor="plugin-query">检索查询</label>
          <input
            id="plugin-query"
            type="text"
            value={state.pluginQuery}
            spellCheck={false}
            onChange={(event) => {
              actions.setPluginQuery(event.currentTarget.value);
            }}
          />
          <button type="submit" className="primary" disabled={state.commandPending}>
            <Icon name="refresh" />
            检索
          </button>
          <button type="button" disabled={state.commandPending} onClick={() => {
            actions.resetPluginQuery();
          }}>
            恢复默认查询
          </button>
          {searchRunning && (
            <button
              type="button"
              disabled={state.commandPending}
              onClick={() => {
                void actions.cancelPluginSearch();
              }}
            >
              取消检索
            </button>
          )}
        </form>
      </div>

      {state.actionError !== null && (
        <div className="panel plugin-error" role="alert">
          <ErrorDetail error={state.actionError} prefix="检索未开始：" />
        </div>
      )}

      {trackedIsPlugin && tracked.error !== null && (
        <div className="panel plugin-error" role="alert">
          <ErrorDetail
            error={tracked.error}
            prefix={tracked.status === 'cancelled' ? '检索已取消：' : '检索失败：'}
          />
          <p>{tracked.status === 'cancelled' ? '取消为终态，未产生任何副作用。' : errorHint(tracked.error)}</p>
        </div>
      )}

      {trackedIsPlugin && tracked.status === 'cancelled' && tracked.error === null && (
        <div className="panel" role="status">
          检索已取消（终态，未产生任何副作用）。
        </div>
      )}

      {searchRunning && (
        <div className="panel" role="status">
          正在检索…（{formatOperationKind(tracked.kind)} · {tracked.phase}）
        </div>
      )}

      {search !== null && (
        <>
          <div className="panel">
            <div className="plugin-query-line">
              <span>本次精确查询：</span>
              <code id="plugin-query-exact">{search.query}</code>
              <button type="button" onClick={copyQuery}>
                {copied ? '已复制' : '复制查询'}
              </button>
            </div>
            <p className="muted">
              应用发出的查询与该字符串逐字符一致；默认包含 <code>topic:dsh-plugin</code>、{' '}
              <code>fork:false</code> 与 <code>archived:false</code>。
            </p>
            <ul className="plugin-counts">
              <li>共 {search.totalCount} 条匹配（GitHub total_count）。</li>
              <li>
                {search.incompleteResults
                  ? 'GitHub 标记本次结果为 incomplete_results=true，结果可能不完整。'
                  : 'GitHub 标记 incomplete_results=false。'}
              </li>
              <li>
                {truncated
                  ? `GitHub 检索最多返回前 ${String(GITHUB_SEARCH_RESULT_LIMIT)} 条，实际匹配 ${String(search.totalCount)} 条；此处只展示已返回的 ${String(search.hits.length)} 条。`
                  : `GitHub 检索上限为 ${String(GITHUB_SEARCH_RESULT_LIMIT)} 条；此处已返回 ${String(search.hits.length)} 条。`}
              </li>
              {search.hasMore && <li>还有更多结果未显示（本次只取第一页）。</li>}
              <li>获取时间 {formatTimestamp(search.fetchedAt)}；缓存：{search.fromCache ? '是' : '否'}。</li>
            </ul>
            <p className="plugin-disclaimer">{DISCOVERY_DISCLAIMER}</p>
          </div>

          <div className="panel plugin-results">
            <h3>匹配的仓库</h3>
            {search.hits.length === 0 && <p>没有匹配的公开仓库。</p>}
            <ul>
              {search.hits.map((hit) => (
                <li key={hit.fullName}>
                  <button
                    type="button"
                    aria-current={hit.fullName === state.selectedPluginFullName ? 'true' : undefined}
                    onClick={() => {
                      actions.selectPlugin(hit.fullName);
                    }}
                  >
                    <strong>{hit.fullName}</strong>
                    {hit.archived && <span className="tag">已归档</span>}
                    {hit.fork && <span className="tag">fork</span>}
                    <small>{hit.description ?? '（无描述）'}</small>
                    <small>
                      ★ {formatStars(hit.stars)} · {hit.topics.join(', ') || '无 topics'}（
                      {METADATA_DISCLAIMER}）
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {detail !== null && (
            <DetailPanel
              hit={detail}
              inspection={state.pluginInspection}
              onInspect={() => {
                actions.inspectSelectedPlugin();
              }}
              onClose={() => {
                actions.selectPlugin(null);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
