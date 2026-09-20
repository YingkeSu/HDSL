/**
 * Create-environment form (T006a).
 *
 * Uses native `<form>`, `<label>`, `<input>` and `<select>` so the whole flow is
 * keyboard operable without custom key handling. Client-side name validation
 * mirrors the frozen `nameSchema`; the authoritative check still happens in
 * main and its failure is surfaced like any other contract error.
 */
import type { ReactElement } from 'react';
import type { RendererActions, RendererState } from '../view-model.js';

export interface CreateEnvironmentFormProps {
  readonly state: RendererState;
  readonly actions: RendererActions;
}

export function CreateEnvironmentForm({
  state,
  actions,
}: CreateEnvironmentFormProps): ReactElement {
  const disabled = state.phase !== 'ready' || state.catalog.length === 0;
  const canSubmit = !disabled && !state.commandPending && state.createName.trim().length > 0;
  return (
    <section aria-labelledby="create-heading" className="panel">
      <h2 id="create-heading">创建环境</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          actions.createEnvironment();
        }}
      >
        <p className="field">
          <label htmlFor="create-name">环境名称</label>
          <input
            id="create-name"
            name="name"
            type="text"
            value={state.createName}
            maxLength={80}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => {
              actions.setCreateName(event.currentTarget.value);
            }}
          />
        </p>
        <p className="field">
          <label htmlFor="create-combination">运行时组合</label>
          <select
            id="create-combination"
            name="catalogCombinationId"
            value={state.createCombinationId ?? ''}
            disabled={disabled}
            onChange={(event) => {
              actions.setCreateCombinationId(event.currentTarget.value);
            }}
          >
            {state.catalog.map((combination) => (
              <option key={combination.id} value={combination.id}>
                {`Node ${combination.node.version} / DSH ${combination.dsh.version}（${combination.platform}/${combination.arch}）`}
              </option>
            ))}
          </select>
        </p>
        <button type="submit" disabled={!canSubmit}>
          创建
        </button>
      </form>
      {state.phase === 'ready' && state.catalog.length === 0 && (
        <p>没有已核验的运行时组合，暂时无法创建环境。</p>
      )}
    </section>
  );
}
