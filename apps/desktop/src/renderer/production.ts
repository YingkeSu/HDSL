/**
 * Production renderer wiring (T006 / issue #6).
 *
 * The renderer is mounted with an **explicitly injected** bridge. There is no
 * default and no mock fallback: if `window.hdsl` is missing or malformed,
 * mounting fails instead of silently rendering the developer demo.
 *
 * The bridge is treated as untrusted input: the client re-validates the response
 * envelope against the frozen version, and every pushed event is validated
 * against either `operationUpdatedEventSchema` (operation progress) or
 * `environmentUpdatedEventSchema` (a managed-process-exit projection) before it
 * can reach the controller. The renderer never receives a token-bearing URL
 * (only a loopback origin).
 */
import {
  API_VERSION,
  CONTRACT_METHODS,
  contractErrorForCode,
  contractFail,
  environmentUpdatedEventSchema,
  isPlainRecord,
  operationUpdatedEventSchema,
  type ContractMethod,
  type ContractResponse,
  type EnvironmentSummary,
  type OperationUpdatedEvent,
  type ValidationIssue,
} from '@hdsl/contracts';
import type { PreloadBridge } from '../preload/index.js';
import { renderRenderer } from './index.js';
import type { RendererContractClient } from './contract.js';
import type { RendererEventSource } from './controller.js';

/** Structural check for the injected bridge; no member may be assumed. */
export const isPreloadBridge = (value: unknown): value is PreloadBridge => {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    typeof value['call'] === 'function' &&
    typeof value['onOperationUpdated'] === 'function' &&
    typeof value['onEnvironmentUpdated'] === 'function' &&
    typeof value['selectEnvironment'] === 'function'
  );
};

const coerceEnvelope = (response: unknown): ContractResponse<unknown> => {
  if (isPlainRecord(response) && response['apiVersion'] === API_VERSION && typeof response['ok'] === 'boolean') {
    return response as unknown as ContractResponse<unknown>;
  }
  return contractFail(API_VERSION, contractErrorForCode('INTERNAL_ERROR'));
};

export const createBridgeClient = (bridge: PreloadBridge): RendererContractClient => ({
  apiVersion: API_VERSION,
  methods: CONTRACT_METHODS,
  call(method: ContractMethod, input: unknown): Promise<ContractResponse<unknown>> {
    return bridge.call({ apiVersion: API_VERSION, method, input }).then(coerceEnvelope);
  },
});

export const createBridgeEventSource = (bridge: PreloadBridge): RendererEventSource => ({
  subscribe(listener: (event: OperationUpdatedEvent) => void): () => void {
    return bridge.onOperationUpdated((raw) => {
      const issues: ValidationIssue[] = [];
      const parsed = operationUpdatedEventSchema(raw, 'event', issues);
      if (parsed !== undefined) {
        listener(parsed);
      }
    });
  },
  subscribeEnvironment(listener: (environment: EnvironmentSummary) => void): () => void {
    return bridge.onEnvironmentUpdated((raw) => {
      const issues: ValidationIssue[] = [];
      const parsed = environmentUpdatedEventSchema(raw, 'event', issues);
      if (parsed !== undefined) {
        listener(parsed.environment);
      }
    });
  },
});

/** Mounts the app with the injected bridge and reports selection changes to main. */
export const mountProductionRenderer = (
  container: Element,
  bridge: PreloadBridge,
): (() => Promise<void>) =>
  renderRenderer(container, createBridgeClient(bridge), {
    events: createBridgeEventSource(bridge),
    onSelectionChange: (environmentId) => {
      bridge.selectEnvironment(environmentId);
    },
  });

/** Browser entry helper; throws instead of falling back to the demo. */
export const startProductionRenderer = (): (() => Promise<void>) => {
  const bridge: unknown = (globalThis as { readonly hdsl?: unknown }).hdsl;
  if (!isPreloadBridge(bridge)) {
    throw new Error(
      'window.hdsl is not available; the launcher preload bridge is required and there is no mock fallback.',
    );
  }
  const container = document.getElementById('root');
  if (container === null) {
    throw new Error('the renderer root element is missing');
  }
  return mountProductionRenderer(container, bridge);
};
