/**
 * Core upstream DSH version-discovery lifecycle tests (A1 / #113).
 *
 * Deterministic: a controlled `DshVersionSourcePort` and a real temporary data
 * root. They prove the terminal states (succeeded payload / controlled failure /
 * cancellation with no side effect) and that the composite contract port routes
 * `versions.dsh` and `operations.cancel` to this service. No registry is touched.
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
  type DshVersionListing,
  type OperationSnapshot,
  type PortOutcome,
} from '@hdsl/contracts';
import {
  createEnvironmentContractPort,
  ensureLayout,
  isTerminalStatus,
  resolveLayout,
  VersionDiscoveryService,
  type DshVersionSourcePort,
  type EnvironmentService,
} from '@hdsl/core';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const LISTING: DshVersionListing = {
  source: { registry: 'https://registry.npmjs.org', packageName: '@deepseek-ai/dsh' },
  fetchedAt: '2026-09-23T00:00:00.000Z',
  distTags: [{ tag: 'latest', version: '0.1.5-rc.2' }],
  versions: [
    {
      version: '0.1.5-rc.2',
      distTags: ['latest'],
      publishedAt: '2025-12-01T00:00:00.000Z',
      supported: true,
      catalogCombinationIds: ['combo-a'],
    },
    {
      version: '0.1.5-rc.3',
      distTags: ['next'],
      publishedAt: null,
      supported: false,
      catalogCombinationIds: [],
    },
  ],
};

const makeService = (source: DshVersionSourcePort): { service: VersionDiscoveryService; layout: ReturnType<typeof resolveLayout> } => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-version-'));
  roots.push(root);
  const layout = resolveLayout(root);
  ensureLayout(layout);
  return { service: new VersionDiscoveryService({ layout, source }), layout };
};

const terminal = async (
  service: VersionDiscoveryService,
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

describe('VersionDiscoveryService', () => {
  it('runs a global read to a succeeded versions operation carrying the listing', async () => {
    const source: DshVersionSourcePort = { listVersions: () => Promise.resolve(portOk(LISTING)) };
    const { service } = makeService(source);
    const started = service.listVersions();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const snapshot = await terminal(service, started.value.operationId);
    expect(snapshot.status).toBe('succeeded');
    expect(snapshot.kind).toBe('versions');
    expect(snapshot.environmentId).toBeNull();
    expect(snapshot.output).toEqual(LISTING);
    expect(snapshot.error).toBeUndefined();
  });

  it('maps a network failure to a controlled code and never records the port message', async () => {
    const source: DshVersionSourcePort = {
      listVersions: () => Promise.resolve(portFail('NETWORK_UNAVAILABLE', 'raw registry text token=canary')),
    };
    const { service } = makeService(source);
    const started = service.listVersions();
    if (!started.ok) throw new Error('did not start');
    const snapshot = await terminal(service, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.output).toBeUndefined();
    expect(snapshot.error?.code).toBe('NETWORK_UNAVAILABLE');
    expect(snapshot.error?.retryable).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('canary');
  });

  it('cancels an in-flight read: terminal cancelled, aborted signal, late result ignored', async () => {
    let resolveRead: ((value: PortOutcome<DshVersionListing>) => void) | undefined;
    let observedSignal: AbortSignal | null = null;
    const source: DshVersionSourcePort = {
      listVersions: (signal) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    };
    const { service } = makeService(source);
    const started = service.listVersions();
    if (!started.ok) throw new Error('did not start');
    const operationId = started.value.operationId;

    const cancelled = service.cancelOperation(operationId);
    expect(cancelled?.ok).toBe(true);
    if (cancelled?.ok !== true) return;
    expect(cancelled.value.status).toBe('cancelled');
    expect(cancelled.value.output).toBeUndefined();
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true);

    resolveRead?.(portOk(LISTING));
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    expect(service.findOperation(operationId)?.ok).toBe(true);
    const snapshot = service.findOperation(operationId);
    expect(snapshot?.ok && snapshot.value.status).toBe('cancelled');
    expect(snapshot?.ok && snapshot.value.output).toBeUndefined();
    expect(service.cancelOperation(operationId)?.ok).toBe(false);
  });

  it('does not own other operation kinds', () => {
    const source: DshVersionSourcePort = { listVersions: () => Promise.resolve(portOk(LISTING)) };
    const { service } = makeService(source);
    expect(service.owns('op-not-version')).toBe(false);
    expect(service.findOperation('op-not-version')).toBeUndefined();
    expect(service.cancelOperation('op-not-version')).toBeUndefined();
  });
});

describe('composite port routes versions.dsh (A1/#113)', () => {
  const composite = (source: DshVersionSourcePort) => {
    const { service: discovery, layout } = makeService(source);
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
      versionDiscovery: discovery,
    });
    return { runtime: createContractRuntime({ port }), cancelCalls: () => serviceCancelCalls };
  };

  it('dispatches versions.dsh to an operation and cancels it without touching the environment service', () => {
    let resolveRead: ((value: PortOutcome<DshVersionListing>) => void) | undefined;
    const source: DshVersionSourcePort = {
      listVersions: () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    };
    const { runtime, cancelCalls } = composite(source);
    const started = runtime.dispatch({
      apiVersion: API_VERSION,
      method: 'versions.dsh',
      input: { requestId: 'req-versions' },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value).toEqual({ operationId: expect.any(String) });
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
    resolveRead?.(portOk(LISTING));
  });
});
