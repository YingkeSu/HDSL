/**
 * Environment list (T006a).
 *
 * Each row is a native `<button>` with `aria-pressed`, so selection works with
 * Tab/Enter/Space and screen readers announce the selected state. The list never
 * renders a secret or a local path: `EnvironmentSummary` has none.
 */
import type { ReactElement } from 'react';
import { ENVIRONMENT_STATE_LABELS } from '../format.js';
import type { RendererActions, RendererState } from '../view-model.js';

export interface EnvironmentListProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function EnvironmentList({ state, actions }: EnvironmentListProps): ReactElement {
  return (
    <section aria-labelledby="environments-heading" className="panel">
      <h2 id="environments-heading">环境列表</h2>
      {(state.phase === 'idle' || state.phase === 'loading') && <p>正在加载环境…</p>}
      {state.phase !== 'idle' && state.phase !== 'loading' && state.environments.length === 0 && (
        <p>还没有环境。点击「新建环境」创建第一个环境。</p>
      )}
      {state.environments.length > 0 && (
        <ul className="environment-list">
          {state.environments.map((environment) => {
            const selected = environment.id === state.selectedEnvironmentId;
            return (
              <li key={environment.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    actions.selectEnvironment(environment.id);
                  }}
                >
                  <span className="environment-name">{environment.name}</span>
                  <span className={`state-badge state-${environment.state}`}>
                    {ENVIRONMENT_STATE_LABELS[environment.state]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
