/**
 * Read-only upstream DSH version panel (A1 / #113).
 *
 * It only renders the terminal `versions.dsh` listing; the request itself and
 * input validation live in the controller. Audited combinations are shown as
 * installable through the EXISTING create/install flow; every other version is
 * explicitly labelled 未支持 and is never presented as installable. `latest` is
 * never equated with compatibility.
 */
import type { ReactElement } from 'react';
import type { ContractError } from '@hdsl/contracts';
import { formatTimestamp } from '../format.js';
import {
  isOperationTerminal,
  isVersionInstallableOnHost,
  type RendererActions,
  type RendererState,
} from '../view-model.js';

/** Registry-specific, source-neutral text (never the raw port message). */
const REGISTRY_ERROR_HINT: Readonly<Record<string, string>> = {
  NETWORK_UNAVAILABLE: '公开 npm registry 暂时不可达；可重试。',
  RATE_LIMITED: '公开 npm registry 限流；可稍后重试。',
  DOWNLOAD_FAILED: 'npm registry 响应无法解析；可重试。',
  SOURCE_ACCESS_DENIED: 'npm registry 拒绝访问（不可重试）。',
  SOURCE_NOT_FOUND: 'npm registry 上没有该包。',
};

const registryHint = (error: ContractError): string =>
  REGISTRY_ERROR_HINT[error.code] ?? '查询失败；可重试。';

export interface DshVersionsProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function DshVersions({ state, actions }: DshVersionsProps): ReactElement {
  const tracked = state.trackedOperation;
  const reading =
    tracked !== null && tracked.kind === 'versions' && !isOperationTerminal(tracked.status);
  const error = tracked !== null && tracked.kind === 'versions' ? tracked.error : null;
  const listing = state.dshVersions;
  return (
    <section className="panel" aria-labelledby="dsh-versions-heading">
      <h2 id="dsh-versions-heading">上游 DSH 版本</h2>
      <p className="muted">
        只读查询公开 npm registry（白名单主机 registry.npmjs.org；无凭据；不下载或执行任何包）。
        未受审版本标记为「未支持」，不代表可安装，也不代表 <code>latest</code> 兼容。
      </p>
      <button
        type="button"
        disabled={state.commandPending || reading}
        onClick={() => {
          actions.loadDshVersions();
        }}
      >
        查询版本
      </button>
      {reading && (
        <p role="status">
          正在查询 npm registry…（{tracked?.phase ?? 'reading registry'}）
        </p>
      )}
      {error !== null && (
        <p role="alert">
          {error.code}：{registryHint(error)}
        </p>
      )}
      {listing !== null && !reading && (
        <div>
          <p className="muted">
            来源 {listing.source.registry}（{listing.source.packageName}） · 查询时间{' '}
            {formatTimestamp(listing.fetchedAt)}
          </p>
          <p className="muted">
            标签：
            {listing.distTags.length === 0
              ? '无'
              : listing.distTags.map((entry) => `${entry.tag}=${entry.version}`).join('，')}
          </p>
          {listing.versions.map((entry) => {
            const installableHere =
              entry.supported && isVersionInstallableOnHost(state, entry.catalogCombinationIds);
            return (
              <div className="runtime-row" key={entry.version}>
                <div>
                  <strong>DSH {entry.version}</strong>
                  <small>
                    {!entry.supported
                      ? '未支持：不在受审组合白名单内'
                      : installableHere
                        ? '已受审：可经既有受管安装新建环境'
                        : '已受审：当前平台没有可安装的受审组合'}
                    {entry.publishedAt === null
                      ? ''
                      : ` · 发布 ${formatTimestamp(entry.publishedAt)}`}
                  </small>
                  {entry.catalogCombinationIds.length > 0 && (
                    <small>
                      {installableHere ? '受审组合：' : '受审组合（其他平台）：'}
                      {entry.catalogCombinationIds.join('，')}
                    </small>
                  )}
                </div>
              </div>
            );
          })}
          {listing.versions.length === 0 && <p>registry 未返回任何可用版本。</p>}
        </div>
      )}
    </section>
  );
}
