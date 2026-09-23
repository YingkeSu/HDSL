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
  HDSL_ENVIRONMENT_UPDATED_CHANNEL,
  HDSL_OPERATION_UPDATED_CHANNEL,
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

interface SentEvent {
  readonly channel: string;
  readonly event: unknown;
}

const buildHost = (maxSubscriptionsPerWindow?: number) => {
  const { port } = createReferenceRuntime();
  const sent: Record<number, SentEvent[]> = { 1: [], 2: [] };
  const host = new DesktopIpcHost({
    port,
    policy: { allowedDocumentUrl: DOCUMENT_URL },
    ...(maxSubscriptionsPerWindow === undefined ? {} : { maxSubscriptionsPerWindow }),
  });
  host.openWindow({
    webContentsId: 1,
    send: (channel, event) => sent[1]?.push({ channel, event }),
  });
  host.openWindow({
    webContentsId: 2,
    send: (channel, event) => sent[2]?.push({ channel, event }),
  });
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
    expect((sent[1] ?? []).some((entry) => entry.channel === HDSL_OPERATION_UPDATED_CHANNEL)).toBe(
      true,
    );
    expect(sent[2] ?? []).toHaveLength(0);
  });
});

describe('DesktopIpcHost environment projection', () => {
  it('broadcasts a validated environment summary to every open window', () => {
    const { host, port, sent } = buildHost();
    const listed = port.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const base = listed.value[0];
    expect(base).toBeDefined();
    if (base === undefined) {
      return;
    }
    const environment = {
      ...base,
      state: 'stopped' as const,
      stateVersion: base.stateVersion + 1,
    };
    expect(host.broadcastEnvironmentUpdate(environment)).toBe(2);
    expect(sent[1]).toEqual([{ channel: HDSL_ENVIRONMENT_UPDATED_CHANNEL, event: { environment } }]);
    expect(sent[2]).toEqual([{ channel: HDSL_ENVIRONMENT_UPDATED_CHANNEL, event: { environment } }]);
    // The projection must never leak onto the operation-progress channel.
    expect(sent[1]?.some((entry) => entry.channel === HDSL_OPERATION_UPDATED_CHANNEL)).toBe(false);
  });

  it('drops an invalid projection instead of forwarding it', () => {
    const { host, sent } = buildHost();
    const invalid = { id: 'bad id' } as unknown as Parameters<
      typeof host.broadcastEnvironmentUpdate
    >[0];
    expect(host.broadcastEnvironmentUpdate(invalid)).toBe(0);
    expect(sent[1]).toEqual([]);
    expect(sent[2]).toEqual([]);
  });

  it('keeps delivering to the remaining windows when one sender throws', () => {
    const { port } = createReferenceRuntime();
    const host = new DesktopIpcHost({ port, policy: { allowedDocumentUrl: DOCUMENT_URL } });
    const received: SentEvent[] = [];
    host.openWindow({
      webContentsId: 1,
      send: () => {
        throw new Error('window destroyed');
      },
    });
    host.openWindow({
      webContentsId: 2,
      send: (channel, event) => received.push({ channel, event }),
    });
    const listed = port.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const environment = listed.value[0];
    expect(environment).toBeDefined();
    if (environment === undefined) {
      return;
    }
    expect(host.broadcastEnvironmentUpdate(environment)).toBe(1);
    expect(received).toEqual([
      { channel: HDSL_ENVIRONMENT_UPDATED_CHANNEL, event: { environment } },
    ]);
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
