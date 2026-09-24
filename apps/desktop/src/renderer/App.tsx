/** The approved launcher shell; effects remain owned by RendererController. */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { RendererController } from './controller.js';
import { CreateEnvironmentForm } from './components/CreateEnvironmentForm.js';
import { DshVersions } from './components/DshVersions.js';
import { EnvironmentDetail } from './components/EnvironmentDetail.js';
import { EntryPatch } from './components/EntryPatch.js';
import { ExpectedComposition } from './components/ExpectedComposition.js';
import { EnvironmentList } from './components/EnvironmentList.js';
import { DemoBanner, Notices } from './components/Notices.js';
import { OperationPanel } from './components/OperationPanel.js';
import { PluginDiscovery } from './components/PluginDiscovery.js';
import { PluginInstall } from './components/PluginInstall.js';
import { PluginRemoval } from './components/PluginRemoval.js';
import { SwitchVersion } from './components/SwitchVersion.js';
import { LaunchBar } from './components/LaunchBar.js';
import { Icon } from './components/Icon.js';
import { ENVIRONMENT_STATE_LABELS } from './format.js';
import {
  isBusy,
  selectedEnvironment,
  type RendererActions,
  type RendererState,
} from './view-model.js';

export interface AppViewProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

type Page = 'home' | 'environments' | 'discover' | 'tasks' | 'help';
const pages = [
  { id: 'home', label: '启动', description: '从熟悉的环境，继续手边的工作。' },
  { id: 'environments', label: '环境', description: '为不同的工作，保留独立的环境。' },
  {
    id: 'discover',
    label: '发现插件',
    description: '从公开 GitHub 仓库发现插件；发现不代表可安装或安全。',
  },
  { id: 'tasks', label: '任务', description: '查看当前操作的进度与结果。' },
  { id: 'help', label: '帮助', description: '配置凭据与排查运行问题。' },
] as const;

export function AppView({ state, actions }: AppViewProps): ReactElement {
  const [page, setPage] = useState<Page>('home');
  const [creating, setCreating] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const previousOperation = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const environment = selectedEnvironment(state);
  const busy = isBusy(state);
  const hasOperation = state.trackedOperation !== null || state.pendingOperationId !== null;
  const currentPage = pages.find((entry) => entry.id === page) ?? pages[0];

  useEffect(() => {
    if (!creating) return;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('#create-name')?.focus();
    return () => {
      element?.close();
    };
  }, [creating]);

  // A new operation id proves acceptance. Clearing an invalid name by hand
  // must not close the dialog; failures keep the input available for correction.
  useEffect(() => {
    const operationId = state.pendingOperationId ?? state.trackedOperation?.operationId ?? null;
    if (submitted && operationId !== null && operationId !== previousOperation.current) {
      setCreating(false);
      setSubmitted(false);
      setPage('tasks');
    }
  }, [submitted, state.pendingOperationId, state.trackedOperation]);

  const openCreate = (combinationId?: string): void => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (combinationId !== undefined) actions.setCreateCombinationId(combinationId);
    setSubmitted(false);
    setCreating(true);
  };
  const closeCreate = (): void => {
    dialog.current?.close();
    setCreating(false);
    returnFocus.current?.focus();
  };

  return (
    <div className="hdsl-app">
      {state.demo && <DemoBanner />}
      <header className="titlebar">
        <span className="brand">HDSL</span>
        <span>本地工作环境</span>
      </header>
      <aside className="sidebar" aria-label="工作区">
        <div className="side-identity">
          <span className="identity-mark">
            <Icon name="terminal" />
          </span>
          <div>
            <strong>工作环境</strong>
            <small>本地管理</small>
          </div>
        </div>
        <p className="nav-label">工作区</p>
        <nav aria-label="主导航">
          {pages.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={page === entry.id ? 'page' : undefined}
              onClick={() => {
                setPage(entry.id);
              }}
            >
              <Icon name={entry.id} />
              {entry.label}
              {entry.id === 'tasks' && state.trackingError !== null && (
                <span className="attention-dot" aria-label="状态获取失败" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <label htmlFor="selected-environment">当前环境</label>
          <select
            id="selected-environment"
            value={environment?.id ?? ''}
            disabled={state.environments.length === 0}
            onChange={(event) => {
              actions.selectEnvironment(event.currentTarget.value);
            }}
          >
            {state.environments.length === 0 && <option value="">尚无环境</option>}
            {state.environments.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {ENVIRONMENT_STATE_LABELS[entry.state]}
              </option>
            ))}
          </select>
          <button
            className="text-button"
            type="button"
            disabled={state.commandPending || busy}
            onClick={() => {
              actions.refresh();
            }}
          >
            <Icon name="refresh" />
            刷新环境
          </button>
        </div>
      </aside>
      <main className="workspace" aria-labelledby="page-heading">
        <div className="page-heading">
          <div>
            <h1 id="page-heading">{currentPage.label}</h1>
            <p>{currentPage.description}</p>
          </div>
          {(page === 'home' || page === 'environments') && (
            <button
              id="new-environment"
              type="button"
              disabled={state.phase !== 'ready' || busy}
              onClick={() => {
                openCreate();
              }}
            >
              <Icon name="plus" />
              新建环境
            </button>
          )}
        </div>
        {!creating && <Notices state={state} />}
        {state.phase === 'failed' && (
          <button
            className="retry-load"
            type="button"
            disabled={state.commandPending}
            onClick={() => {
              actions.refresh();
            }}
          >
            重新加载
          </button>
        )}
        {(page === 'home' || page === 'environments') && (
          <>
            {(state.phase === 'loading' || state.phase === 'idle') && (
              <section className="panel empty-state" role="status">
                正在加载环境…
              </section>
            )}
            {state.phase === 'ready' && environment === null && (
              <section className="panel empty-state">
                <span className="identity-mark">
                  <Icon name="environments" />
                </span>
                <h2>还没有环境</h2>
                <p>创建第一个环境，开始使用 DSH。</p>
                <button
                  className="primary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    openCreate();
                  }}
                >
                  创建第一个环境
                </button>
              </section>
            )}
            <EnvironmentDetail state={state} actions={actions} />
            <SwitchVersion state={state} actions={actions} />
            {page === 'environments' && (
              <>
                <EntryPatch state={state} actions={actions} />
                <ExpectedComposition state={state} actions={actions} />
              </>
            )}
            <div className={page === 'home' ? 'home-grid' : ''}>
              {state.environments.length > 0 && <EnvironmentList state={state} actions={actions} />}
              {page === 'home' && (
                <section className="panel catalog" aria-labelledby="catalog-heading">
                  <h2 id="catalog-heading">可安装的运行时</h2>
                  <p className="muted">新建环境时选择，已有环境保持原组成。</p>
                  {state.phase === 'ready' && state.catalog.length === 0 && (
                    <p>暂无已核验的运行时组合。</p>
                  )}
                  {state.catalog.map((entry) => (
                    <div className="runtime-row" key={entry.id}>
                      <Icon name="terminal" />
                      <div>
                        <strong>DSH {entry.dsh.version}</strong>
                        <small>
                          Node {entry.node.version} · {entry.platform}/{entry.arch}
                        </small>
                      </div>
                      <button
                        className="text-button"
                        type="button"
                        aria-label={`新建 DSH ${entry.dsh.version} / Node ${entry.node.version}（${entry.platform}/${entry.arch}）环境`}
                        disabled={state.phase !== 'ready' || busy}
                        onClick={() => {
                          openCreate(entry.id);
                        }}
                      >
                        新建
                        <Icon name="plus" />
                      </button>
                    </div>
                  ))}
                </section>
              )}
            </div>
            {page === 'home' && <DshVersions state={state} actions={actions} />}
          </>
        )}
        {page === 'discover' && (
          <>
            <PluginDiscovery state={state} actions={actions} />
            <PluginInstall state={state} actions={actions} />
            <PluginRemoval state={state} actions={actions} />
          </>
        )}
        {(page === 'home' || page === 'tasks') && (
          <OperationPanel state={state} actions={actions} />
        )}
        {page === 'tasks' &&
          state.pendingOperationId !== null &&
          state.trackedOperation === null &&
          state.trackingError === null && <p role="status">操作已提交，正在获取任务状态…</p>}
        {page === 'tasks' && !hasOperation && (
          <section className="panel empty-state">
            <Icon name="tasks" />
            <h2>暂无任务</h2>
            <p>创建、启动和停止环境后，可在这里查看操作进度。</p>
          </section>
        )}
        {page === 'help' && (
          <>
            <section className="panel help-content">
              <h2>开始使用</h2>
              <ol>
                <li>
                  <strong>创建并选择环境</strong>
                  <p>在「环境」中新建工作环境，或在左下方切换已有环境。</p>
                </li>
                <li>
                  <strong>配置环境凭据</strong>
                  <p>
                    在应用原生菜单中选择「环境 → 导入环境凭据引用…」。选择保存 OS
                    凭据引用的配置文件，无需在此输入密钥。
                  </p>
                </li>
                <li>
                  <strong>启动并打开工作界面</strong>
                  <p>右下方启动环境。运行就绪后，点击「打开工作界面」在系统浏览器中打开 WebUI。</p>
                </li>
              </ol>
            </section>
            <section className="panel">
              <h2>遇到问题？</h2>
              <p className="muted">为当前环境导出脱敏诊断，用于排查运行问题。</p>
              <button
                type="button"
                disabled={environment === null || state.commandPending}
                onClick={() => {
                  actions.exportDiagnostics();
                }}
              >
                导出诊断
              </button>
              <p className="boundary-note">环境使用独立目录和进程，但不等同于操作系统安全沙箱。</p>
            </section>
          </>
        )}
      </main>
      <LaunchBar
        state={state}
        actions={actions}
        onShowTasks={() => {
          setPage('tasks');
        }}
      />
      {creating && (
        <dialog
          ref={dialog}
          aria-labelledby="create-heading"
          onCancel={(event) => {
            event.preventDefault();
            closeCreate();
          }}
        >
          <button
            className="dialog-close"
            type="button"
            aria-label="关闭新建环境"
            onClick={closeCreate}
          >
            <Icon name="close" />
          </button>
          <Notices state={state} />
          <CreateEnvironmentForm
            state={state}
            actions={actions}
            onSubmit={() => {
              previousOperation.current =
                state.pendingOperationId ?? state.trackedOperation?.operationId ?? null;
              setSubmitted(true);
            }}
          />
        </dialog>
      )}
    </div>
  );
}

export function App({ controller }: { readonly controller: RendererController }): ReactElement {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  return <AppView state={state} actions={controller} />;
}
