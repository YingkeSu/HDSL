/**
 * Localized error notice (#145).
 *
 * Renders the user-facing Chinese explanation first and keeps the diagnostic
 * `CODE：message` inside a collapsed 技术详情 block. The message is the
 * contract-sanitized value (and is passed through the shared redaction again by
 * `describeErrorLocalized`), so expanding the detail does not widen the trust
 * boundary.
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

export function ErrorNotice({ error, prefix = '', title }: ErrorNoticeProps): ReactElement {
  const localized = describeErrorLocalized(error);
  return (
    <div role="alert" className="notice notice-error">
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
    </div>
  );
}
