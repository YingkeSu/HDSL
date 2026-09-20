/**
 * Window security defaults and navigation guards (T006 / issue #6).
 *
 * Every HDSL window keeps context isolation on, Node integration off and the
 * sandbox on. The renderer document is the only allowed navigation target;
 * window.open/popups and webview attachment are denied. The managed DSH WebUI is
 * never loaded in an HDSL window (main opens it natively after ownership
 * verification), so a DSH page can never reach the launcher bridge.
 *
 * Only the `BrowserWindow` instance methods are used at runtime, so tests can
 * drive the guards with a small fake and the module stays Electron-runtime-free.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

/** Web preferences every HDSL window must use; the renderer is never trusted. */
export const SECURE_WINDOW_DEFAULTS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} satisfies BrowserWindowConstructorOptions['webPreferences'];

export interface NavigationPolicy {
  /** Exact document URL or URL prefix(es) this window may navigate to. */
  readonly allowedUrlPrefixes: readonly string[];
}

export const isNavigationAllowed = (url: string, policy: NavigationPolicy): boolean =>
  policy.allowedUrlPrefixes.some((prefix) => prefix.length > 0 && url.startsWith(prefix));

/**
 * Applies the deny-by-default navigation policy. Returned `false` values from
 * `setWindowOpenHandler` mean no new window is created for any renderer request.
 */
export const applyWindowSecurity = (browserWindow: BrowserWindow, policy: NavigationPolicy): void => {
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserWindow.webContents.on('will-navigate', (event, url) => {
    if (!isNavigationAllowed(url, policy)) {
      event.preventDefault();
    }
  });
  browserWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
};
