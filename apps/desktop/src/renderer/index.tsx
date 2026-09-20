/**
 * Renderer entry scaffold.
 *
 * This component is intentionally not mounted by any window yet: T002 only
 * proves the React + TSX build pipeline works. The real environment list,
 * progress and redacted-error UI is owned by T006, and the renderer must talk
 * to the main process only through the frozen preload contract (T003).
 */
import type { ReactElement } from 'react';

/** Non-functional scaffold text; never presented as a working launcher. */
export function ScaffoldNotice(): ReactElement {
  return (
    <p>HDSL desktop shell scaffold — no launcher functionality is implemented yet.</p>
  );
}
