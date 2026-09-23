/**
 * Production-wiring regression for the managed-process-exit projection
 * (issue #108 review): the real `DesktopIpcHost` hands the Electron entry an
 * explicit fixed channel, so an operation event and an environment projection
 * can never be delivered on each other's channel.
 *
 * A prior revision hardcoded `operation.updated` in the entry's `send` closure,
 * so `broadcastEnvironmentUpdate` delivered its payload on the operation
 * channel; the preload only subscribed to `environment.updated` and the
 * renderer never refreshed. These tests drive the real host, the real preload
 * event source and the real renderer controller (fake `send`, no Electron), so
 * a channel regression is caught without a real window.
 */
import {
  API_VERSION,
  type ContractResponse,
  type EnvironmentSummary,
} from '@hdsl/contracts';
import { createReferenceRuntime } from '@hdsl/contracts/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DesktopIpcHost,
  HDSL_ENVIRONMENT_UPDATED_CHANNEL,
  HDSL_OPERATION_UPDATED_CHANNEL,
  type SenderIdentity,
} from '../../apps/desktop/src/main/ipc.js';
import type { PreloadBridge } from '../../apps/desktop/src/preload/index.js';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import {
  createBridgeClient,
  createBridgeEventSource,
} from '../../apps/desktop/src/renderer/production.js';

const DOCUMENT_URL = 'file:///app/dist/renderer/index.html';

const identity = (webContentsId: number): SenderIdentity => ({
  webContentsId,
  isMainFrame: true,
  frameUrl: DOCUMENT_URL,
});

interface SentEvent {
  readonly webContentsId: number;
  readonly channel: string;
  readonly event: unknown;
}

const envelope = (method: string, input: unknown): unknown => ({
  apiVersion: API_VERSION,
  method,
  input,
});

const wiredHost = () => {
  const { port } = createReferenceRuntime();
  const sent: SentEvent[] = [];
  const listeners = new Map<number, { operation: Set<(event: unknown) => void>; environment: Set<(event: unknown) => void> }>();
  const host = new DesktopIpcHost({ port, policy: { allowedDocumentUrl: DOCUMENT_URL } });

  const open = (webContentsId: number, throwOnSend = false): void => {
    listeners.set(webContentsId, { operation: new Set(), environment: new Set() });
    host.openWindow({
      webContentsId,
      send: (channel, event) => {
        if (throwOnSend) {
          throw new Error('window destroyed');
        }
        sent.push({ webContentsId, channel, event });
        const target =
          channel === HDSL_OPERATION_UPDATED_CHANNEL
            ? listeners.get(webContentsId)?.operation
            : channel === HDSL_ENVIRONMENT_UPDATED_CHANNEL
              ? listeners.get(webContentsId)?.environment
              : undefined;
        for (const listener of target ?? []) {
          listener(event);
        }
      },
    });
  };

  const bridgeFor = (webContentsId: number): PreloadBridge => ({
    call: (request: unknown) => host.handle(identity(webContentsId), request),
    onOperationUpdated: (listener) => {
      const set = listeners.get(webContentsId)?.operation;
      set?.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
    onEnvironmentUpdated: (listener) => {
      const set = listeners.get(webContentsId)?.environment;
      set?.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
    selectEnvironment: () => undefined,
  });

  return { host, port, sent, open, bridgeFor };
};

const runningSummary = (port: ReturnType<typeof createReferenceRuntime>['port']): EnvironmentSummary => {
  const listed = port.listEnvironments();
  if (!listed.ok) {
    throw new Error('the reference port must list environments');
  }
  const running = listed.value.find((environment) => environment.state === 'running');
  if (running === undefined) {
    throw new Error('the reference seed must contain a running environment');
  }
  return running;
};

afterEach(() => {
  // Nothing global to reset; kept for symmetry with the other desktop suites.
});

describe('environment projection channel routing', () => {
  it('sends operation events on operation.updated and projections on environment.updated only', async () => {
    const wiring = wiredHost();
    wiring.open(1);
    wiring.open(2);
    const bridge = wiring.bridgeFor(1);

    const subscribed = (await bridge.call(
      envelope('operations.subscribe', { requestId: 'req-sub-0001' }),
    )) as ContractResponse<unknown>;
    expect(subscribed.ok).toBe(true);

    // A real contract call that publishes a real operation event to window 1's
    // subscription through the real registry -> send path.
    const started = (await bridge.call(
      envelope('environments.start', {
        requestId: 'req-start-01',
        environmentId: 'env-stopped',
        expectedRevision: 1,
      }),
    )) as ContractResponse<unknown>;
    expect(started.ok).toBe(true);

    const operationEvents = wiring.sent.filter(
      (entry) => entry.channel === HDSL_OPERATION_UPDATED_CHANNEL,
    );
    expect(operationEvents.length).toBeGreaterThan(0);
    // Only the subscribing window receives operation events.
    expect(operationEvents.every((entry) => entry.webContentsId === 1)).toBe(true);
    expect(
      wiring.sent.filter((entry) => entry.channel === HDSL_ENVIRONMENT_UPDATED_CHANNEL),
    ).toHaveLength(0);

    const running = runningSummary(wiring.port);
    const stopped: EnvironmentSummary = {
      ...running,
      state: 'stopped',
      stateVersion: running.stateVersion + 1,
    };
    expect(wiring.host.broadcastEnvironmentUpdate(stopped)).toBe(2);

    const environmentEvents = wiring.sent.filter(
      (entry) => entry.channel === HDSL_ENVIRONMENT_UPDATED_CHANNEL,
    );
    expect(environmentEvents).toHaveLength(2);
    expect(environmentEvents.map((entry) => entry.webContentsId).sort()).toEqual([1, 2]);
    for (const entry of environmentEvents) {
      expect(entry.event).toEqual({ environment: stopped });
    }
    // The projection must never arrive as an operation event.
    const leaked = wiring.sent.filter(
      (entry) =>
        entry.channel === HDSL_OPERATION_UPDATED_CHANNEL &&
        typeof entry.event === 'object' &&
        entry.event !== null &&
        'environment' in entry.event,
    );
    expect(leaked).toEqual([]);
  });

  it('keeps multi-window and destroyed-window boundaries intact', () => {
    const wiring = wiredHost();
    wiring.open(1);
    wiring.open(2);
    const running = runningSummary(wiring.port);
    const stopped: EnvironmentSummary = {
      ...running,
      state: 'stopped',
      stateVersion: running.stateVersion + 1,
    };
    wiring.sent.length = 0;

    // A window whose sender throws must not stop delivery to the others.
    wiring.open(3, true);
    expect(wiring.host.broadcastEnvironmentUpdate(stopped)).toBe(2);
    expect(wiring.sent.map((entry) => entry.webContentsId).sort()).toEqual([1, 2]);

    // A destroyed window is no longer a delivery target.
    wiring.host.closeWindow(2);
    wiring.sent.length = 0;
    expect(wiring.host.broadcastEnvironmentUpdate(stopped)).toBe(1);
    expect(wiring.sent.map((entry) => entry.webContentsId)).toEqual([1]);
  });

  it('refreshes the real renderer through the real preload event source', async () => {
    const wiring = wiredHost();
    wiring.open(1);
    const bridge = wiring.bridgeFor(1);
    const controller = new RendererController({
      client: createBridgeClient(bridge),
      events: createBridgeEventSource(bridge),
    });
    try {
      await controller.load();
      const running = controller
        .getState()
        .environments.find((environment) => environment.state === 'running');
      expect(running).toBeDefined();
      if (running === undefined) {
        return;
      }
      expect(running.state).toBe('running');

      const stopped: EnvironmentSummary = {
        ...running,
        state: 'stopped',
        stateVersion: running.stateVersion + 1,
      };
      const delivered = wiring.host.broadcastEnvironmentUpdate(stopped);
      expect(delivered).toBe(1);

      // If the payload had been sent on `operation.updated`, the preload's
      // environment subscription would never fire and this would stay running.
      const updated = controller
        .getState()
        .environments.find((environment) => environment.id === running.id);
      expect(updated?.state).toBe('stopped');

      // `environments.list` stays the authority: the merge used the push only.
      expect(
        wiring.sent.some((entry) => entry.channel === HDSL_ENVIRONMENT_UPDATED_CHANNEL),
      ).toBe(true);
    } finally {
      await controller.dispose();
    }
  });
});
