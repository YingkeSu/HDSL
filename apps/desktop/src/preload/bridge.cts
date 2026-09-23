/**
 * Sandboxed runtime preload (T006 / issue #6).
 *
 * This is a CommonJS file (`.cts` -> `bridge.cjs`) because an Electron preload
 * with `sandbox: true` cannot use ESM. It is deliberately self-contained: it
 * imports nothing but Electron, so it can run inside the sandbox, and it
 * exposes exactly three members on `window.hdsl`:
 *
 * - `call(request)` forwards one `{ apiVersion, method, input }` envelope to the
 *   single validated main channel;
 * - `onOperationUpdated(listener)` subscribes to the operation-progress push
 *   channel and returns an unsubscriber;
 * - `onEnvironmentUpdated(listener)` subscribes to the environment-state
 *   projection channel (a managed process exiting) and returns an unsubscriber;
 * - `selectEnvironment(environmentId)` reports the renderer's opaque selection
 *   so the native credential menu can target a validated environment.
 *
 * There is no generic channel access and no token or cookie handling. The
 * channel literals are pinned to `src/ipc-channels.ts` by
 * `tests/desktop/preload-surface.test.ts`; keep them in sync.
 */
import electron = require('electron');

const CONTRACT_CHANNEL = 'hdsl:contract';
const SELECTION_CHANNEL = 'hdsl:selection';
const OPERATION_UPDATED_CHANNEL = 'operation.updated';
const ENVIRONMENT_UPDATED_CHANNEL = 'environment.updated';

const subscribe = (
  channel: string,
  listener: (event: unknown) => void,
): (() => void) => {
  if (typeof listener !== 'function') {
    return () => undefined;
  }
  const wrapped = (_event: unknown, payload: unknown): void => {
    listener(payload);
  };
  electron.ipcRenderer.on(channel, wrapped);
  return () => {
    electron.ipcRenderer.removeListener(channel, wrapped);
  };
};

const bridge = {
  call(request: unknown): Promise<unknown> {
    return electron.ipcRenderer.invoke(CONTRACT_CHANNEL, request) as Promise<unknown>;
  },
  onOperationUpdated(listener: (event: unknown) => void): () => void {
    return subscribe(OPERATION_UPDATED_CHANNEL, listener);
  },
  onEnvironmentUpdated(listener: (event: unknown) => void): () => void {
    return subscribe(ENVIRONMENT_UPDATED_CHANNEL, listener);
  },
  selectEnvironment(environmentId: string): void {
    electron.ipcRenderer.send(SELECTION_CHANNEL, environmentId);
  },
};

electron.contextBridge.exposeInMainWorld('hdsl', bridge);
