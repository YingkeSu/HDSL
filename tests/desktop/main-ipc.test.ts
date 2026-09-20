/**
 * Narrow IPC host tests (T006 / issue #6).
 *
 * Drives the real host with the frozen reference contract port (a test double)
 * and a fake `send`, so no Electron process is required. Covers sender
 * authorization, per-window subscription scope, quota, window-destroy cleanup,
 * validated selection and the async pre-dispatch hook.
 */
import { describe, expect, it } from 'vitest';
import { API_VERSION, contractErrorForCode, contractFail } from '@hdsl/contracts';
import { createReferenceRuntime } from '@hdsl/contracts/testing';
import {
  DesktopIpcHost,
  isAuthorizedSender,
  type SenderIdentity,
} from '../../apps/desktop/src/main/ipc.js';

const DOCUMENT_URL = 'file:///app/dist/renderer/index.html';
const identity = (webContentsId: number, overrides: Partial<SenderIdentity> = {}): SenderIdentity => ({
  webContentsId,
  isMainFrame: true,
  frameUrl: DOCUMENT_URL,
  ...overrides,
});

const envelope = (method: string, input: unknown): unknown => ({
  apiVersion: API_VERSION,
  method,
  input,
});

const buildHost = (maxSubscriptionsPerWindow?: number) => {
  const { port } = createReferenceRuntime();
  const sent: Record<number, unknown[]> = { 1: [], 2: [] };
  const host = new DesktopIpcHost({
    port,
    policy: { allowedDocumentUrl: DOCUMENT_URL },
    ...(maxSubscriptionsPerWindow === undefined ? {} : { maxSubscriptionsPerWindow }),
  });
  host.openWindow({ webContentsId: 1, send: (event) => sent[1]?.push(event) });
  host.openWindow({ webContentsId: 2, send: (event) => sent[2]?.push(event) });
  return { host, port, sent };
};

describe('DesktopIpcHost authorization', () => {
  it('rejects a subframe, a foreign URL and an unknown window', () => {
    const policy = { allowedDocumentUrl: DOCUMENT_URL };
    expect(isAuthorizedSender(identity(1, { isMainFrame: false }), policy)).toBe(false);
    expect(isAuthorizedSender(identity(1, { frameUrl: 'file:///etc/passwd' }), policy)).toBe(false);
    for (const url of [
      `${DOCUMENT_URL}.evil`,
      `${DOCUMENT_URL}/../secret`,
      `${DOCUMENT_URL}%2f..%2fsecret`,
      `${DOCUMENT_URL}?token=canary`,
    ]) {
      expect(isAuthorizedSender(identity(1, { frameUrl: url }), policy)).toBe(false);
    }
    expect(isAuthorizedSender(identity(1), policy)).toBe(true);
  });

  it('returns a controlled INTERNAL_ERROR envelope for an unauthorized caller', async () => {
    const { host } = buildHost();
    const response = await host.handle(
      identity(1, { isMainFrame: false }),
      envelope('catalog.list', {}),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INTERNAL_ERROR');
    }
    const unknownWindow = await host.handle(identity(99), envelope('catalog.list', {}));
    expect(unknownWindow.ok).toBe(false);
  });
});

describe('DesktopIpcHost subscription scope and quota', () => {
  it('isolates subscriptions per window and releases them on destroy', async () => {
    const { host } = buildHost();
    const subscribed = await host.handle(
      identity(1),
      envelope('operations.subscribe', { requestId: 'req-sub-0001' }),
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) {
      return;
    }
    const subscriptionId = (subscribed.value as { subscriptionId: string }).subscriptionId;
    expect(host.subscriptionCount(1)).toBe(1);

    // Window 2 cannot unsubscribe window 1's subscription.
    const stolen = await host.handle(
      identity(2),
      envelope('operations.unsubscribe', { requestId: 'req-unsub-02', subscriptionId }),
    );
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) {
      expect(stolen.error.code).toBe('NOT_FOUND');
    }

    host.closeWindow(1);
    expect(host.subscriptionCount(1)).toBe(0);
    expect(host.hasWindow(1)).toBe(false);
  });

  it('enforces the per-window subscription quota', async () => {
    const { host } = buildHost(1);
    const first = await host.handle(
      identity(1),
      envelope('operations.subscribe', { requestId: 'req-sub-0001' }),
    );
    expect(first.ok).toBe(true);
    const second = await host.handle(
      identity(1),
      envelope('operations.subscribe', { requestId: 'req-sub-0002' }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('ENVIRONMENT_BUSY');
    }
    expect(host.subscriptionCount(1)).toBe(1);
  });

  it('delivers operation events only to the subscribing window', async () => {
    const { host, sent } = buildHost();
    await host.handle(identity(1), envelope('operations.subscribe', { requestId: 'req-sub-0001' }));
    const catalog = await host.handle(identity(1), envelope('catalog.list', {}));
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) {
      return;
    }
    const combinationId = (catalog.value as { id: string }[])[0]?.id;
    expect(combinationId).toBeDefined();

    const created = await host.handle(
      identity(1),
      envelope('environments.create', {
        requestId: 'req-create-01',
        name: '接线环境',
        catalogCombinationId: combinationId,
      }),
    );
    expect(created.ok).toBe(true);
    expect((sent[1] ?? []).length).toBeGreaterThan(0);
    expect(sent[2] ?? []).toHaveLength(0);
  });
});

describe('DesktopIpcHost selection', () => {
  it('stores only a selection that resolves in the current environment list', async () => {
    const { host, port } = buildHost();
    expect(host.selectEnvironment(1, 'env-does-not-exist')).toBe(false);
    expect(host.selectionFor(1)).toBeNull();

    const listed = port.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const environmentId = listed.value[0]?.id;
    expect(environmentId).toBeDefined();
    expect(host.selectEnvironment(1, environmentId)).toBe(true);
    expect(host.selectionFor(1)).toBe(environmentId);
  });
});

describe('DesktopIpcHost beforeDispatch', () => {
  it('short-circuits dispatch with the hook response', async () => {
    const { port } = createReferenceRuntime();
    const host = new DesktopIpcHost({
      port,
      policy: { allowedDocumentUrl: DOCUMENT_URL },
      beforeDispatch: async (context) =>
        context.method === 'environments.openWebUI'
          ? contractFail(API_VERSION, contractErrorForCode('WEBUI_UNAVAILABLE'))
          : undefined,
    });
    host.openWindow({ webContentsId: 1, send: () => undefined });
    const effectsBefore = port.effects.length;
    const response = await host.handle(
      identity(1),
      envelope('environments.openWebUI', { requestId: 'req-open-01', environmentId: 'env-1' }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('WEBUI_UNAVAILABLE');
    }
    expect(port.effects.length).toBe(effectsBefore);
  });
});
