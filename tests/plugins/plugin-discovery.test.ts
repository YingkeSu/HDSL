/**
 * Core plugin discovery lifecycle tests (issue #75, S1).
 *
 * These drive the real core service with a controlled source adapter and a real
 * temporary data root. They prove the operation terminal states (succeeded with
 * payload / failed with a controlled code / cancelled with no side effect),
 * never the real GitHub API.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_VERSION,
  createContractRuntime,
  portFail,
  portOk,
  type OperationSnapshot,
  type PortOutcome,
} from '@hdsl/contracts';
import {
  createEnvironmentContractPort,
  ensureLayout,
  isTerminalStatus,
  PluginDiscoveryService,
  resolveLayout,
  type EnvironmentService,
  type PluginSourcePort,
} from '@hdsl/core';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const makeService = (source: PluginSourcePort): PluginDiscoveryService => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-plugin-'));
  roots.push(root);
  const layout = resolveLayout(root);
  ensureLayout(layout);
  return new PluginDiscoveryService({ layout, source });
};

const terminal = async (
  service: PluginDiscoveryService,
  operationId: string,
): Promise<OperationSnapshot> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = service.findOperation(operationId);
    if (snapshot !== undefined && snapshot.ok && isTerminalStatus(snapshot.value.status)) {
      return snapshot.value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 2);
    });
  }
  throw new Error('operation did not reach a terminal state');
};

const result = {
  query: 'topic:dsh-plugin',
  hits: [],
  totalCount: 0,
  incompleteResults: false,
  hasMore: false,
  fetchedAt: '2026-01-02T03:04:05Z',
  fromCache: false,
};

describe('PluginDiscoveryService', () => {
  it('runs a global search to a succeeded operation carrying the validated payload', async () => {
    const source: PluginSourcePort = {
      search: () => Promise.resolve(portOk(result)),
      inspect: () => Promise.resolve(portFail('INTERNAL_ERROR', 'unused')),
    };
    const service = makeService(source);
    const started = service.search({ requestId: 'req-1', query: 'topic:dsh-plugin' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const snapshot = await terminal(service, started.value.operationId);
    expect(snapshot.status).toBe('succeeded');
    expect(snapshot.kind).toBe('search');
    expect(snapshot.environmentId).toBeNull();
    expect(snapshot.output).toEqual(result);
    expect(snapshot.error).toBeUndefined();
  });

  it('maps a rate-limited source failure to a controlled code with retryAfterSeconds', async () => {
    const source: PluginSourcePort = {
      search: () => Promise.resolve(portFail('RATE_LIMITED', 'raw upstream text', { retryAfterSeconds: 45 })),
      inspect: () => Promise.resolve(portFail('INTERNAL_ERROR', 'unused')),
    };
    const service = makeService(source);
    const started = service.search({ requestId: 'req-2', query: 'topic:dsh-plugin' });
    if (!started.ok) throw new Error('search did not start');

    const snapshot = await terminal(service, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.output).toBeUndefined();
    expect(snapshot.error?.code).toBe('RATE_LIMITED');
    expect(snapshot.error?.retryable).toBe(true);
    expect(snapshot.error?.retryAfterSeconds).toBe(45);
    // The port's raw message never reaches the record or the wire.
    expect(JSON.stringify(snapshot)).not.toContain('raw upstream text');
  });

  it('cancels an in-flight search: terminal cancelled, no payload, and a late result cannot revive it', async () => {
    let resolveSearch: ((value: PortOutcome<typeof result>) => void) | undefined;
    let observedSignal: AbortSignal | null = null;
    const source: PluginSourcePort = {
      search: (_query, signal) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          resolveSearch = resolve;
        });
      },
      inspect: () => Promise.resolve(portFail('INTERNAL_ERROR', 'unused')),
    };
    const service = makeService(source);
    const started = service.search({ requestId: 'req-3', query: 'topic:dsh-plugin' });
    if (!started.ok) throw new Error('search did not start');
    const operationId = started.value.operationId;

    const cancelled = service.cancelOperation(operationId);
    expect(cancelled?.ok).toBe(true);
    if (cancelled?.ok !== true) return;
    expect(cancelled.value.status).toBe('cancelled');
    expect(cancelled.value.output).toBeUndefined();
    const signal = observedSignal as AbortSignal | null;
    expect(signal?.aborted).toBe(true);

    // A late success must not revive a final operation.
    resolveSearch?.(portOk(result));
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    const snapshot = service.findOperation(operationId);
    expect(snapshot?.ok && snapshot.value.status).toBe('cancelled');
    expect(snapshot?.ok && snapshot.value.output).toBeUndefined();
    expect(service.cancelOperation(operationId)?.ok).toBe(false);
  });

  it('does not own environment operations, so the composite port still reports NOT_FOUND', () => {
    const source: PluginSourcePort = {
      search: () => Promise.resolve(portOk(result)),
      inspect: () => Promise.resolve(portFail('INTERNAL_ERROR', 'unused')),
    };
    const service = makeService(source);
    expect(service.owns('op-not-plugin')).toBe(false);
    expect(service.findOperation('op-not-plugin')).toBeUndefined();
    expect(service.cancelOperation('op-not-plugin')).toBeUndefined();
  });
});

describe('composite port routes plugin cancellation (ADR 0005 D17)', () => {
  const makeComposite = (source: PluginSourcePort) => {
    const root = mkdtempSync(join(tmpdir(), 'hdsl-composite-'));
    roots.push(root);
    const layout = resolveLayout(root);
    ensureLayout(layout);
    const discovery = new PluginDiscoveryService({ layout, source });
    let serviceCancelCalls = 0;
    const service = {
      host: { platform: 'darwin', arch: 'arm64' },
      layout,
      listEnvironments: () => portOk([]),
      findEnvironment: () => portFail('NOT_FOUND', 'environment was not found'),
      findOperation: () => portFail('NOT_FOUND', 'operation was not found'),
      findCombination: () => portFail('NOT_FOUND', 'combination was not found'),
      createEnvironment: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      startEnvironment: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      stopEnvironment: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      openWebUI: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      cancelOperation: () => {
        serviceCancelCalls += 1;
        return portFail('INTERNAL_ERROR', 'environment-only stub');
      },
      exportDiagnostics: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      readIdempotency: () => undefined,
      writeIdempotency: () => undefined,
    };
    const port = createEnvironmentContractPort({
      service: service as unknown as EnvironmentService,
      catalog: [],
      pluginDiscovery: discovery,
    });
    return { runtime: createContractRuntime({ port }), cancelCalls: () => serviceCancelCalls };
  };

  it('operations.cancel hits the plugin operation without falling through to the environment service', () => {
    let resolveSearch: ((value: PortOutcome<typeof result>) => void) | undefined;
    const source: PluginSourcePort = {
      search: () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
      inspect: () => Promise.resolve(portFail('INTERNAL_ERROR', 'unused')),
    };
    const { runtime, cancelCalls } = makeComposite(source);
    const started = runtime.dispatch({
      apiVersion: API_VERSION,
      method: 'plugins.search',
      input: { requestId: 'req-composite', query: 'topic:x' },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const operationId = (started.value as { operationId: string }).operationId;

    const cancelled = runtime.dispatch({
      apiVersion: API_VERSION,
      method: 'operations.cancel',
      input: { requestId: 'req-cancel', operationId },
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect((cancelled.value as OperationSnapshot).status).toBe('cancelled');
    expect(cancelCalls()).toBe(0);

    // Unknown ids still fall through to the environment service (NOT_FOUND).
    const missing = runtime.dispatch({
      apiVersion: API_VERSION,
      method: 'operations.get',
      input: { operationId: 'op-unknown' },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('NOT_FOUND');
    }
    resolveSearch?.(portOk(result));
  });
});
