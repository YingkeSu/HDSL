/**
 * Desktop composition-root wiring tests (T006 / issue #6).
 *
 * Drives the real `createDesktopComposition` against the synthetic runtime
 * fixture (a controlled artifacts-only install) and a fake managed-process port.
 * Proves: data-root exclusivity, the ownership gate before the main-only WebUI
 * opener, credential loader availability, close-failure lock retention and the
 * runtime/core process-port phase adapter.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portFail, portOk, API_VERSION, createContractRuntime, type HostPlatform, type RuntimeCombination } from '@hdsl/contracts';
import { createRuntimePort, type ProcessManager } from '@hdsl/runtime';
import {
  EnvironmentStore,
  OperationStore,
  ensureLayout,
  environmentPaths,
  generationPaths,
  resolveLayout,
  type ManagedProcessPort,
  type ManagedRuntimePort,
} from '@hdsl/core';
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
const nodeTarballB = syntheticNodeTarball('24.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});
// Same DSH version, different Node: a real switch target for the recovery gate.
const combinationB = syntheticCombination({
  id: 'comp-node24',
  nodeVersion: '24.0.0',
  nodeTarball: nodeTarballB,
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
  writeLocalArtifact(artifacts, sha256(nodeTarballB), nodeTarballB);
  writeLocalArtifact(artifacts, sha256(dshTarball), dshTarball);
  return createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    localArtifactDirectory: artifacts,
  });
};

/** Wraps the synthetic runtime to record whether an install was ever reached. */
const recordingRuntime = (): { runtime: ManagedRuntimePort; installs: string[] } => {
  const real = syntheticRuntime();
  const installs: string[] = [];
  const runtime: ManagedRuntimePort = {
    resolveComposition: (input) => real.resolveComposition(input),
    compositionDigest: (lock) => real.compositionDigest(lock),
    install: (lock, destination, context) => {
      installs.push(`${lock.node.version}+${lock.dsh.version}`);
      return real.install(lock, destination, context);
    },
  };
  return { runtime, installs };
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
    catalog?: readonly RuntimeCombination[];
    host?: HostPlatform;
    runtime?: ManagedRuntimePort;
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
    catalog: options.catalog ?? [combination as RuntimeCombination],
    runtime: options.runtime ?? syntheticRuntime(),
    allowArtifactsOnly: true,
    ...(options.host === undefined ? {} : { host: options.host }),
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

  it('wires the S3 removal preview and the installed-plugin view (no "not wired" placeholder)', async () => {
    const dataRoot = freshRoot('hdsl-comp-');
    const { composition } = await compose(dataRoot);
    await createEnvironment(composition, 'S3 接线环境');
    const listed = composition.port.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const environmentId = listed.value[0]?.id as string;
    const environment = composition.port.findEnvironment(environmentId);
    if (!environment.ok) {
      throw new Error('environment missing');
    }

    // `plugins.installed` is wired to the real active-generation view; a synthetic
    // install may fail the in-box identity closed, but it must never be the
    // "owned by another slice"/"not wired" placeholder.
    const installed = composition.port.listInstalledPlugins(environmentId);
    if (!installed.ok) {
      expect(installed.message).not.toContain('managed-process slice');
      expect(installed.message).not.toContain('not wired');
      expect(installed.code).toBe('INTERNAL_ERROR');
    }

    // The remove preview is dispatched to the S3 removal branch (the adapter IS
    // wired here); the operation may fail controlled later because this synthetic
    // environment records no plugin composition.
    const preview = composition.port.previewChange({
      requestId: 'req-s3-remove',
      environmentId,
      expectedRevision: environment.value.revision,
      action: { kind: 'remove', pluginId: 'demo-plugin' },
    });
    expect(preview.ok).toBe(true);

    await composition.close();
  });

  it('wires the desired-config entry patch to the environment home user patch (no "not wired" placeholder)', async () => {
    const dataRoot = freshRoot('hdsl-comp-');
    const { composition } = await compose(dataRoot);
    await createEnvironment(composition, 'entry 接线环境');
    const listed = composition.port.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const environmentId = listed.value[0]?.id as string;

    // The service IS wired at the composition root: it must never return the
    // "not wired" placeholder, and a legal edit must save the desired config
    // with the honest saved/pending shape.
    const patched = composition.port.patchEntry({
      requestId: 'req-entry-wiring',
      environmentId,
      operation: { kind: 'disable', rowId: 'timer' },
    });
    if (!patched.ok) {
      throw new Error(`entries.patch is not wired correctly: ${patched.code} ${patched.message}`);
    }
    expect(patched.value.saved).toBe(true);
    expect(patched.value.runtime).toBe('pending');
    expect(patched.value.runtimeVerification).toBe('unavailable');
    // Written to the environment-shared home, never a profile declaration source.
    const homePatch = join(environmentPaths(composition.service.layout, environmentId).homeDirectory, 'cordis.patch.yml');
    expect(readFileSync(homePatch, 'utf8')).toContain('timer');
    expect(patched.value.environmentId).toBe(environmentId);

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
  it('blocks new create/start/switch but leaves stop, reads and export available', () => {
    expect(isBlockedByRecovery('environments.create', true)).toBe(true);
    expect(isBlockedByRecovery('environments.start', true)).toBe(true);
    expect(isBlockedByRecovery('environments.switchCombination', true)).toBe(true);
    expect(isBlockedByRecovery('environments.stop', true)).toBe(false);
    expect(isBlockedByRecovery('operations.get', true)).toBe(false);
    expect(isBlockedByRecovery('diagnostics.export', true)).toBe(false);
    expect(isBlockedByRecovery('environments.start', false)).toBe(false);
  });

  it('refuses switchCombination after an unverifiable recovery and never moves the pointer', async () => {
    const dataRoot = freshRoot('hdsl-comp-switch-gate-');
    const first = await compose(dataRoot, {
      catalog: [combination as RuntimeCombination, combinationB as RuntimeCombination],
    });
    await createEnvironment(first.composition, 'gate-env');
    const listed = first.composition.port.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const environment = listed.value[0];
    expect(environment).toBeDefined();
    if (environment === undefined) {
      return;
    }
    const generationX = environment.activeGenerationId as string;
    const revision = environment.revision;
    await first.composition.close();

    const reopened = await compose(dataRoot, {
      catalog: [combination as RuntimeCombination, combinationB as RuntimeCombination],
      process: fakeProcess({
        recover: () =>
          Promise.resolve({ entries: [{ environmentId: environment.id, resolution: 'unverifiable' }] }),
      }),
    });
    expect(reopened.composition.recoveryBlocked).toBe(true);

    // The unverifiable recovery still leaves the environment `stopped`, which
    // the stopped-only switch guard alone would accept. The recovery gate is
    // what must refuse the switch.
    const recovered = reopened.composition.port.findEnvironment(environment.id);
    expect(recovered.ok && recovered.value.state).toBe('stopped');
    expect(
      isBlockedByRecovery('environments.switchCombination', reopened.composition.recoveryBlocked),
    ).toBe(true);

    // Mirror app.ts beforeDispatch: a blocked method returns ENVIRONMENT_BUSY
    // without ever reaching the port.
    let reachedPort = false;
    let response;
    if (isBlockedByRecovery('environments.switchCombination', reopened.composition.recoveryBlocked)) {
      response = portFail('ENVIRONMENT_BUSY', 'restart recovery is unresolved');
    } else {
      reachedPort = true;
      response = reopened.composition.port.switchCombination({
        requestId: 'req-switch-gate',
        environmentId: environment.id,
        expectedRevision: revision,
        combination: combinationB as RuntimeCombination,
      });
    }
    expect(response.ok).toBe(false);
    expect(reachedPort).toBe(false);

    const after = reopened.composition.port.findEnvironment(environment.id);
    expect(after.ok && after.value.activeGenerationId).toBe(generationX);
    expect(after.ok && after.value.revision).toBe(revision);
    await reopened.composition.close();
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

/**
 * P1 (QA33) at the composition boundary: a committed environment plus an
 * orphaned non-terminal `preview` operation from a crash. Startup recovery must
 * terminate the preview without clearing the environment's pointer/digest.
 */
const seedCommittedEnvironmentWithOrphanPreview = (dataRoot: string): void => {
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environmentId = 'env-0000000000000001';
  const generationId = 'gen-0000000000000001';
  new EnvironmentStore(layout).write({
    schemaVersion: '1', id: environmentId, name: 'P1 环境', revision: 1, stateVersion: 1,
    state: 'stopped', activeGenerationId: generationId, compositionDigest: 'a'.repeat(64),
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
  });
  const paths = generationPaths(layout, environmentId, generationId);
  mkdirSync(join(paths.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(paths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
  writeFileSync(paths.manifestPath, JSON.stringify({
    schemaVersion: '1', installMode: 'artifacts-only',
    node: { version: '22.19.0', treeDigest: '1'.repeat(64) },
    dsh: { version: '0.1.5-rc.2', treeDigest: '2'.repeat(64) },
  }));
  writeFileSync(paths.lockPath, JSON.stringify({
    schemaVersion: '1',
    node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: '1'.repeat(64) },
    dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: '2'.repeat(64) },
    plugins: [], sources: { node: { url: 'https://x/n', sha256: '1'.repeat(64) }, dsh: { url: 'https://x/d', sha256: '2'.repeat(64) } },
  }));
  writeFileSync(paths.generationRecordPath, JSON.stringify({
    id: generationId, environmentId, compositionDigest: 'a'.repeat(64),
    createdAt: '2026-09-20T00:00:00.000Z', profileName: `hdsl-${generationId}`,
  }));
  new OperationStore(layout).create({
    id: 'op-00000000000000aa', kind: 'preview', environmentId, phase: 'planning', status: 'running',
    createdAt: '2026-09-20T00:00:00.000Z',
  });
};

describe('startup recovery with a crashed preview (P1)', () => {
  it('terminates the orphan preview and keeps the committed environment intact', async () => {
    const dataRoot = freshRoot('hdsl-comp-p1-');
    seedCommittedEnvironmentWithOrphanPreview(dataRoot);
    const { composition } = await compose(dataRoot);

    expect(composition.previewRecovery.terminated).toBeGreaterThanOrEqual(1);
    const environment = composition.port.findEnvironment('env-0000000000000001');
    expect(environment.ok).toBe(true);
    if (environment.ok) {
      expect(environment.value.state).toBe('stopped');
      expect(environment.value.activeGenerationId).toBe('gen-0000000000000001');
      expect(environment.value.compositionDigest).toBe('a'.repeat(64));
      expect(environment.value.revision).toBe(1);
    }
    const operation = composition.port.findOperation('op-00000000000000aa');
    expect(operation.ok).toBe(true);
    if (operation.ok) expect(operation.value.status).toBe('failed');
    await composition.close();
  });
});

/**
 * #107 host-wiring gate at the real desktop composition root.
 *
 * The production bootstrap must hand `createDesktopComposition` the real
 * `process.platform`/`process.arch`. These tests drive the SAME composition
 * entry the Electron main process uses with simulated non-darwin hosts, an
 * unresolved/omitted host and the verified darwin/arm64 host. The recording
 * runtime fails the negative controls closed if the install is ever reached.
 */
const simulatedUnverifiedHosts: ReadonlyArray<readonly [string, HostPlatform]> = [
  ['win32/x64', { platform: 'win32', arch: 'x64' }],
  ['linux/x64', { platform: 'linux', arch: 'x64' }],
  ['linux/arm64', { platform: 'linux', arch: 'arm64' }],
];

describe('host wiring / platform gate (#107)', () => {
  it.each(simulatedUnverifiedHosts)(
    'refuses environments.create on the simulated host %s before any install effect',
    async (_label, host) => {
      const dataRoot = freshRoot('hdsl-comp-gate-');
      const { runtime, installs } = recordingRuntime();
      const { composition } = await compose(dataRoot, { host, runtime });
      const contract = createContractRuntime({ port: composition.port });
      const response = contract.dispatch({
        apiVersion: API_VERSION,
        method: 'environments.create',
        input: { requestId: 'req-host-gate', name: 'gate', catalogCombinationId: combination.id },
      });
      expect(response.ok, JSON.stringify(response)).toBe(false);
      if (!response.ok) {
        expect(response.error.code).toBe('UNSUPPORTED_COMBINATION');
      }
      // No download/install side effect, no environment row, no ledger entry.
      expect(installs).toEqual([]);
      const listed = composition.port.listEnvironments();
      expect(listed.ok && listed.value).toEqual([]);
      expect(composition.port.findOperation('req-host-gate').ok).toBe(false);
      await composition.close();
    },
  );

  it('#147 lists no installable combination on the simulated win32/x64 host', async () => {
    const dataRoot = freshRoot('hdsl-comp-catalog-win-');
    const { composition } = await compose(dataRoot, { host: { platform: 'win32', arch: 'x64' } });
    const contract = createContractRuntime({ port: composition.port });
    const response = contract.dispatch({
      apiVersion: API_VERSION,
      method: 'catalog.list',
      input: {},
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (response.ok) {
      // Windows is preview-only: the darwin combination must never be offered
      // as installable, so the UI can block creation before the form.
      expect(response.value).toEqual([]);
    }
    // The foreign-host combination stays resolvable so the platform gate still
    // refuses it with a specific UNSUPPORTED_COMBINATION, not a generic NOT_FOUND.
    const lookup = composition.port.findCombination(combination.id);
    expect(lookup.ok).toBe(true);
    await composition.close();
  });

  it('#147 still lists the verified combination on the darwin/arm64 host', async () => {
    const dataRoot = freshRoot('hdsl-comp-catalog-darwin-');
    const { composition } = await compose(dataRoot, { host: { platform: 'darwin', arch: 'arm64' } });
    const contract = createContractRuntime({ port: composition.port });
    const response = contract.dispatch({
      apiVersion: API_VERSION,
      method: 'catalog.list',
      input: {},
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (response.ok) {
      const ids = (response.value as readonly { id: string }[]).map((entry) => entry.id);
      expect(ids).toContain(combination.id);
    }
    await composition.close();
  });

  it('refuses environments.create when the host could not be resolved (omitted)', async () => {
    const dataRoot = freshRoot('hdsl-comp-gate-unknown-');
    const { runtime, installs } = recordingRuntime();
    const { composition } = await compose(dataRoot, { runtime });
    const contract = createContractRuntime({ port: composition.port });
    const response = contract.dispatch({
      apiVersion: API_VERSION,
      method: 'environments.create',
      input: { requestId: 'req-host-unknown', name: 'unknown', catalogCombinationId: combination.id },
    });
    expect(response.ok, JSON.stringify(response)).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('UNSUPPORTED_COMBINATION');
    }
    expect(installs).toEqual([]);
    await composition.close();
  });

  it('refuses environments.switchCombination on win32/x64 before any install effect', async () => {
    const dataRoot = freshRoot('hdsl-comp-switch-gate-host-');
    seedCommittedEnvironmentWithOrphanPreview(dataRoot);
    const { runtime, installs } = recordingRuntime();
    const { composition } = await compose(dataRoot, {
      host: { platform: 'win32', arch: 'x64' },
      runtime,
    });
    const contract = createContractRuntime({ port: composition.port });
    const response = contract.dispatch({
      apiVersion: API_VERSION,
      method: 'environments.switchCombination',
      input: {
        requestId: 'req-switch-host-gate',
        environmentId: 'env-0000000000000001',
        expectedRevision: 1,
        catalogCombinationId: combination.id,
      },
    });
    expect(response.ok, JSON.stringify(response)).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('UNSUPPORTED_COMBINATION');
    }
    expect(installs).toEqual([]);
    await composition.close();
  });

  it('keeps the verified darwin/arm64 host on the create success path', async () => {
    const dataRoot = freshRoot('hdsl-comp-gate-ok-');
    const { runtime, installs } = recordingRuntime();
    const { composition } = await compose(dataRoot, {
      host: { platform: 'darwin', arch: 'arm64' },
      runtime,
    });
    const contract = createContractRuntime({ port: composition.port });
    const response = contract.dispatch({
      apiVersion: API_VERSION,
      method: 'environments.create',
      input: { requestId: 'req-host-ok', name: 'verified', catalogCombinationId: combination.id },
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (!response.ok) {
      return;
    }
    const operationId = (response.value as { operationId: string }).operationId;
    const snapshot = await composition.service.waitForOperation(operationId, { timeoutMs: 20_000 });
    expect(snapshot.status).toBe('succeeded');
    expect(installs).toHaveLength(1);
    await composition.close();
  });
});
