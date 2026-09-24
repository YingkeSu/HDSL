/**
 * Desired-config entry patch panel (#135, E1-T1).
 *
 * It edits the environment-level **home user patch**
 * (`$DSH_HOME/cordis.patch.yml`) through `entries.patch`. The copy is
 * deliberately explicit: a saved file is the DESIRED config and is NEVER the
 * runtime ACTIVE plugin set. The panel always shows "已保存 / 等待 DSH 应用
 * （未确认 ACTIVE）" and offers an explicit restart fallback; it never asserts a
 * runtime effect.
 */
import type { ReactElement } from 'react';
import type { EntryPatchOperationKind, EntryPatchResult } from '@hdsl/contracts';
import {
  canEditRuntimeEntry,
  selectedEnvironment,
  type RendererActions,
  type RendererState,
} from '../view-model.js';
import { ErrorNotice } from './ErrorNotice.js';

export interface EntryPatchProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

const ACTIVATION_LABELS: Record<EntryPatchResult['activation'], string> = {
  'restart-required': '需要重启后由 DSH 读取',
  'live-reload-unverified': '预计热重载，但未确认 ACTIVE',
};

const OPERATION_LABELS: Record<EntryPatchOperationKind, string> = {
  enable: '启用',
  disable: '禁用',
  config: '替换 config',
  remove: '移除覆盖行',
};

const rowNameLabel = (row: EntryPatchResult['rows'][number]): string =>
  row.nameKnown && row.name !== null ? row.name : '名称未求值';

export function EntryPatch({ state, actions }: EntryPatchProps): ReactElement | null {
  const environment = selectedEnvironment(state);
  if (environment === null) {
    return null;
  }
  const result =
    state.entryPatchResult !== null && state.entryPatchResult.environmentId === environment.id
      ? state.entryPatchResult
      : null;
  const editable = canEditRuntimeEntry(environment);
  const commandPending = state.commandPending;
  const disabled = commandPending || !editable;

  const submit = (kind: EntryPatchOperationKind): void => {
    actions.patchEntry(kind);
  };

  return (
    <section className="panel" aria-labelledby="entry-patch-heading">
      <h2 id="entry-patch-heading">运行期 entry（期望配置）</h2>
      <p className="boundary-note" role="note">
        保存 ≠ 运行期 ACTIVE。这里编辑的是环境共享 home 用户覆盖层（<code>cordis.patch.yml</code>），
        只表示**已保存**，等待 DSH 应用；HDSL 不会据此声称运行期集合已匹配。
      </p>
      <p className="muted">
        行匹配按 profile 内行 <code>id</code>；<code>remove</code> 只删除 home 覆盖层里已存在的行，
        目标不在其中会返回 <code>NOT_FOUND</code>，不会改动 bundle 或不可变的 profile 声明源。
        运行中的环境允许编辑（走热重载路径，仍未确认 ACTIVE）；环境启动/停止过程中会被拒绝。
      </p>
      <label htmlFor="entry-patch-row-id">行 id</label>
      <input
        id="entry-patch-row-id"
        type="text"
        value={state.entryPatchRowId}
        onChange={(event) => {
          actions.setEntryPatchRowId(event.currentTarget.value);
        }}
      />
      <label htmlFor="entry-patch-config">config（JSON，仅「替换 config」使用；整行替换，不做深合并）</label>
      <textarea
        id="entry-patch-config"
        value={state.entryPatchConfigText}
        rows={4}
        onChange={(event) => {
          actions.setEntryPatchConfigText(event.currentTarget.value);
        }}
      />
      <div className="entry-patch-actions">
        <button type="button" disabled={disabled} onClick={() => submit('enable')}>
          启用
        </button>
        <button type="button" disabled={disabled} onClick={() => submit('disable')}>
          禁用
        </button>
        <button type="button" disabled={disabled} onClick={() => submit('config')}>
          替换 config
        </button>
        <button type="button" disabled={disabled} onClick={() => submit('remove')}>
          移除覆盖行
        </button>
      </div>
      {!editable && (
        <p className="muted">环境正在启动或停止，暂时不能编辑期望配置。</p>
      )}
      {state.actionError !== null && <ErrorNotice error={state.actionError} />}
      {result !== null && (
        <div>
          <p role="status">
            已保存 / 等待 DSH 应用（未确认 ACTIVE）——操作「{OPERATION_LABELS[result.operation]}」。
          </p>
          <div className="overview-meta">
            <span>
              activation <strong>{result.activation}</strong>（{ACTIVATION_LABELS[result.activation]}）
            </span>
            <span>
              reloadMode <strong>{result.reloadMode}</strong>
            </span>
            <span>
              restartRequired <strong>{result.restartRequired ? '需要重启' : '否'}</strong>
            </span>
          </div>
          {result.restartRequired && (
            <p className="muted">
              该 profile 未声明 live 热重载（或为 composition 变更）；请用下面的显式重启 fallback
              让 DSH 按同一文件确定读取，HDSL 不会把它显示为运行期集合已匹配。
            </p>
          )}
          {result.activation === 'live-reload-unverified' && (
            <p className="muted">
              profile 声明了 live 热重载，HDSL **未观测**运行期集合：可能落在预热窗口或被吞错。
              如需确定结果，请显式重启环境。
            </p>
          )}
          {result.diagnostics.length > 0 && (
            <div>
              <h3>结构诊断</h3>
              <ul>
                {result.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${index}`}>
                    <strong>{diagnostic.code}</strong> 第 {diagnostic.line} 行：{diagnostic.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <h3>home 覆盖层行集合</h3>
          {result.rows.length === 0 && <p>home 覆盖层当前没有任何合法行。</p>}
          {result.rows.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>id</th>
                  <th>类型</th>
                  <th>name</th>
                  <th>disabled</th>
                  <th>config</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => (
                  <tr key={`${row.id}-${index}`}>
                    <td>
                      <code>{row.id}</code>
                    </td>
                    <td>{row.kind}</td>
                    <td>{rowNameLabel(row)}</td>
                    <td>{row.disabled === true ? '已禁用' : row.disabled === false ? '启用' : '未声明'}</td>
                    <td>{row.hasConfig ? '有（整行替换）' : '无'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <button
        type="button"
        disabled={commandPending || environment.state === 'starting' || environment.state === 'stopping' || environment.state === 'creating'}
        onClick={() => {
          actions.restartSelected();
        }}
      >
        显式重启环境（停止后重新启动，使已保存的期望配置确定应用）
      </button>
    </section>
  );
}
