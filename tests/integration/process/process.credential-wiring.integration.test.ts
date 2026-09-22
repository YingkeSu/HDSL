/**
 * T007b — service credential + managed-env wiring QA (issue #45).
 *
 * Real wiring: `EnvironmentService.launchCredentialRequest` →
 * `createLaunchCredentialPort` (controlled provider) → `createProcessManager`.
 * It checks the child's *actual* environment and directories, not module-test
 * doubles certifying themselves.
 *
 * Candidate pair: main `562fa03` + runtime `86a223b`. On this pair the runtime
 * `managed` env map wins over the credential handle (`{ ...handle.env, ...managed }`),
 * so the child receives the runtime's managed keys, which conflict with the
 * single core generation mapping (`<home>/agents`, `<gen>/node/bin:...`) and,
 * for PATH, are mis-concatenated (`<nodeDir>/usr/bin:...`, missing `:`). Those
 * assertions are RED here and must pass unchanged after the fix.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCredentialInjection,
  createLaunchCredentialPort,
  createPosixProcessProbe,
  createProcessManager,
  type LaunchCredentialPort,
  type OsCredentialProvider,
  type ProcessLifecycleRequest,
} from '@hdsl/runtime';
import { portOk } from '@hdsl/contracts';

import { buildLockHarness, cleanupQaRoots, createEnvironment } from './support/install-harness.js';
import { waitFor } from './support/isolation.js';
import { FIXTURE_SCRIPT } from './support/managed-process.js';

const CANARY = `hdsl-qa-canary-${randomUUID()}`;
const CANARY_KEY = 'hdsl-qa-service#canary-account';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface Info {
  readonly pid: number;
  readonly home: string | null;
  readonly dshHome: string | null;
  readonly canary?: { readonly name: string; readonly present: boolean; readonly sha256: string | null };
  readonly hostLeak?: string | null;
  readonly managedEnv?: {
    readonly HOME: string | null;
    readonly DSH_HOME: string | null;
    readonly DSH_AGENTS_HOME: string | null;
    readonly PATH: string | null;
    readonly TMPDIR: string | null;
  };
}

const readInfo = (path: string): Info | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Info;
  } catch {
    return undefined;
  }
};

const makeProvider = (): OsCredentialProvider => ({
  store: 'keychain',
  read: async (reference) => {
    if (reference.key !== CANARY_KEY) {
      throw new Error('the reference is not the QA canary');
    }
    return CANARY;
  },
});

const managers: ReturnType<typeof createProcessManager>[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.close().catch(() => undefined);
  }
  await cleanupQaRoots();
});

interface Scenario {
  readonly harness: Awaited<ReturnType<typeof buildLockHarness>>;
  readonly environmentId: string;
  readonly revision: number;
  readonly generationDirectory: string;
  readonly homeDirectory: string;
  request(overrides?: Partial<ProcessLifecycleRequest>): ProcessLifecycleRequest;
  buildManager(load: (id: string) => Promise<unknown>): {
    readonly manager: ReturnType<typeof createProcessManager>;
    readonly disposeCount: () => number;
  };
}

const setup = async (): Promise<Scenario> => {
  const harness = await buildLockHarness({});
  await createEnvironment(harness, 'req-cred-wire');
  const list = harness.dispatch('environments.list', {});
  if (!list.ok) {
    throw new Error(`environments.list failed: ${list.error.code}`);
  }
  const environment = (list.value as Array<{ id: string; revision: number; activeGenerationId: string | null }>)[0];
  if (environment === undefined || environment.activeGenerationId === null) {
    throw new Error('expected one environment with an active generation');
  }
  const write = harness.managed.service.writeEnvironmentCredentials({
    environmentId: environment.id,
    bindings: [
      { name: 'DSH_QA_CANARY', reference: { id: 'qa-canary-ref', store: 'keychain', key: CANARY_KEY } },
    ],
  });
  if (!write.ok) {
    throw new Error('could not write the QA credential binding');
  }

  const generationDirectory = join(
    harness.dataRoot,
    'environments',
    environment.id,
    'generations',
    environment.activeGenerationId,
  );
  const homeDirectory = join(harness.dataRoot, 'environments', environment.id, 'home');
  const dataDirectory = join(harness.dataRoot, 'environments', environment.id, 'data');
  for (const directory of [
    homeDirectory,
    dataDirectory,
    join(generationDirectory, 'config'),
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  const request = (overrides: Partial<ProcessLifecycleRequest> = {}): ProcessLifecycleRequest => ({
    environmentId: environment.id,
    expectedRevision: environment.revision,
    generationDirectory,
    homeDirectory,
    configDirectory: join(generationDirectory, 'config'),
    dataDirectory,
    nodeExecutable: process.execPath,
    dshEntrypoint: FIXTURE_SCRIPT,
    installMode: 'npm-ci',
    signal: new AbortController().signal,
    onPhase: () => undefined,
    port: 'auto',
    ...overrides,
  });

  const buildManager = (
    load: (id: string) => Promise<unknown>,
  ): { manager: ReturnType<typeof createProcessManager>; disposeCount: () => number } => {
    const basePort = createLaunchCredentialPort({
      load: load as Parameters<typeof createLaunchCredentialPort>[0]['load'],
      injection: createCredentialInjection({ provider: makeProvider() }),
    });
    // Wrap the port only to count dispose calls; the real port does the work.
    let disposed = 0;
    const port: LaunchCredentialPort = {
      resolveLaunchEnvironment: async (environmentId) => {
        const outcome = await basePort.resolveLaunchEnvironment(environmentId);
        if (!outcome.ok) {
          return outcome;
        }
        const original = outcome.value.dispose;
        return portOk({
          env: outcome.value.env,
          dispose: () => {
            disposed += 1;
            original();
          },
        });
      },
    };
    const manager = createProcessManager({
      dataRoot: harness.dataRoot,
      credentials: port,
      probe: createPosixProcessProbe(),
    });
    managers.push(manager);
    return { manager, disposeCount: () => disposed };
  };

  return {
    harness,
    environmentId: environment.id,
    revision: environment.revision,
    generationDirectory,
    homeDirectory,
    request,
    buildManager,
  };
};

const isError = (result: { ok: boolean }): boolean => !result.ok;

describe('credential + managed-env wiring QA', () => {
  it('PROCESS-ENV-MAP01: canary is injected and each of the five managed keys matches the real core mapping', async () => {
    const scenario = await setup();
    try {
      const { manager } = scenario.buildManager((id) =>
        scenario.harness.managed.service.launchCredentialRequest(id),
      );
      const started = await manager.start(scenario.request());
      expect(started.ok).toBe(true);

      const infoPath = join(scenario.homeDirectory, '.hdsl-qa-fixture.json');
      await waitFor(() => readInfo(infoPath)?.canary !== undefined, {
        timeoutMs: 5_000,
        label: 'fixture info written',
      });
      const info = readInfo(infoPath);
      // Canary wiring works (hash only; plaintext is never written).
      expect(info?.canary?.present).toBe(true);
      expect(info?.canary?.sha256).toBe(sha256(CANARY));
      expect(info?.hostLeak ?? null).toBeNull();

      // Correct managed-env mapping (single core generation mapping), key by key.
      const expectedManaged = {
        HOME: scenario.homeDirectory,
        DSH_HOME: scenario.homeDirectory,
        DSH_AGENTS_HOME: join(scenario.homeDirectory, 'agents'),
        PATH: `${join(scenario.generationDirectory, 'node', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
        TMPDIR: join(scenario.homeDirectory, '.tmp'),
      };
      expect(info?.managedEnv?.HOME).toBe(expectedManaged.HOME);
      expect(info?.managedEnv?.DSH_HOME).toBe(expectedManaged.DSH_HOME);
      expect(info?.managedEnv?.DSH_AGENTS_HOME).toBe(expectedManaged.DSH_AGENTS_HOME);
      expect(info?.managedEnv?.PATH).toBe(expectedManaged.PATH);
      expect(info?.managedEnv?.TMPDIR).toBe(expectedManaged.TMPDIR);
      // The conflicting runtime directory must not be silently used.
      expect(existsSync(join(scenario.generationDirectory, 'data', 'agents-home'))).toBe(false);

      // Plaintext canary never lands in the durable launch record.
      const record = readFileSync(
        join(scenario.harness.dataRoot, 'process', 'launches', `${scenario.environmentId}.json`),
        'utf8',
      );
      expect(record.includes(CANARY)).toBe(false);

      await manager.stop(scenario.request());
    } finally {
      await scenario.harness.managed.close().catch(() => undefined);
    }
  }, 30_000);

  it('PROCESS-ENV-MAP01-CONFLICT: a conflicting managed key fails before spawn and disposes exactly once', async () => {
    const scenario = await setup();
    try {
      const { manager, disposeCount } = scenario.buildManager(async (id) => {
        const request = await scenario.harness.managed.service.launchCredentialRequest(id);
        return {
          ...request,
          baseEnv: { ...request.baseEnv, DSH_AGENTS_HOME: '/tmp/hdsl-qa-conflict/agents' },
        };
      });
      const started = await manager.start(scenario.request());
      // Correct: a conflicted managed key is rejected before spawn, not
      // silently overridden, and the resolved handle is disposed exactly once.
      expect(isError(started)).toBe(true);
      expect(disposeCount()).toBe(1);
      expect(existsSync(join(scenario.homeDirectory, '.hdsl-qa-fixture.json'))).toBe(false);
    } finally {
      await scenario.harness.managed.close().catch(() => undefined);
    }
  }, 30_000);

  it('PROC-CRED-WIRE-FAIL: a missing binding fails closed without leaking a value', async () => {
    const harness = await buildLockHarness({});
    try {
      await createEnvironment(harness, 'req-cred-missing');
      const list = harness.dispatch('environments.list', {});
      if (!list.ok) {
        throw new Error('environments.list failed');
      }
      const environment = (list.value as Array<{ id: string; revision: number; activeGenerationId: string | null }>)[0];
      if (environment === undefined || environment.activeGenerationId === null) {
        throw new Error('expected an active generation');
      }
      const generationDirectory = join(
        harness.dataRoot,
        'environments',
        environment.id,
        'generations',
        environment.activeGenerationId,
      );
      const homeDirectory = join(generationDirectory, 'home');
      for (const directory of [homeDirectory, join(generationDirectory, 'config'), join(generationDirectory, 'data')]) {
        mkdirSync(directory, { recursive: true });
      }
      const port = createLaunchCredentialPort({
        load: (environmentId) => harness.managed.service.launchCredentialRequest(environmentId),
        injection: createCredentialInjection({ provider: makeProvider() }),
      });
      const manager = createProcessManager({
        dataRoot: harness.dataRoot,
        credentials: port,
        probe: createPosixProcessProbe(),
      });
      managers.push(manager);

      const started = await manager.start({
        environmentId: environment.id,
        expectedRevision: environment.revision,
        generationDirectory,
        homeDirectory,
        configDirectory: join(generationDirectory, 'config'),
        dataDirectory: join(generationDirectory, 'data'),
        nodeExecutable: process.execPath,
        dshEntrypoint: FIXTURE_SCRIPT,
        installMode: 'npm-ci',
        signal: new AbortController().signal,
        onPhase: () => undefined,
        port: 'auto',
      });
      expect(started.ok).toBe(false);
      expect(JSON.stringify(started).includes(CANARY)).toBe(false);
    } finally {
      await harness.managed.close().catch(() => undefined);
    }
  }, 30_000);
});
