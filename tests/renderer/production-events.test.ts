/**
 * Production renderer event wiring (issue #108).
 *
 * The injected preload bridge is untrusted input: `createBridgeEventSource`
 * re-validates every pushed payload against the shared event schema, so a
 * malformed or extra-field environment projection can never reach the
 * controller. This is the renderer half of the managed-process-exit refresh.
 */
import { API_VERSION, type EnvironmentSummary } from '@hdsl/contracts';
import { describe, expect, it } from 'vitest';
import type { PreloadBridge } from '../../apps/desktop/src/preload/index.js';
import {
  createBridgeEventSource,
  isPreloadBridge,
} from '../../apps/desktop/src/renderer/production.js';

const summary = (overrides: Partial<EnvironmentSummary> = {}): EnvironmentSummary => ({
  id: 'env-1',
  name: 'Env 1',
  revision: 1,
  stateVersion: 2,
  state: 'stopped',
  activeGenerationId: 'gen-1',
  compositionDigest: 'a'.repeat(64),
  ...overrides,
});

const bridge = (
  onEnvironmentUpdated: (listener: (event: unknown) => void) => () => void,
): PreloadBridge => ({
  call: () => Promise.resolve({ ok: true, apiVersion: API_VERSION, value: null }),
  onOperationUpdated: () => () => undefined,
  onEnvironmentUpdated,
  selectEnvironment: () => undefined,
});

describe('createBridgeEventSource environment projection', () => {
  it('forwards a schema-valid environment.updated projection', () => {
    let emit: (event: unknown) => void = () => undefined;
    const source = createBridgeEventSource(
      bridge((listener) => {
        emit = listener;
        return () => undefined;
      }),
    );
    const seen: EnvironmentSummary[] = [];
    const detach = source.subscribeEnvironment?.((environment) => seen.push(environment));

    const environment = summary();
    emit({ environment });
    expect(seen).toEqual([environment]);
    detach?.();
  });

  it('drops a malformed or extra-field projection before it reaches the controller', () => {
    let emit: (event: unknown) => void = () => undefined;
    const source = createBridgeEventSource(
      bridge((listener) => {
        emit = listener;
        return () => undefined;
      }),
    );
    const seen: EnvironmentSummary[] = [];
    const detach = source.subscribeEnvironment?.((environment) => seen.push(environment));

    emit({ environment: { ...summary(), secret: 'canary' } });
    emit({ environment: { id: 'bad id' } });
    emit({ notAnEnvironment: summary() });
    expect(seen).toEqual([]);
    detach?.();
  });
});

describe('isPreloadBridge', () => {
  it('requires the environment projection member and rejects the old three-member shape', () => {
    expect(isPreloadBridge(bridge(() => () => undefined))).toBe(true);
    expect(
      isPreloadBridge({
        call: () => Promise.resolve({}),
        onOperationUpdated: () => () => undefined,
        selectEnvironment: () => undefined,
      }),
    ).toBe(false);
  });
});
