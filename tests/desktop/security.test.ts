/**
 * Window security + trusted-URL + data-root resolution tests (T006 / issue #6).
 *
 * The exact-document-URL policy is the security P2-1 fix: IPC sender
 * authorization and navigation authorization share it, and suffix, traversal,
 * encoded separator, query/hash and subframe variants are all rejected.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyWindowSecurity,
  isTrustedDocumentUrl,
  SECURE_WINDOW_DEFAULTS,
} from '../../apps/desktop/src/main/security.js';
import { createTrustedUrlPolicy } from '../../apps/desktop/src/main/trusted-url.js';
import { DATA_ROOT_ENV, DATA_ROOT_FLAG, resolveDataRoot } from '../../apps/desktop/src/main/data-root.js';

const DOCUMENT_URL = 'file:///app/dist/renderer/index.html';

interface FakeWindow {
  readonly webContents: {
    setWindowOpenHandler: (handler: (details: unknown) => unknown) => void;
    on: (event: string, listener: (details: unknown, url?: string) => void) => void;
  };
}

const buildFakeWindow = () => {
  let openHandler: ((details: unknown) => unknown) | undefined;
  const listeners = new Map<string, (details: unknown, url?: string) => void>();
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

describe('trusted renderer document URL policy', () => {
  const policy = createTrustedUrlPolicy(DOCUMENT_URL);

  it('accepts only the exact normalized document URL', () => {
    expect(isTrustedDocumentUrl(DOCUMENT_URL, policy)).toBe(true);
    expect(isTrustedDocumentUrl('file:///app/dist/renderer/./index.html', policy)).toBe(true);
  });

  it.each([
    ['path suffix', 'file:///app/dist/renderer/index.html.evil'],
    ['path continuing', 'file:///app/dist/renderer/index.html/extra'],
    ['traversal', 'file:///app/dist/renderer/index.html/../../secret'],
    ['encoded slash', 'file:///app/dist/renderer/index.html%2f..%2fsecret'],
    ['encoded backslash', 'file:///app/dist/renderer/index.html%5c..%5csecret'],
    ['query', 'file:///app/dist/renderer/index.html?token=canary'],
    ['hash', 'file:///app/dist/renderer/index.html#/x'],
    ['other origin', 'https://127.0.0.1:53123/index.html'],
    ['directory', 'file:///app/dist/renderer/'],
    ['empty', ''],
    ['not a url', 'not-a-url'],
  ])('rejects %s', (_label, url) => {
    expect(isTrustedDocumentUrl(url, policy)).toBe(false);
  });
});

describe('navigation policy', () => {
  it('denies popups, foreign navigation, subframe navigation and webviews', () => {
    const { window, listeners, openHandler } = buildFakeWindow();
    applyWindowSecurity(window as never, createTrustedUrlPolicy(DOCUMENT_URL));

    const handler = openHandler();
    expect(handler).toBeDefined();
    expect(handler?.({})).toEqual({ action: 'deny' });

    const mainPrevent = vi.fn();
    listeners.get('will-navigate')?.({ preventDefault: mainPrevent }, 'https://evil.test/');
    expect(mainPrevent).toHaveBeenCalledTimes(1);

    mainPrevent.mockClear();
    listeners.get('will-navigate')?.({ preventDefault: mainPrevent }, DOCUMENT_URL);
    expect(mainPrevent).not.toHaveBeenCalled();

    // Subframe navigation is always denied, even to the trusted URL.
    const subframePrevent = vi.fn();
    listeners.get('will-frame-navigate')?.({
      url: DOCUMENT_URL,
      isMainFrame: false,
      preventDefault: subframePrevent,
    });
    expect(subframePrevent).toHaveBeenCalledTimes(1);

    // A main-frame navigation to a non-trusted URL is denied.
    const untrustedPrevent = vi.fn();
    listeners.get('will-frame-navigate')?.({
      url: 'file:///etc/passwd',
      isMainFrame: true,
      preventDefault: untrustedPrevent,
    });
    expect(untrustedPrevent).toHaveBeenCalledTimes(1);

    // The trusted main-frame document is allowed.
    const trustedPrevent = vi.fn();
    listeners.get('will-frame-navigate')?.({
      url: DOCUMENT_URL,
      isMainFrame: true,
      preventDefault: trustedPrevent,
    });
    expect(trustedPrevent).not.toHaveBeenCalled();

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
