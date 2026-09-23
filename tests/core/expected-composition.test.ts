/**
 * Core expected-composition lifecycle tests (#118).
 *
 * Deterministic: a controlled `ExpectedCompositionPort` and a real temporary
 * data root. They prove the terminal states, the fixed honest fields
 * (`basis: 'dump-config'`, `runtimeVerification: 'unavailable'`), the
 * busy/no-generation guards, cancellation, and that the composite contract port
 * routes `compositions.expected`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_VERSION,
  createContractRuntime,
  portFail,
  portOk,
  type ExpectedCompositionView,
  type OperationSnapshot,
  type PortOutcome,
} from '@hdsl/contracts';
import {
  createEnvironmentContractPort,
  ensureLayout,
  environmentPaths,
  EnvironmentStore,
  ExpectedCompositionService,
  generationPaths,
  isTerminalStatus,
  resolveLayout,
  type EnvironmentService,
  type ExpectedCompositionDumpRequest,
  type ExpectedCompositionDumpResult,
  type ExpectedCompositionPort,
} from '@hdsl/core';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const ENV = 'env-expected-0001';
const GEN = 'gen-expected-0001';
const PROFILE = `hdsl-${GEN}`;

interface Fixture {
  readonly layout: ReturnType<typeof resolveLayout>;
  readonly store: EnvironmentStore;
  readonly environmentId: string;
  readonly generationId: string;
}

const makeFixture = (
  options: { readonly state?: 'stopped' | 'running'; readonly activeGeneration?: boolean } = {},
): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-expected-'));
  cleanup.push(root);
  const layout = resolveLayout(root);
  ensureLayout(layout);
  const store = new EnvironmentStore(layout);
  const activeGeneration = options.activeGeneration ?? true;
  store.write({
    schemaVersion: '1',
    id: ENV,
    name: 'Expected',
    revision: 3,
    stateVersion: 1,
    state: options.state ?? 'stopped',
    activeGenerationId: activeGeneration ? GEN : null,
    compositionDigest: activeGeneration ? 'a'.repeat(64) : null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  });
  if (!activeGeneration) {
    return { layout, store, environmentId: ENV, generationId: GEN };
  }
  const paths = generationPaths(layout, ENV, GEN);
  mkdirSync(join(paths.nodeDirectory, 'bin'), { recursive: true });
  writeFileSync(
    join(paths.nodeDirectory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    '',
  );
  const dshDirectory = join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  mkdirSync(dshDirectory, { recursive: true });
  writeFileSync(join(dshDirectory, 'bin.js'), '');
  const profileDirectory = join(environmentPaths(layout, ENV).profilesDirectory, PROFILE);
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } } }),
  );
  writeFileSync(paths.generationRecordPath, JSON.stringify({ schemaVersion: '1', profileName: PROFILE }));
  return { layout, store, environmentId: ENV, generationId: GEN };
};

const DUMP: ExpectedCompositionDumpResult = {
  groups: [
    {
      label: '@deepseek-ai/dsh-base',
      rows: [
        {
          id: 'sessions',
          name: '@deepseek-ai/dsh-session-persistence-jsonl',
          nameKnown: true,
          disabled: null,
          disabledKnown: false,
          config: {
            text: "root: !!js dshHomePath('sessions') from /Users/private/secret",
            truncated: false,
            unevaluated: true,
          },
        },
      ],
    },
  ],
  diagnostics: [{ code: 'unresolved-construct', message: 'explicit tag is not interpreted', groupLabel: '@deepseek-ai/dsh-base', line: 5 }],
  rowCount: 1,
  stderr: 'warning at /Users/private/secret\nmore',
  stdoutBytes: 42,
  exitCode: 0,
  timedOut: false,
  observedAt: '2026-09-23T01:02:03.000Z',
};

class FakePort implements ExpectedCompositionPort {
  readonly requests: ExpectedCompositionDumpRequest[] = [];
  outcome: PortOutcome<ExpectedCompositionDumpResult> = portOk(DUMP);
  #resolve: ((value: PortOutcome<ExpectedCompositionDumpResult>) => void) | undefined;
  deferred = false;

  describeExpectedComposition(
    request: ExpectedCompositionDumpRequest,
    _signal: AbortSignal,
  ): Promise<PortOutcome<ExpectedCompositionDumpResult>> {
    this.requests.push(request);
    if (!this.deferred) {
      return Promise.resolve(this.outcome);
    }
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  settle(value: PortOutcome<ExpectedCompositionDumpResult>): void {
    this.#resolve?.(value);
  }
}

const terminal = async (
  service: ExpectedCompositionService,
  operationId: string,
): Promise<OperationSnapshot> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
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

describe('ExpectedCompositionService', () => {
  it('runs the dump to a succeeded view with fixed expected-composition fields', async () => {
    const fixture = makeFixture();
    const port = new FakePort();
    const service = new ExpectedCompositionService({
      layout: fixture.layout,
      environments: fixture.store,
      port,
      now: () => new Date('2026-09-23T01:02:03.000Z'),
    });
    const started = service.describe(ENV);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const snapshot = await terminal(service, started.value.operationId);
    expect(snapshot.status).toBe('succeeded');
    expect(snapshot.kind).toBe('composition');
    expect(snapshot.environmentId).toBe(ENV);
    const view = snapshot.output as ExpectedCompositionView;
    expect(view.basis).toBe('dump-config');
    expect(view.runtimeVerification).toBe('unavailable');
    expect(view.bundles).toEqual(['@deepseek-ai/dsh-base']);
    expect(view.patchReload).toBe('live');
    expect(view.profileName).toBe(PROFILE);
    expect(view.revision).toBe(3);
    expect(view.rowCount).toBe(1);
    // The port request points at the managed generation runtime and home.
    const request = port.requests[0];
    expect(request?.profileName).toBe(PROFILE);
    expect(request?.dshEntrypoint).toContain('@deepseek-ai');
  });

  it('redacts local paths from stderr and config text before the bridge', async () => {
    const fixture = makeFixture();
    const service = new ExpectedCompositionService({
      layout: fixture.layout,
      environments: fixture.store,
      port: new FakePort(),
    });
    const started = service.describe(ENV);
    if (!started.ok) throw new Error('did not start');
    const snapshot = await terminal(service, started.value.operationId);
    const view = snapshot.output as ExpectedCompositionView;
    expect(view.stderr).not.toContain('/Users/private');
    expect(view.stderr).toContain('<path>');
    const config = view.groups[0]?.rows[0]?.config;
    expect(config?.text).not.toContain('/Users/private');
    // `!!js` survives redaction verbatim.
    expect(config?.text).toContain('!!js');
    expect(config?.unevaluated).toBe(true);
  });

  it('refuses a running environment with ENVIRONMENT_BUSY', () => {
    const fixture = makeFixture({ state: 'running' });
    const service = new ExpectedCompositionService({
      layout: fixture.layout,
      environments: fixture.store,
      port: new FakePort(),
    });
    const started = service.describe(ENV);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.code).toBe('ENVIRONMENT_BUSY');
  });

  it('refuses an environment with no active generation', () => {
    const fixture = makeFixture({ activeGeneration: false });
    const service = new ExpectedCompositionService({
      layout: fixture.layout,
      environments: fixture.store,
      port: new FakePort(),
    });
    const started = service.describe(ENV);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.code).toBe('NOT_FOUND');
  });

  it('maps a port failure to a controlled code without leaking its message', async () => {
    const fixture = makeFixture();
    const port = new FakePort();
    port.outcome = portFail('INTERNAL_ERROR', 'raw port text token=canary');
    const service = new ExpectedCompositionService({
      layout: fixture.layout,
      environments: fixture.store,
      port,
    });
    const started = service.describe(ENV);
    if (!started.ok) throw new Error('did not start');
    const snapshot = await terminal(service, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.output).toBeUndefined();
    expect(snapshot.error?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(snapshot)).not.toContain('canary');
  });

  it('cancels an in-flight read and ignores the late result', async () => {
    const fixture = makeFixture();
    const port = new FakePort();
    port.deferred = true;
    const service = new ExpectedCompositionService({
      layout: fixture.layout,
      environments: fixture.store,
      port,
    });
    const started = service.describe(ENV);
    if (!started.ok) throw new Error('did not start');
    const cancelled = service.cancelOperation(started.value.operationId);
    expect(cancelled?.ok).toBe(true);
    if (cancelled?.ok !== true) return;
    expect(cancelled.value.status).toBe('cancelled');
    port.settle(portOk(DUMP));
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    const snapshot = service.findOperation(started.value.operationId);
    expect(snapshot?.ok && snapshot.value.status).toBe('cancelled');
    expect(snapshot?.ok && snapshot.value.output).toBeUndefined();
    expect(service.cancelOperation(started.value.operationId)?.ok).toBe(false);
  });

  it('does not own other operation kinds', () => {
    const fixture = makeFixture();
    const service = new ExpectedCompositionService({
      layout: fixture.layout,
      environments: fixture.store,
      port: new FakePort(),
    });
    expect(service.owns('op-not-composition')).toBe(false);
    expect(service.findOperation('op-not-composition')).toBeUndefined();
    expect(service.cancelOperation('op-not-composition')).toBeUndefined();
  });
});

describe('composite port routes compositions.expected (#118)', () => {
  const composite = (port: ExpectedCompositionPort) => {
    const fixture = makeFixture();
    const discovery = new ExpectedCompositionService({
      layout: fixture.layout,
      environments: fixture.store,
      port,
    });
    const service = {
      host: { platform: 'darwin', arch: 'arm64' },
      layout: fixture.layout,
      listEnvironments: () => portOk([]),
      findEnvironment: (environmentId: string) =>
        environmentId === ENV
          ? portOk({
              id: ENV,
              name: 'Expected',
              revision: 3,
              stateVersion: 1,
              state: 'stopped' as const,
              activeGenerationId: GEN,
              compositionDigest: 'a'.repeat(64),
            })
          : portFail('NOT_FOUND', 'environment was not found'),
      findOperation: () => portFail('NOT_FOUND', 'operation was not found'),
      findCombination: () => portFail('NOT_FOUND', 'combination was not found'),
      createEnvironment: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      startEnvironment: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      stopEnvironment: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      openWebUI: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      cancelOperation: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      exportDiagnostics: () => portFail('INTERNAL_ERROR', 'environment-only stub'),
      readIdempotency: () => undefined,
      writeIdempotency: () => undefined,
    };
    const contractPort = createEnvironmentContractPort({
      service: service as unknown as EnvironmentService,
      catalog: [],
      expectedComposition: discovery,
    });
    return createContractRuntime({ port: contractPort });
  };

  it('dispatches compositions.expected to the operation and validates its output', async () => {
    const runtime = composite(new FakePort());
    const started = runtime.dispatch({
      apiVersion: API_VERSION,
      method: 'compositions.expected',
      input: { requestId: 'req-composition', environmentId: ENV },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const operationId = (started.value as { operationId: string }).operationId;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = runtime.dispatch({
        apiVersion: API_VERSION,
        method: 'operations.get',
        input: { operationId },
      });
      if (snapshot.ok) {
        const value = snapshot.value as OperationSnapshot;
        if (isTerminalStatus(value.status)) {
          expect(value.status).toBe('succeeded');
          const view = value.output as ExpectedCompositionView;
          expect(view.basis).toBe('dump-config');
          expect(view.runtimeVerification).toBe('unavailable');
          return;
        }
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
    }
    throw new Error('compositions.expected did not reach a terminal state');
  });

  it('rejects an unknown environment before starting an operation', () => {
    const runtime = composite(new FakePort());
    const response = runtime.dispatch({
      apiVersion: API_VERSION,
      method: 'compositions.expected',
      input: { requestId: 'req-composition-missing', environmentId: 'env-does-not-exist' },
    });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('NOT_FOUND');
  });
});
