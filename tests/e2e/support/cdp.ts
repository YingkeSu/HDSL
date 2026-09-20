/**
 * Minimal Chrome DevTools Protocol client for the desktop E2E slice.
 *
 * QA drives the real Electron renderer through CDP using only Node built-ins
 * (`WebSocket`, `fetch`), so no Playwright/puppeteer dependency is added to the
 * workspace root (owned by #6) and no lockfile change is needed. It is an
 * independent composition on top of the candidate's own launch entry.
 *
 * Nothing here fakes a renderer: `evaluate` runs in the real page context and
 * `typeText`/`pressKey` send real input events through the `Input` domain, which
 * is what makes the keyboard checks real React interaction instead of DOM
 * mutation or SSR markup.
 */

export class CdpError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface CdpClient {
  /** Raw protocol call. */
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Evaluates in the page and returns the by-value result. */
  evaluate<T = unknown>(expression: string, options?: { readonly awaitPromise?: boolean }): Promise<T>;
  /** Real keyboard text entry (`keyDown` with text, then `keyUp`). */
  typeText(text: string): Promise<void>;
  /** Real non-text key press (Tab/Enter/ArrowDown/...). */
  pressKey(key: KeyName): Promise<void>;
  /** Registered console/exception messages, for diagnostics assertions. */
  consoleMessages(): readonly string[];
  close(): Promise<void>;
}

export type KeyName = 'Tab' | 'Enter' | 'Escape' | 'ArrowDown' | 'ArrowUp' | 'Space';

const KEYS: Record<KeyName, { readonly key: string; readonly code: string; readonly virtualKeyCode: number; readonly text?: string }> = {
  Tab: { key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 },
  Space: { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' },
};

export const connectCdp = async (
  webSocketDebuggerUrl: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<CdpClient> => {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map<number, PendingCall>();
  const consoleMessages: string[] = [];

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpError(`CDP socket did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new CdpError('CDP socket error before open'));
    });
  });

  socket.addEventListener('message', (event) => {
    const text = typeof event.data === 'string' ? event.data : '';
    if (text === '') {
      return;
    }
    let message: {
      readonly id?: number;
      readonly method?: string;
      readonly params?: unknown;
      readonly result?: unknown;
      readonly error?: unknown;
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Log.entryAdded') {
      consoleMessages.push(JSON.stringify(message.params));
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const call = pending.get(message.id);
    if (call === undefined) {
      return;
    }
    pending.delete(message.id);
    if (message.error !== undefined) {
      call.reject(new CdpError(`CDP ${String(message.id)} failed: ${JSON.stringify(message.error)}`));
      return;
    }
    call.resolve(message.result);
  });

  socket.addEventListener('close', () => {
    for (const call of pending.values()) {
      call.reject(new CdpError('CDP socket closed with pending calls'));
    }
    pending.clear();
  });

  await opened;

  const send = async <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    const id = nextId;
    nextId += 1;
    const payload = params === undefined ? { id, method } : { id, method, params };
    const result = await new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(payload));
    });
    return result as T;
  };

  const evaluate = async <T = unknown>(
    expression: string,
    opts: { readonly awaitPromise?: boolean } = {},
  ): Promise<T> => {
    const result = await send<{
      readonly result: { readonly value?: unknown; readonly description?: string };
      readonly exceptionDetails?: unknown;
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise ?? false,
    });
    if (result.exceptionDetails !== undefined) {
      throw new CdpError(`evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value as T;
  };

  const typeText = async (text: string): Promise<void> => {
    for (const char of text) {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
        unmodifiedText: char,
        key: char,
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    }
  };

  const pressKey = async (key: KeyName): Promise<void> => {
    const definition = KEYS[key];
    const base = {
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.virtualKeyCode,
      nativeVirtualKeyCode: definition.virtualKeyCode,
    };
    // A key that produces text (Enter/Space) must use `keyDown` with `text` so
    // Chromium generates the same activation/char event a real key would;
    // `rawKeyDown` alone does not activate a focused button.
    await send('Input.dispatchKeyEvent', {
      ...base,
      type: definition.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...(definition.text === undefined ? {} : { text: definition.text }),
    });
    await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  };

  return {
    send,
    evaluate,
    typeText,
    pressKey,
    consoleMessages: () => [...consoleMessages],
    close: async () => {
      await new Promise<void>((resolve) => {
        if (socket.readyState === 3) {
          resolve();
          return;
        }
        socket.addEventListener('close', () => {
          resolve();
        });
        socket.close();
      });
    },
  };
};
