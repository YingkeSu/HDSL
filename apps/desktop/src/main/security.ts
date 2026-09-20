/**
 * Window security defaults and navigation guards (T006 / issue #6).
 *
 * Every HDSL window keeps context isolation on, Node integration off and the
 * sandbox on. The renderer document is the only allowed navigation target, by
 * **exact normalized URL** (security P2-1); window.open/popups, subframe
 * navigation and webview attachment are denied. The managed DSH WebUI is never
 * loaded in an HDSL window (main opens it natively after ownership
 * verification), so a DSH page can never reach the launcher bridge.
 *
 * Only the `BrowserWindow` instance methods are used at runtime, so tests can
 * drive the guards with a small fake and the module stays Electron-runtime-free.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { isTrustedDocumentUrl, type TrustedUrlPolicy } from './trusted-url.js';

/** Web preferences every HDSL window must use; the renderer is never trusted. */
export const SECURE_WINDOW_DEFAULTS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} satisfies BrowserWindowConstructorOptions['webPreferences'];

export type NavigationPolicy = TrustedUrlPolicy;

export { isTrustedDocumentUrl };

/**
 * Applies the deny-by-default navigation policy:
 * - `setWindowOpenHandler` denies every popup/new window;
 * - `will-navigate` (main frame) allows only the exact trusted document URL;
 * - `will-frame-navigate` denies any subframe navigation and any untrusted URL,
 *   including a main frame that would leave the trusted document;
 * - `will-attach-webview` is denied.
 */
export const applyWindowSecurity = (browserWindow: BrowserWindow, policy: NavigationPolicy): void => {
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedDocumentUrl(url, policy)) {
      event.preventDefault();
    }
  });
  browserWindow.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame || !isTrustedDocumentUrl(details.url, policy)) {
      details.preventDefault();
    }
  });
  browserWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
};
