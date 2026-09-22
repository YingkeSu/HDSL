/**
 * Desktop composition-root wiring tests (T006 / issue #6).
 *
 * Drives the real `createDesktopComposition` against the synthetic runtime
 * fixture (a controlled artifacts-only install) and a fake managed-process port.
 * Proves: data-root exclusivity, the ownership gate before the main-only WebUI
 * opener, credential loader availability, close-failure lock retention and the
 * runtime/core process-port phase adapter.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portFail, portOk, type RuntimeCombination } from '@hdsl/contracts';
import { createRuntimePort, type ProcessManager } from '@hdsl/runtime';
import type { ManagedProcessPort } from '@hdsl/core';
import {
  adaptProcessPort,
  createDesktopComposition,
  isBlockedByRecovery,
  PRODUCTION_RUNTIME_OPTIONS,
  type VerifiedWebUiContext,
  type VerifiedWebUiOpener,
} from '../../apps/desktop/src/main/composition.js';
import type { DiagnosticAppInfo } from '../../apps/desktop/src/main/diagnostics.js';
import {
  sha256,
  syntheticCombination,
  syntheticDshTarball,
  syntheticNodeTarball,
  writeLocalArtifact,
} from '../install/synthetic.js';

const nodeTarball = syntheticNodeTarball('22.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});

const appInfo: DiagnosticAppInfo = {
  name: 'HDSL',
  version: '0.0.0',
  platform: 'darwin',
  arch: 'arm64',
  node: '24.21.0',
  electron: '44.4.3',
};

const roots: string[] = [];
const freshRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fakeProcess = (overrides: Partial<ManagedProcessPort> = {}): ManagedProcessPort => ({
  start: () => Promise.resolve(portOk({ pid: 4321, loopbackOrigin: 'http://127.0.0.1:53123' })),
  stop: () => Promise.resolve(portOk({ wasRunning: true })),
  openWebUI: () => portOk({ loopbackOrigin: 'http://127.0.0.1:53123' }),
  recover: () => Promise.resolve({ entries: [] }),
  close: () => Promise.resolve(portOk(undefined)),
  ...overrides,
});

const syntheticRuntime = () => {
  const artifacts = freshRoot('hdsl-comp-artifacts-');
  writeLocalArtifact(artifacts, sha256(nodeTarball), nodeTarball);
  writeLocalArtifact(artifacts, sha256(dshTarball), dshTarball);
  return createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    localArtifactDirectory: artifacts,
  });
};

const createEnvironment = async (
  composition: Awaited<ReturnType<typeof createDesktopComposition>>,
  name: string,
) => {
  const created = composition.port.createEnvironment({
    requestId: `req-${name}`,
    name,
    combination: combination as RuntimeCombination,
  });
  if (!created.ok) {
    throw new Error(`createEnvironment failed: ${created.code}`);
  }
  await composition.service.waitForOperation(created.value.operationId, { timeoutMs: 15_000 });
  return created.value.operationId;
};

const compose = async (
  dataRoot: string,
  options: {
    process?: ManagedProcessPort;
    manager?: ProcessManager;
    opener?: VerifiedWebUiOpener;
  } = {},
) => {
  const contexts: VerifiedWebUiContext[] = [];
  const opener =
    options.opener ??
    (async (context: VerifiedWebUiContext) => {
      contexts.push(context);
      return portOk({ loopbackOrigin: context.loopbackOrigin });
    });
  const composition = await createDesktopComposition({
    dataRoot,
    appInfo,
    catalog: [combination as RuntimeCombination],
    runtime: syntheticRuntime(),
    allowArtifactsOnly: true,
    process: options.process ?? fakeProcess(),
    ...(options.manager === undefined ? {} : { manager: options.manager }),
    openWebUi: opener,
    pathChooser: { chooseExportPath: () => null },
    lockWaitTimeoutMs: 300,
    lockPollIntervalMs: 50,
    clock: () => new Date('2026-09-20T00:00:00.000Z'),
  });
  return { composition, contexts };
};

describe('createDesktopComposition', () => {
  it('pins production runtime profile initialization on the composition entry', () => {
    // A new production generation must always get its managed profile; the
    // production runtime options must keep profile initialization enabled.
    expect(PRODUCTION_RUNTIME_OPTIONS.profileInit).toBe(true);
  });

  it('creates an environment and gates the WebUI opener behind ownership verification', async () => {
    const dataRoot = freshRoot('hdsl-comp-');
    const { composition, contexts } = await compose(dataRoot);
    expect(composition.available).toBe(true);
    expect(composition.recoveryBlocked).toBe(false);
    // Crashed apply/restore journals + dispatcher idempotency records are
    // reconciled at startup, not only for environment creation.
    expect(composition.applyRecovery).toEqual({ finalized: 0, rolledBack: 0 });

    const operationId = await createEnvironment(composition, '接线环境');
    expect(operationId).toMatch(/^op-/);
    const listed = composition.port.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const environmentId = listed.value[0]?.id;
    expect(environmentId).toBeDefined();

    const opened = await composition.openWebUi(environmentId as string);
    expect(opened.ok).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.environmentId).toBe(environmentId);
    expect(contexts[0]?.loopbackOrigin).toBe('http://127.0.0.1:53123');
    expect(contexts[0]?.processPort).toBeDefined();

    await composition.close();
  });

  it('passes the runtime main-only bootstrap into the opener and never returns the token URL', async () => {
    const dataRoot = freshRoot('hdsl-comp-');
    const openedUrls: string[] = [];
    const manager = {
      ...fakeProcess(),
      consumeWebUIBootstrap: async (
        environmentId: string,
        open: (bootstrapUrl: string) => void | Promise<void>,
      ) => {
        expect(environmentId).toMatch(/^env-/);
        await open('http://127.0.0.1:53123/?token=canary-bootstrap');
        return portOk(undefined);
      },
      launchesDirectory: '/tmp/launches',
      readLaunchRecord: () => undefined,
      listLaunchRecords: () => [],
    } as unknown as ProcessManager;
    const { composition, contexts } = await compose(dataRoot, {
      manager,
      opener: async (context) => {
        contexts.push(context);
        const consume = context.webUiBootstrap?.consumeWebUIBootstrap;
        if (consume === undefined) {
          return portFail('WEBUI_UNAVAILABLE', 'missing capability');
        }
        const outcome = await consume(context.environmentId, async (url) => {
          openedUrls.push(url);
        });
        return outcome.ok
          ? portOk({ loopbackOrigin: context.loopbackOrigin })
          : portFail(outcome.code, outcome.message);
      },
    });
    await createEnvironment(composition, 'bootstrap 环境');
    const listed = composition.port.listEnvironments();
    if (!listed.ok || listed.value[0] === undefined) {
      throw new Error('environment was not listed');
    }
    const opened = await composition.openWebUi(listed.value[0].id);
    expect(opened.ok).toBe(true);
    expect(contexts[0]?.webUiBootstrap).toBeDefined();
    expect(openedUrls).toEqual(['http://127.0.0.1:53123/?token=canary-bootstrap']);
    expect(JSON.stringify(opened)).not.toContain('canary-bootstrap');
    await composition.close();
  });

  it('does not call the opener when the process port reports no verified endpoint', async () => {
    const dataRoot = freshRoot('hdsl-comp-');
    const { composition, contexts } = await compose(dataRoot, {
      process: fakeProcess({
        openWebUI: () => portFail('WEBUI_UNAVAILABLE', 'no verified managed endpoint'),
      }),
    });
    await createEnvironment(composition, '不可用端点');
    const listed = composition.port.listEnvironments();
    if (!listed.ok || listed.value[0] === undefined) {
      throw new Error('environment was not listed');
    }
    const opened = await composition.openWebUi(listed.value[0].id);
    expect(opened.ok).toBe(false);
    expect(contexts).toHaveLength(0);
    await composition.close();
  });

  it('rejects a non-loopback origin before the opener', async () => {
    const dataRoot = freshRoot('hdsl-comp-');
    const { composition, contexts } = await compose(dataRoot, {
      process: fakeProcess({
        openWebUI: () => portOk({ loopbackOrigin: 'https://evil.test/whatever' }),
      }),
    });
    await createEnvironment(composition, '非 loopback');
    const listed = composition.port.listEnvironments();
    if (!listed.ok || listed.value[0] === undefined) {
      throw new Error('environment was not listed');
    }
    const opened = await composition.openWebUi(listed.value[0].id);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.code).toBe('WEBUI_UNAVAILABLE');
    }
    expect(contexts).toHaveLength(0);
    await composition.close();
  });

  it('refuses a second instance on the same data root (exclusive lease)', async () => {
    const dataRoot = freshRoot('hdsl-comp-');
    const first = await compose(dataRoot);
    expect(first.composition.available).toBe(true);
    const second = await compose(dataRoot);
    expect(second.composition.available).toBe(false);
    expect(second.composition.recovery.refused).toBe(true);
    await second.composition.close();
    await first.composition.close();
  });

  it('keeps the lock when the process module cannot prove a clean close', async () => {
    const dataRoot = freshRoot('hdsl-comp-');
    const { composition } = await compose(dataRoot, {
      process: fakeProcess({
        close: () => Promise.resolve(portFail('INTERNAL_ERROR', 'a managed process did not exit')),
      }),
    });
    expect(composition.available).toBe(true);
    const report = await composition.close();
    expect(report.released).toBe(false);
    expect(report.failure?.code).toBe('INTERNAL_ERROR');

    const contender = await compose(dataRoot);
    expect(contender.composition.available).toBe(false);
    await contender.composition.close();
  });
});

describe('restart recovery gate', () => {
  it('blocks new create/start but leaves stop, reads and export available', () => {
    expect(isBlockedByRecovery('environments.create', true)).toBe(true);
    expect(isBlockedByRecovery('environments.start', true)).toBe(true);
    expect(isBlockedByRecovery('environments.stop', true)).toBe(false);
    expect(isBlockedByRecovery('operations.get', true)).toBe(false);
    expect(isBlockedByRecovery('diagnostics.export', true)).toBe(false);
    expect(isBlockedByRecovery('environments.start', false)).toBe(false);
  });
});

describe('adaptProcessPort', () => {
  it('drops unknown runtime phases before they reach core', async () => {
    const phases: string[] = [];
    const manager = {
      start: async (request: { onPhase?: (phase: string, progress?: number) => void }) => {
        request.onPhase?.('waiting-ready');
        request.onPhase?.('mystery-phase');
        request.onPhase?.('running', 50);
        return portOk({ pid: 7, loopbackOrigin: 'http://127.0.0.1:53123' });
      },
      stop: async () => portOk({ wasRunning: false }),
      openWebUI: () => portOk({ loopbackOrigin: 'http://127.0.0.1:53123' }),
      recover: async () => ({ entries: [] }),
      close: async () => portOk(undefined),
      consumeWebUIBootstrap: async () => portOk(undefined),
      launchesDirectory: '/tmp/launches',
      readLaunchRecord: () => undefined,
      listLaunchRecords: () => [],
    } satisfies ProcessManager;

    const adapted = adaptProcessPort(manager);
    const outcome = await adapted.start({
      environmentId: 'env-abc12345',
      expectedRevision: 1,
      generationDirectory: '/tmp/gen',
      homeDirectory: '/tmp/gen/home',
      configDirectory: '/tmp/gen/config',
      dataDirectory: '/tmp/gen/data',
      nodeExecutable: '/tmp/gen/node/bin/node',
      dshEntrypoint: '/tmp/gen/dsh/bin.js',
      installMode: 'artifacts-only',
      signal: new AbortController().signal,
      onPhase: (phase) => {
        phases.push(phase);
      },
    });
    expect(outcome.ok).toBe(true);
    expect(phases).toEqual(['waiting-ready', 'running']);
  });

  it('does not expose a non-core capability on the adapted port', () => {
    const manager = {
      start: async () => portOk({ pid: 1, loopbackOrigin: 'http://127.0.0.1:1' }),
      stop: async () => portOk({ wasRunning: false }),
      openWebUI: () => portOk({ loopbackOrigin: 'http://127.0.0.1:1' }),
      recover: async () => ({ entries: [] }),
      close: async () => portOk(undefined),
      launchesDirectory: '/tmp/launches',
      readLaunchRecord: () => undefined,
      listLaunchRecords: () => [],
      consumeWebUIBootstrap: vi.fn(),
    } as unknown as ProcessManager;
    expect('consumeWebUIBootstrap' in adaptProcessPort(manager)).toBe(false);
  });
});
