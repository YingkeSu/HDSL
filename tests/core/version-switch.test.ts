/**
 * `environments.switchCombination` (issue #114 / A2, Tier 1, Node axis).
 *
 * Everything runs against a real `dataRoot` on disk with the real journal,
 * operation store and contract dispatcher. Artifacts are offline synthetic
 * fixtures (still SHA-256 verified), so these are file-boundary tests: they
 * prove transaction semantics, not a real network install (that opt-in evidence
 * is recorded separately).
 *
 * The two combinations deliberately share ONE DSH version and differ only in
 * Node, matching the audited C22/C24 positive control. No cross-version home
 * compatibility is claimed or required here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_VERSION,
  createContractRuntime,
  portFail,
  portOk,
  type ContractResponse,
  type RuntimeCombination,
} from '@hdsl/contracts';
import {
  EnvironmentStore,
  createManagedInstall,
  generationPaths,
  managedProfileName,
  resolveLayout,
  type ManagedInstall,
  type ManagedProcessPort,
} from '@hdsl/core';
import { createRuntimePort } from '@hdsl/runtime';
import {
  sha256,
  syntheticCombination,
  syntheticDshTarball,
  syntheticNodeTarball,
  writeLocalArtifact,
} from '../install/synthetic.js';

const DSH = '0.1.5-rc.2';
const nodeA = syntheticNodeTarball('22.0.0');
const nodeB = syntheticNodeTarball('24.0.0');
const dsh = syntheticDshTarball(DSH);

// Same DSH version, different Node: the Node-axis positive control.
const combinationNode22 = syntheticCombination({
  id: 'switch-node22',
  nodeVersion: '22.0.0',
  nodeTarball: nodeA,
  dshVersion: DSH,
  dshTarball: dsh,
});
const combinationNode24 = syntheticCombination({
  id: 'switch-node24',
  nodeVersion: '24.0.0',
  nodeTarball: nodeB,
  dshVersion: DSH,
  dshTarball: dsh,
});
// A deterministic pre-commit install failure: the artifact is not in the
// offline root and the URL host refuses the connection.
const unreachable = syntheticCombination({
  id: 'switch-unreachable',
  nodeVersion: '22.0.0',
  nodeSha256Override: 'e'.repeat(64),
  nodeTarball: nodeA,
  dshVersion: DSH,
  dshTarball: dsh,
  urlBase: 'http://127.0.0.1:1',
});
const windowsCombination = syntheticCombination({
  id: 'switch-windows',
  nodeVersion: '22.0.0',
  nodeTarball: nodeA,
  dshVersion: DSH,
  dshTarball: dsh,
  platform: 'win32',
  arch: 'x64',
});

/** Minimal managed-process stub: no real spawn, success by construction. */
const stubProcess = (): ManagedProcessPort => ({
  start: async () => portOk({ pid: 4242, loopbackOrigin: 'http://127.0.0.1:41234' }),
  stop: async () => portOk({ wasRunning: true }),
  openWebUI: () => portFail('WEBUI_UNAVAILABLE', 'stub process has no WebUI'),
  recover: async () => ({ entries: [] }),
  close: async () => portOk(undefined),
});

interface Harness {
  readonly dataRoot: string;
  readonly managed: ManagedInstall;
  readonly catalog: readonly RuntimeCombination[];
  readonly dispatch: (method: string, input: unknown) => ContractResponse<unknown>;
}

interface HarnessOptions {
  readonly dataRoot?: string;
  readonly catalog?: readonly RuntimeCombination[];
  readonly faults?: {
    readonly failBeforeCommit?: boolean;
    readonly pauseBeforeCommit?: boolean;
    readonly pauseAfterPointerSwitch?: boolean;
    readonly pauseAfterPublishBeforePointer?: boolean;
  };
  readonly process?: ManagedProcessPort;
  readonly profileInit?: boolean;
}

/**
 * Controlled executor for the profile-init seam: writes the immutable
 * declaration source into the staging home, exactly like the real DSH template
 * would. This is adapter evidence, not real-DSH evidence.
 */
const profileExecutor = async (
  _executable: string,
  args: readonly string[],
  runOptions: { cwd: string; env: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> => {
  const name = args[args.indexOf('--profile') + 1] as string;
  const home = runOptions.env['DSH_HOME'] as string;
  const directory = join(home, 'profiles', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-fixture', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
  );
  writeFileSync(join(directory, 'cordis.patch.yml'), '# patch\n');
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
};

const roots: string[] = [];
const freshRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const buildHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const dataRoot = options.dataRoot ?? freshRoot('hdsl-switch-data-');
  const localArtifacts = freshRoot('hdsl-switch-artifacts-');
  writeLocalArtifact(localArtifacts, sha256(nodeA), nodeA);
  writeLocalArtifact(localArtifacts, sha256(nodeB), nodeB);
  writeLocalArtifact(localArtifacts, sha256(dsh), dsh);
  const runtime = createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    ...(options.profileInit === true
      ? { profileInit: true, executeCommand: profileExecutor as never }
      : {}),
    localArtifactDirectory: localArtifacts,
  });
  const catalog =
    options.catalog ?? [combinationNode22, combinationNode24, unreachable, windowsCombination];
  const managed = await createManagedInstall({
    dataRoot,
    catalog,
    runtime,
    fixtures: { allowArtifactsOnly: true },
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(options.process === undefined ? {} : { process: options.process }),
  });
  const contract = createContractRuntime({ port: managed.port });
  return {
    dataRoot,
    managed,
    catalog,
    dispatch: (method, input) => contract.dispatch({ apiVersion: API_VERSION, method, input }),
  };
};

const operationRefOf = (response: ContractResponse<unknown>): string => {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    throw new Error('expected a successful response');
  }
  return (response.value as { operationId: string }).operationId;
};

const createEnv = async (harness: Harness, combinationId: string, requestId: string): Promise<string> => {
  const operation = operationRefOf(
    harness.dispatch('environments.create', {
      requestId,
      name: 'switch-env',
      catalogCombinationId: combinationId,
    }),
  );
  const settled = await harness.managed.waitForOperation(operation);
  expect(settled.status).toBe('succeeded');
  return operation;
};

const switchEnv = (harness: Harness, environmentId: string, revision: number, combinationId: string, requestId: string) =>
  harness.dispatch('environments.switchCombination', {
    requestId,
    environmentId,
    expectedRevision: revision,
    catalogCombinationId: combinationId,
  });

const environmentOf = (harness: Harness) => {
  const outcome = harness.managed.service.listEnvironments();
  if (!outcome.ok) {
    throw new Error('expected a successful environments list');
  }
  const environment = outcome.value[0];
  if (environment === undefined) {
    throw new Error('expected one environment');
  }
  return environment;
};

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const waitForJournalPhase = async (dataRoot: string, phase: string, timeoutMs = 10_000): Promise<void> => {
  const directory = resolveLayout(dataRoot).transactions;
  await waitFor(
    () =>
      existsSync(directory) &&
      readdirSync(directory).some(
        (name) => (JSON.parse(readFileSync(join(directory, name), 'utf8')) as { phase: string }).phase === phase,
      ),
    `journal phase ${phase}`,
    timeoutMs,
  );
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('switchCombination: success path (Node axis)', () => {
  it('installs a new generation, publishes its profile, atomically switches the pointer and retains the old generation', async () => {
    const harness = await buildHarness({ profileInit: true });
    await createEnv(harness, combinationNode22.id, 'req-create');
    const before = environmentOf(harness);
    expect(before.state).toBe('stopped');
    expect(before.revision).toBe(1);
    const generationX = before.activeGenerationId as string;
    const layout = resolveLayout(harness.dataRoot);
    const pathsX = generationPaths(layout, before.id, generationX);
    expect(existsSync(pathsX.generationDirectory)).toBe(true);

    const operationId = operationRefOf(
      await switchEnv(harness, before.id, 1, combinationNode24.id, 'req-switch'),
    );
    const settled = await harness.managed.waitForOperation(operationId);
    expect(settled.status).toBe('succeeded');
    expect(settled.kind).toBe('switch');

    const after = environmentOf(harness);
    expect(after.state).toBe('stopped');
    expect(after.revision).toBe(2);
    expect(after.activeGenerationId).not.toBe(generationX);
    const generationY = after.activeGenerationId as string;
    expect(after.compositionDigest).not.toBe(before.compositionDigest);

    // New generation is a real install; the old generation directory is retained.
    const pathsY = generationPaths(layout, after.id, generationY);
    expect(existsSync(join(pathsY.nodeDirectory, 'bin', 'node'))).toBe(true);
    expect(existsSync(join(pathsY.dshDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))).toBe(true);
    expect(existsSync(pathsX.generationDirectory)).toBe(true);

    // generation.json records the DSH version + published profile.
    const record = JSON.parse(readFileSync(pathsY.generationRecordPath, 'utf8')) as {
      dshVersion: string;
      profileName: string;
      compositionDigest: string;
    };
    expect(record.dshVersion).toBe(DSH);
    expect(record.profileName).toBe(managedProfileName(generationY));
    expect(record.compositionDigest).toBe(after.compositionDigest);

    // The new generation's managed profile was published before the pointer move.
    const publishedProfile = join(
      layout.environments,
      after.id,
      'home',
      'profiles',
      managedProfileName(generationY),
      'package.json',
    );
    expect(existsSync(publishedProfile)).toBe(true);

    await harness.managed.close();
  });

  it('is an idempotent no-op when the requested composition is already active', async () => {
    const harness = await buildHarness();
    await createEnv(harness, combinationNode22.id, 'req-create');
    const before = environmentOf(harness);

    const operationId = operationRefOf(
      await switchEnv(harness, before.id, 1, combinationNode22.id, 'req-noop'),
    );
    const settled = await harness.managed.waitForOperation(operationId);
    expect(settled.status).toBe('succeeded');

    const after = environmentOf(harness);
    expect(after.revision).toBe(before.revision);
    expect(after.activeGenerationId).toBe(before.activeGenerationId);
    expect(after.compositionDigest).toBe(before.compositionDigest);

    // No second generation directory was produced.
    const layout = resolveLayout(harness.dataRoot);
    expect(readdirSync(join(layout.environments, before.id, 'generations'))).toHaveLength(1);

    // Same requestId replay returns the original operation ref.
    const replay = switchEnv(harness, before.id, 1, combinationNode22.id, 'req-noop');
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect((replay.value as { operationId: string }).operationId).toBe(operationId);
    }
    await harness.managed.close();
  });

  it('replays an identical switch requestId without installing again', async () => {
    const harness = await buildHarness();
    await createEnv(harness, combinationNode22.id, 'req-create');
    const before = environmentOf(harness);
    const first = operationRefOf(await switchEnv(harness, before.id, 1, combinationNode24.id, 'req-once'));
    await harness.managed.waitForOperation(first);
    const replay = switchEnv(harness, before.id, 1, combinationNode24.id, 'req-once');
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect((replay.value as { operationId: string }).operationId).toBe(first);
    }
    const layout = resolveLayout(harness.dataRoot);
    expect(readdirSync(join(layout.environments, before.id, 'generations'))).toHaveLength(2);
    await harness.managed.close();
  });
});

describe('switchCombination: guards', () => {
  it('refuses a running environment with ENVIRONMENT_BUSY and never touches the pointer or process', async () => {
    const harness = await buildHarness();
    await createEnv(harness, combinationNode22.id, 'req-create');
    const before = environmentOf(harness);
    const layout = resolveLayout(harness.dataRoot);
    const store = new EnvironmentStore(layout);
    store.write({ ...store.read(before.id)!, state: 'running', stateVersion: 9 });

    const response = switchEnv(harness, before.id, 1, combinationNode24.id, 'req-busy');
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('ENVIRONMENT_BUSY');
    }
    const after = environmentOf(harness);
    expect(after.state).toBe('running');
    expect(after.activeGenerationId).toBe(before.activeGenerationId);
    expect(after.revision).toBe(before.revision);
    expect(readdirSync(join(layout.environments, before.id, 'generations'))).toHaveLength(1);
    await harness.managed.close();
  });

  it('refuses a start while a switch transaction is open', { timeout: 20_000 }, async () => {
    const dataRoot = freshRoot('hdsl-switch-start-guard-');
    const first = await buildHarness({ dataRoot, process: stubProcess() });
    await createEnv(first, combinationNode22.id, 'req-create');
    const before = environmentOf(first);
    await first.managed.close();

    // Reopen WITH the pause fault so the switch (not the create) is paused.
    const paused = await buildHarness({
      dataRoot,
      process: stubProcess(),
      faults: { pauseBeforeCommit: true },
    });
    operationRefOf(await switchEnv(paused, before.id, 1, combinationNode24.id, 'req-switch-paused'));
    await waitForJournalPhase(dataRoot, 'artifacts-installed');

    const start = paused.dispatch('environments.start', {
      requestId: 'req-start-during-switch',
      environmentId: before.id,
      expectedRevision: 1,
    });
    expect(start.ok).toBe(false);
    if (!start.ok) {
      expect(start.error.code).toBe('ENVIRONMENT_BUSY');
    }
    // A second switch is also refused while the first is unresolved.
    const second = switchEnv(paused, before.id, 1, combinationNode22.id, 'req-switch-second');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('ENVIRONMENT_BUSY');
    }
    await paused.managed.close();
  });

  it('rejects unknown and unsupported combinations without any side effect', async () => {
    const harness = await buildHarness();
    await createEnv(harness, combinationNode22.id, 'req-create');
    const before = environmentOf(harness);

    const unknown = switchEnv(harness, before.id, 1, 'does-not-exist', 'req-unknown');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('NOT_FOUND');
    }
    const windows = switchEnv(harness, before.id, 1, windowsCombination.id, 'req-windows');
    expect(windows.ok).toBe(false);
    if (!windows.ok) {
      expect(windows.error.code).toBe('UNSUPPORTED_COMBINATION');
    }
    const after = environmentOf(harness);
    expect(after.activeGenerationId).toBe(before.activeGenerationId);
    expect(after.revision).toBe(before.revision);
    await harness.managed.close();
  });

  it('refuses a switch while a plugin apply/restore journal is unresolved', async () => {
    const harness = await buildHarness();
    await createEnv(harness, combinationNode22.id, 'req-create');
    const before = environmentOf(harness);
    const layout = resolveLayout(harness.dataRoot);
    mkdirSync(layout.applyJournals, { recursive: true });
    writeFileSync(
      join(layout.applyJournals, 'txn-00000000000000aa.json'),
      JSON.stringify({
        schemaVersion: '1',
        kind: 'apply',
        environmentId: before.id,
        phase: 'verified',
      }),
    );
    const response = switchEnv(harness, before.id, 1, combinationNode24.id, 'req-apply-busy');
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('ENVIRONMENT_BUSY');
    }
    expect(environmentOf(harness).activeGenerationId).toBe(before.activeGenerationId);
    await harness.managed.close();
  });
});

describe('switchCombination: pre-commit failure keeps the old generation (D3)', () => {
  it('fails at the commit boundary, drops only the staged generation and keeps X startable', async () => {
    const dataRoot = freshRoot('hdsl-switch-fail-');
    const first = await buildHarness({ dataRoot, process: stubProcess() });
    await createEnv(first, combinationNode22.id, 'req-create');
    const before = environmentOf(first);
    const generationX = before.activeGenerationId as string;
    await first.managed.close();

    const failing = await buildHarness({
      dataRoot,
      process: stubProcess(),
      faults: { failBeforeCommit: true },
    });
    const operationId = operationRefOf(
      await switchEnv(failing, before.id, 1, combinationNode24.id, 'req-switch-fail'),
    );
    const settled = await failing.managed.waitForOperation(operationId);
    expect(settled.status).toBe('failed');
    expect(settled.error?.code).toBe('INTERNAL_ERROR');

    const layout = resolveLayout(failing.dataRoot);
    const after = environmentOf(failing);
    // D3: pointer/digest/revision/state unchanged, and NOT marked `error`.
    expect(after.state).toBe('stopped');
    expect(after.activeGenerationId).toBe(generationX);
    expect(after.compositionDigest).toBe(before.compositionDigest);
    expect(after.revision).toBe(before.revision);
    expect(existsSync(generationPaths(layout, before.id, generationX).generationDirectory)).toBe(true);
    // Only one generation directory remains: the new stage was removed.
    expect(readdirSync(join(layout.environments, before.id, 'generations'))).toHaveLength(1);
    expect(readdirSync(layout.transactions)).toHaveLength(0);

    // X is still startable.
    const started = operationRefOf(
      failing.dispatch('environments.start', {
        requestId: 'req-start-x',
        environmentId: before.id,
        expectedRevision: before.revision,
      }),
    );
    expect((await failing.managed.waitForOperation(started)).status).toBe('succeeded');
    expect(environmentOf(failing).state).toBe('running');
    await failing.managed.close();
  });

  it('fails a download pre-commit and keeps the old pointer', async () => {
    const dataRoot = freshRoot('hdsl-switch-download-');
    const first = await buildHarness({ dataRoot });
    await createEnv(first, combinationNode22.id, 'req-create');
    const before = environmentOf(first);
    await first.managed.close();

    const failing = await buildHarness({ dataRoot });
    const operationId = operationRefOf(
      await switchEnv(failing, before.id, 1, unreachable.id, 'req-switch-download'),
    );
    const settled = await failing.managed.waitForOperation(operationId);
    expect(settled.status).toBe('failed');
    expect(settled.error?.code).toBe('DOWNLOAD_FAILED');
    const after = environmentOf(failing);
    expect(after.state).toBe('stopped');
    expect(after.activeGenerationId).toBe(before.activeGenerationId);
    expect(after.revision).toBe(before.revision);
    await failing.managed.close();
  });
});

describe('switchCombination: crash windows and recovery', () => {
  it('rolls forward when the pointer already switched before the crash', async () => {
    const dataRoot = freshRoot('hdsl-switch-rollforward-');
    const first = await buildHarness({ dataRoot });
    await createEnv(first, combinationNode22.id, 'req-create');
    const before = environmentOf(first);
    const generationX = before.activeGenerationId as string;
    await first.managed.close();

    const paused = await buildHarness({ dataRoot, faults: { pauseAfterPointerSwitch: true } });
    const operationId = operationRefOf(
      await switchEnv(paused, before.id, 1, combinationNode24.id, 'req-switch-forward'),
    );
    await waitFor(() => {
      const environment = environmentOf(paused);
      return environment.activeGenerationId !== generationX;
    }, 'pointer switch');
    const generationY = environmentOf(paused).activeGenerationId as string;
    await paused.managed.close();

    const restarted = await buildHarness({ dataRoot });
    const report = await restarted.managed.recover();
    expect(report.finalized).toBeGreaterThanOrEqual(1);
    const environment = environmentOf(restarted);
    expect(environment.activeGenerationId).toBe(generationY);
    expect(environment.revision).toBe(2);
    expect(existsSync(generationPaths(resolveLayout(dataRoot), before.id, generationX).generationDirectory)).toBe(true);
    expect(readdirSync(resolveLayout(dataRoot).transactions)).toHaveLength(0);
    const settled = restarted.managed.service.findOperation(operationId);
    expect(settled.ok ? settled.value.status : undefined).toBe('succeeded');
    await restarted.managed.close();
  });

  it('rolls back a crash after profile publication but before the pointer switch, keeping the old generation', async () => {
    const dataRoot = freshRoot('hdsl-switch-rollback-');
    const first = await buildHarness({ dataRoot, profileInit: true });
    await createEnv(first, combinationNode22.id, 'req-create');
    const before = environmentOf(first);
    const generationX = before.activeGenerationId as string;
    await first.managed.close();

    const paused = await buildHarness({
      dataRoot,
      profileInit: true,
      faults: { pauseAfterPublishBeforePointer: true },
    });
    const operationId = operationRefOf(
      await switchEnv(paused, before.id, 1, combinationNode24.id, 'req-switch-back'),
    );
    // Journal stays uncommitted and the pointer must not move.
    await waitForJournalPhase(dataRoot, 'artifacts-installed');
    expect(environmentOf(paused).activeGenerationId).toBe(generationX);
    await paused.managed.close();

    const restarted = await buildHarness({ dataRoot, profileInit: true });
    const report = await restarted.managed.recover();
    expect(report.rolledBack).toBeGreaterThanOrEqual(1);

    const environment = environmentOf(restarted);
    expect(environment.state).toBe('stopped');
    expect(environment.activeGenerationId).toBe(generationX);
    expect(environment.compositionDigest).toBe(before.compositionDigest);
    expect(environment.revision).toBe(before.revision);
    // Only the switch's staged generation is gone; X is retained.
    const layout = resolveLayout(dataRoot);
    expect(readdirSync(join(layout.environments, before.id, 'generations'))).toHaveLength(1);
    expect(existsSync(generationPaths(layout, before.id, generationX).generationDirectory)).toBe(true);
    expect(readdirSync(layout.transactions)).toHaveLength(0);
    const settled = restarted.managed.service.findOperation(operationId);
    expect(settled.ok ? settled.value.status : undefined).toBe('failed');
    await restarted.managed.close();
  });

  it('fails an orphaned switch operation without marking the environment error', async () => {
    const harness = await buildHarness({ process: stubProcess() });
    await createEnv(harness, combinationNode22.id, 'req-create');
    const environment = environmentOf(harness);
    const generationX = environment.activeGenerationId as string;

    const layout = resolveLayout(harness.dataRoot);
    const operationId = 'op-0000000000000sw1';
    // An orphaned switch operation with no journal (crash between the operation
    // record and the journal).
    mkdirSync(layout.operations, { recursive: true });
    writeFileSync(
      join(layout.operations, `${operationId}.json`),
      JSON.stringify({
        schemaVersion: '1',
        id: operationId,
        environmentId: environment.id,
        kind: 'switch',
        phase: 'preparing',
        status: 'running',
        sequence: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const report = await harness.managed.recover();
    expect(report.details.some((detail) => detail.operationId === operationId)).toBe(true);
    const settled = harness.managed.service.findOperation(operationId);
    expect(settled.ok ? settled.value.status : undefined).toBe('failed');
    const after = environmentOf(harness);
    expect(after.state).toBe('stopped');
    expect(after.activeGenerationId).toBe(generationX);
    await harness.managed.close();
  });
});
