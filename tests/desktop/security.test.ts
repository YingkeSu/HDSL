/**
 * Window security + data-root resolution tests (T006 / issue #6).
 *
 * `applyWindowSecurity` is driven with a fake Electron window so the deny-by-
 * default navigation policy, popup denial and webview denial are asserted
 * without a real BrowserWindow.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyWindowSecurity,
  isNavigationAllowed,
  SECURE_WINDOW_DEFAULTS,
} from '../../apps/desktop/src/main/security.js';
import { DATA_ROOT_ENV, DATA_ROOT_FLAG, resolveDataRoot } from '../../apps/desktop/src/main/data-root.js';

interface FakeWindow {
  readonly webContents: {
    setWindowOpenHandler: (handler: (details: unknown) => unknown) => void;
    on: (event: string, listener: (event: unknown, url?: string) => void) => void;
  };
}

const buildFakeWindow = () => {
  let openHandler: ((details: unknown) => unknown) | undefined;
  const listeners = new Map<string, (event: unknown, url?: string) => void>();
  const window: FakeWindow = {
    webContents: {
      setWindowOpenHandler: (handler) => {
        openHandler = handler;
      },
      on: (event, listener) => {
        listeners.set(event, listener);
      },
    },
  };
  return { window, listeners, openHandler: () => openHandler };
};

describe('SECURE_WINDOW_DEFAULTS', () => {
  it('keeps context isolation and sandbox on with node integration off', () => {
    expect(SECURE_WINDOW_DEFAULTS).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });
});

describe('navigation policy', () => {
  it('allows only the renderer document URL prefix', () => {
    const policy = { allowedUrlPrefixes: ['file:///app/dist/renderer/index.html'] };
    expect(isNavigationAllowed('file:///app/dist/renderer/index.html', policy)).toBe(true);
    expect(isNavigationAllowed('https://127.0.0.1:53123/?token=x', policy)).toBe(false);
    expect(isNavigationAllowed('file:///etc/passwd', policy)).toBe(false);
  });

  it('denies popups, foreign navigation and webview attachment', () => {
    const { window, listeners, openHandler } = buildFakeWindow();
    applyWindowSecurity(window as never, {
      allowedUrlPrefixes: ['file:///app/dist/renderer/index.html'],
    });

    const handler = openHandler();
    expect(handler).toBeDefined();
    expect(handler?.({})).toEqual({ action: 'deny' });

    const preventDefault = vi.fn();
    listeners.get('will-navigate')?.({ preventDefault }, 'https://evil.test/');
    expect(preventDefault).toHaveBeenCalledTimes(1);

    preventDefault.mockClear();
    listeners.get('will-navigate')?.({ preventDefault }, 'file:///app/dist/renderer/index.html');
    expect(preventDefault).not.toHaveBeenCalled();

    const webviewPrevent = vi.fn();
    listeners.get('will-attach-webview')?.({ preventDefault: webviewPrevent });
    expect(webviewPrevent).toHaveBeenCalledTimes(1);
  });
});

describe('resolveDataRoot', () => {
  it('prefers the flag, then the env, then userData', () => {
    expect(
      resolveDataRoot({
        argv: ['electron', DATA_ROOT_FLAG, '/tmp/from-flag'],
        env: { [DATA_ROOT_ENV]: '/tmp/from-env' },
        userDataDirectory: '/tmp/user-data',
      }),
    ).toBe('/tmp/from-flag');
    expect(
      resolveDataRoot({
        argv: ['electron'],
        env: { [DATA_ROOT_ENV]: '/tmp/from-env' },
        userDataDirectory: '/tmp/user-data',
      }),
    ).toBe('/tmp/from-env');
    expect(
      resolveDataRoot({ argv: ['electron'], env: {}, userDataDirectory: '/tmp/user-data' }),
    ).toBe('/tmp/user-data');
  });
});
