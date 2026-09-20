/**
 * Electron main entry — **production** (T006 / issue #6).
 *
 * This is the package `main`. It starts the desktop app with production
 * defaults only: native dialogs for diagnostic export and credential-reference
 * import, and the native application menu. It reads **no** test hooks and no
 * HDSL_* environment switch, so a user build cannot bypass the native
 * selectors or a user confirmation through the environment.
 *
 * A separate, explicitly launched test entry (`qa-entry.ts`) exists for
 * headless QA and is never referenced here.
 */
import { startDesktopApp } from './app.js';

export { SECURE_WINDOW_DEFAULTS } from './security.js';
export { DATA_ROOT_ENV, DATA_ROOT_FLAG, resolveDataRoot } from './data-root.js';

void startDesktopApp();
