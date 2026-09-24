/**
 * Read-only EXPECTED composition panel (#118).
 *
 * It renders the terminal `compositions.expected` view produced from the
 * managed `dsh --profile <p> --dump-config` dump. The copy is deliberately
 * explicit: this is the DESIRED/EXPECTED composition and is NEVER the runtime
 * ACTIVE plugin set. `--dump-config` resolves config offline, preserves `!!js`
 * expressions verbatim without evaluating them, and E9 (dump <-> runtime-loaded
 * set) is not established. stderr warnings and parse diagnostics are shown as
 * they are (redacted), never silently dropped.
 */
import type { ReactElement } from 'react';
import type { ExpectedCompositionRow } from '@hdsl/contracts';
import { formatTimestamp } from '../format.js';
import {
  isOperationTerminal,
  selectedEnvironment,
  type RendererActions,
  type RendererState,
} from '../view-model.js';

export interface ExpectedCompositionProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

const nameLabel = (row: ExpectedCompositionRow): string => {
  if (row.nameKnown && row.name !== null) {
    return row.name;
  }
  return '名称未求值';
};

const disabledLabel = (row: ExpectedCompositionRow): string => {
  if (!row.disabledKnown) {
    return '未求值';
  }
  return row.disabled === true ? '已禁用' : '启用';
};

const selectedEnvironmentIsBusy = (state: RendererState): boolean => {
  const environment = selectedEnvironment(state);
  return environment !== null && (environment.state === 'running' || environment.state === 'starting' || environment.state === 'stopping');
};

export function ExpectedComposition({
  state,
  actions,
}: ExpectedCompositionProps): ReactElement | null {
  const environment = selectedEnvironment(state);
  if (environment === null) {
    return null;
  }
  const tracked = state.trackedOperation;
  const reading =
    tracked !== null && tracked.kind === 'composition' && !isOperationTerminal(tracked.status);
  const error = tracked !== null && tracked.kind === 'composition' ? tracked.error : null;
  // Defence in depth: never render a dump that belongs to a different
  // environment than the one currently selected.
  const view =
    state.expectedComposition !== null && state.expectedComposition.environmentId === environment.id
      ? state.expectedComposition
      : null;
  const busy = selectedEnvironmentIsBusy(state);
  return (
    <section className="panel" aria-labelledby="expected-composition-heading">
      <h2 id="expected-composition-heading">期望组成（dump）</h2>
      <p className="boundary-note" role="note">
        期望组成（dump）≠ 运行期 ACTIVE 集合。这里展示的是离线解析出的期望配置，不是运行期实际加载的插件集合；
        <code>!!js</code> 表达式按原文保留、不求值。
      </p>
      <p className="muted">
        只读运行受管 <code>dsh --profile &lt;p&gt; --dump-config</code>（不执行插件代码、不使用凭据）。
        运行中的环境需先停止，避免改写其派生配置。
      </p>
      <button
        type="button"
        disabled={state.commandPending || reading || busy}
        onClick={() => {
          actions.loadExpectedComposition();
        }}
      >
        读取期望组成
      </button>
      {busy && <p className="muted">环境运行中，停止后再读取期望组成。</p>}
      {reading && (
        <p role="status">正在读取期望组成…（{tracked?.phase ?? 'reading dump'}）</p>
      )}
      {error !== null && <p role="alert">{error.code}：{error.message}</p>}
      {view !== null && !reading && (
        <div>
          <div className="overview-meta">
            <span>
              概要文件 <strong>{view.profileName}</strong>
            </span>
            <span>
              patchReload <strong>{view.patchReload}</strong>
            </span>
            <span>
              行数 <strong>{view.rowCount}</strong>
            </span>
            <span>
              退出码 <strong>{view.exitCode}</strong>
            </span>
          </div>
          <p className="muted">
            bundles：{view.bundles.length === 0 ? '无' : view.bundles.join('，')}
          </p>
          <p className="muted">读取时间 {formatTimestamp(view.observedAt)}</p>
          {view.timedOut && <p role="alert">dump 超时，结果可能不完整。</p>}
          {view.exitCode !== 0 && (
            <p role="alert">dump 退出码为 {view.exitCode}；下面内容可能不完整。</p>
          )}
          {view.stderr.trim() !== '' && (
            <div>
              <h3>stderr 警告（原文，已脱敏）</h3>
              <pre role="alert" aria-label="dump stderr">
                {view.stderr}
              </pre>
            </div>
          )}
          {view.diagnostics.length > 0 && (
            <div>
              <h3>解析诊断</h3>
              <ul>
                {view.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${index}`}>
                    <strong>{diagnostic.code}</strong>
                    {diagnostic.groupLabel === null ? '' : `（${diagnostic.groupLabel}）`}
                    {diagnostic.line === null ? '' : ` 第 ${diagnostic.line} 行`}：{diagnostic.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <h3>分组行集合</h3>
          {view.groups.length === 0 && <p>dump 未返回任何分组行。</p>}
          {view.groups.map((group, groupIndex) => (
            <details key={`${group.label}-${groupIndex}`} open>
              <summary>
                {group.label}（{group.rows.length} 行）
              </summary>
              <table>
                <thead>
                  <tr>
                    <th>id</th>
                    <th>name</th>
                    <th>disabled</th>
                    <th>config</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row, rowIndex) => (
                    <tr key={`${row.id ?? 'row'}-${rowIndex}`}>
                      <td>
                        <code>{row.id ?? '未求值'}</code>
                      </td>
                      <td>{nameLabel(row)}</td>
                      <td>{disabledLabel(row)}</td>
                      <td>
                        {row.config === undefined ? (
                          '无'
                        ) : (
                          <details>
                            <summary>
                              {row.config.unevaluated ? '含未求值表达式' : '查看'}
                              {row.config.truncated ? '（已截断）' : ''}
                            </summary>
                            <pre>{row.config.text}</pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
