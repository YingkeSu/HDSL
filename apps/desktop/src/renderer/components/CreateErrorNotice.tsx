/**
 * Dialog-scoped create-environment error (T006a / #146).
 *
 * The create flow owns its own error field instead of the page-level
 * `actionError`, so a failed create can be cleared when the dialog closes or is
 * reopened without wiping an unrelated operation/export/WebUI error. It only
 * renders the already-sanitized `ContractError` from the frozen contract; no
 * port message, token URL or local path is added here.
 */
import type { ReactElement } from 'react';
import { describeError } from '../format.js';
import type { RendererState } from '../view-model.js';

export function CreateErrorNotice({
  state,
}: {
  readonly state: RendererState;
}): ReactElement | null {
  if (state.createError === null) {
    return null;
  }
  return (
    <p role="alert" className="notice notice-error">
      创建环境失败：{describeError(state.createError)}
    </p>
  );
}
