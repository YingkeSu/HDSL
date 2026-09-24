/**
 * Dialog-scoped create-environment error (T006a / #146, localized #145).
 *
 * The create flow owns its own error field instead of the page-level
 * `actionError`, so a failed create can be cleared when the dialog closes or is
 * reopened without wiping an unrelated operation/export/WebUI error. It only
 * renders the already-sanitized `ContractError` from the frozen contract.
 */
import type { ReactElement } from 'react';
import type { RendererState } from '../view-model.js';
import { ErrorNotice } from './ErrorNotice.js';

export function CreateErrorNotice({
  state,
}: {
  readonly state: RendererState;
}): ReactElement | null {
  if (state.createError === null) {
    return null;
  }
  return <ErrorNotice prefix="创建环境失败：" error={state.createError} />;
}
