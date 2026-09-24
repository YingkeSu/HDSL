/**
 * Localized error rendering (#145).
 *
 * Renders the user-facing Chinese explanation first and keeps the diagnostic
 * `CODE：message` inside a collapsed 技术详情 block. The message is the
 * contract-sanitized value (and is passed through the shared redaction again by
 * `describeErrorLocalized`), so expanding the detail does not widen the trust
 * boundary.
 *
 * `ErrorDetail` is the inline body so callers that already own a role/alert
 * container (for example the plugin discovery panel) can reuse the localized
 * copy without changing their layout; `ErrorNotice` is the standalone
 * `notice notice-error` banner used by the page notices and the create dialog.
 */
import type { ReactElement } from 'react';
import type { ContractError } from '@hdsl/contracts';
import { describeErrorLocalized } from '../error-text.js';

export interface ErrorNoticeProps {
  readonly error: ContractError;
  /** Visible prefix, e.g. `加载失败：`. */
  readonly prefix?: string;
  /** Optional localized primary text overriding the per-code Chinese title. */
  readonly title?: string;
}

export function ErrorDetail({ error, prefix = '', title }: ErrorNoticeProps): ReactElement {
  const localized = describeErrorLocalized(error);
  return (
    <>
      <span>
        {prefix}
        {title ?? localized.title}
        {localized.fieldHint === null ? '' : `（${localized.fieldHint}）`}
      </span>{' '}
      <span className="muted">{localized.retryHint}</span>
      <details className="error-details">
        <summary>技术详情</summary>
        <code>{localized.detail}</code>
      </details>
    </>
  );
}

export function ErrorNotice(props: ErrorNoticeProps): ReactElement {
  return (
    <div role="alert" className="notice notice-error">
      <ErrorDetail {...props} />
    </div>
  );
}
