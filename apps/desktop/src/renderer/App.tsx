/**
 * Renderer application shell (T006a).
 *
 * `AppView` is a pure render of a {@link RendererState}; `App` subscribes to a
 * {@link RendererController}. Splitting them keeps the components testable as
 * static markup (state matrix) while the live wiring stays in one place.
 */
import { useSyncExternalStore, type ReactElement } from 'react';
import type { RendererController } from './controller.js';
import { CreateEnvironmentForm } from './components/CreateEnvironmentForm.js';
import { EnvironmentDetail } from './components/EnvironmentDetail.js';
import { EnvironmentList } from './components/EnvironmentList.js';
import { DemoBanner, Notices } from './components/Notices.js';
import { OperationPanel } from './components/OperationPanel.js';
import type { RendererActions, RendererState } from './view-model.js';

export interface AppViewProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function AppView({ state, actions }: AppViewProps): ReactElement {
  return (
    <main className="hdsl-app" aria-labelledby="app-heading">
      {state.demo && <DemoBanner />}
      <h1 id="app-heading">HDSL 环境管理</h1>
      <Notices state={state} />
      <CreateEnvironmentForm state={state} actions={actions} />
      <EnvironmentList state={state} actions={actions} />
      <EnvironmentDetail state={state} actions={actions} />
      <OperationPanel state={state} actions={actions} />
      <footer className="boundary-note">
        <p>
          renderer 只通过受限客户端调用冻结契约方法；不直接访问 Node、文件系统或任意 IPC，
          也不接收携带 token 的 WebUI URL。
        </p>
      </footer>
    </main>
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
