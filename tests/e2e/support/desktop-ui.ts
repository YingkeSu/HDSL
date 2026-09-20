/**
 * Real-renderer helpers for the desktop E2E slice.
 *
 * These helpers only talk to the real Electron page over CDP: they wait for the
 * React app to mount, read real DOM state, send real keys and call the frozen
 * contract through the preload bridge. Nothing here renders SSR markup or reads
 * source to infer behavior.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CdpClient } from './cdp.js';
import { sleep } from './gates.js';

export interface ContractEnvelope {
  readonly ok: boolean;
  readonly apiVersion: string;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message?: string; readonly retryable?: boolean };
}

export const CONTRACT_API_VERSION = '1.0';

/** Waits until the React root has rendered non-empty content. */
export const waitForRender = async (cdp: CdpClient, timeoutMs = 20_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const length = await cdp.evaluate<number>(
      "(document.getElementById('root')?.textContent ?? '').length",
    );
    if (typeof length === 'number' && length > 0) {
      return await cdp.evaluate<string>("document.getElementById('root').textContent ?? ''");
    }
    await sleep(150);
  }
  throw new Error(`renderer root did not render within ${String(timeoutMs)}ms`);
};

export const domText = async (cdp: CdpClient, selector: string): Promise<string> =>
  await cdp.evaluate<string>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? '' : (el.textContent ?? ''); })()`,
  );

export const domValue = async (cdp: CdpClient, selector: string): Promise<string | null> =>
  await cdp.evaluate<string | null>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : (el.value ?? null); })()`,
  );

export const domExists = async (cdp: CdpClient, selector: string): Promise<boolean> =>
  await cdp.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`);

export const domDisabled = async (cdp: CdpClient, selector: string): Promise<boolean> =>
  await cdp.evaluate<boolean>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? false : el.disabled === true; })()`,
  );

export interface ActiveElement {
  readonly id: string;
  readonly tag: string;
  readonly text: string;
}

export const activeElement = async (cdp: CdpClient): Promise<ActiveElement> =>
  await cdp.evaluate<ActiveElement>(
    "(() => { const el = document.activeElement; return { id: el?.id ?? '', tag: el?.tagName ?? '', text: (el?.textContent ?? '').trim() }; })()",
  );

export const focusSelector = async (cdp: CdpClient, selector: string): Promise<void> => {
  const focused = await cdp.evaluate<boolean>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el === null) return false; el.focus(); return document.activeElement === el; })()`,
  );
  if (!focused) {
    throw new Error(`cannot focus ${selector}`);
  }
};

interface ButtonCenter {
  readonly x: number;
  readonly y: number;
  readonly disabled: boolean;
}

/** Geometry of the button whose trimmed text equals `text`, or null. */
export const buttonByText = async (cdp: CdpClient, text: string): Promise<ButtonCenter | null> =>
  await cdp.evaluate<ButtonCenter | null>(
    `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)});
      if (button === undefined) return null;
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, disabled: button.disabled === true };
    })()`,
  );

/** A real mouse click on the button with the given label (no synthetic DOM events). */
export const clickButtonByText = async (cdp: CdpClient, text: string): Promise<void> => {
  const center = await buttonByText(cdp, text);
  if (center === null) {
    throw new Error(`button not found: ${text}`);
  }
  if (center.disabled) {
    throw new Error(`button is disabled: ${text}`);
  }
  const base = { x: center.x, y: center.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
};

/** The rendered environment state label from the detail panel (e.g. \u8fd0\u884c\u4e2d). */
export const environmentStateLabel = async (cdp: CdpClient): Promise<string> =>
  await cdp.evaluate<string>(
    "(() => { const dt = [...document.querySelectorAll('dt')].find((node) => (node.textContent ?? '').trim() === '状态'); return dt?.nextElementSibling?.textContent?.trim() ?? ''; })()",
  );

/** Text of the tracked-operation panel, or '' when no operation is shown. */
export const operationPanelText = async (cdp: CdpClient): Promise<string> =>
  await cdp.evaluate<string>(
    "(() => { const section = document.querySelector('section[aria-labelledby=\"operation-heading\"]'); return (section?.textContent ?? '').trim(); })()",
  );

/** Calls one frozen method through the real preload bridge. */
export const callContract = async (
  cdp: CdpClient,
  method: string,
  input: unknown,
): Promise<ContractEnvelope> => {
  const raw = await cdp.evaluate<string>(
    `window.hdsl.call({ apiVersion: ${JSON.stringify(CONTRACT_API_VERSION)}, method: ${JSON.stringify(method)}, input: ${JSON.stringify(input)} }).then((r) => JSON.stringify(r))`,
    { awaitPromise: true },
  );
  return JSON.parse(raw) as ContractEnvelope;
};

export const pollContract = async (
  cdp: CdpClient,
  method: string,
  input: unknown,
  done: (envelope: ContractEnvelope) => boolean,
  options: { readonly timeoutMs: number; readonly intervalMs?: number; readonly label: string },
): Promise<ContractEnvelope> => {
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + options.timeoutMs;
  let last: ContractEnvelope | null = null;
  while (Date.now() < deadline) {
    last = await callContract(cdp, method, input);
    if (done(last)) {
      return last;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${options.label}: condition not met; last=${JSON.stringify(last)}`);
};

export const operationStatus = (envelope: ContractEnvelope): string =>
  (envelope.value as { readonly status?: string } | undefined)?.status ?? 'unknown';

/** Environment ids present on disk in one dataRoot (independent of the UI). */
export const environmentIdsOnDisk = (dataRoot: string): readonly string[] => {
  const environments = join(dataRoot, 'environments');
  if (!existsSync(environments)) {
    return [];
  }
  return readdirSync(environments).sort();
};

export const readJsonIfPresent = (path: string): unknown => {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

export const waitForFile = async (
  path: string,
  options: { readonly timeoutMs: number; readonly label: string },
): Promise<void> => {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`${options.label}: file never appeared at ${path}`);
};
