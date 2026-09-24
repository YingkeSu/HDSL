/**
 * Environment creation / managed install acceptance tests (T004).
 *
 * Everything runs against a real `dataRoot` on disk with the real journal,
 * operation store and contract dispatcher. The artifact downloads use the
 * offline `localArtifactDirectory` fixture path (still SHA-256 verified), so
 * these are file-boundary tests — the opt-in `real-install` test covers the
 * official network sources.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_VERSION,
  createContractRuntime,
  portFail,
  type ContractResponse,
  type RuntimeCombination,
} from '@hdsl/contracts';
import {
  EnvironmentStore,
  IdempotencyStore,
  OperationStore,
  createManagedInstall,
  environmentPaths,
  generationPaths,
  managedProfileName,
  resolveLayout,
  type ManagedInstall,
} from '@hdsl/core';
import { computeCompositionDigest, createRuntimePort, resolveComposition } from '@hdsl/runtime';
import {
  sha256,
  syntheticCombination,
  syntheticDshTarball,
  syntheticNodeTarball,
  writeLocalArtifact,
} from '../install/synthetic.js';

const nodeA = syntheticNodeTarball('22.0.0');
const nodeB = syntheticNodeTarball('24.0.0');
const dshA = syntheticDshTarball('0.1.5-rc.2');
const dshB = syntheticDshTarball('0.2.0-rc.1');

const combinationA = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball: nodeA,
  dshVersion: '0.1.5-rc.2',
  dshTarball: dshA,
});
const combinationB = syntheticCombination({
  nodeVersion: '24.0.0',
  nodeTarball: nodeB,
  dshVersion: '0.2.0-rc.1',
  dshTarball: dshB,
});
const unverifiedCombination = syntheticCombination({
  id: 'unverified-fixture',
  nodeVersion: '22.0.0',
  nodeTarball: nodeA,
  dshVersion: '0.1.5-rc.2',
  dshTarball: dshA,
  compatibility: 'unverified',
});
const windowsCombination = syntheticCombination({
  id: 'windows-fixture',
  nodeVersion: '22.0.0',
  nodeTarball: nodeA,
  dshVersion: '0.1.5-rc.2',
  dshTarball: dshA,
  platform: 'win32',
  arch: 'x64',
});

interface Harness {
  readonly dataRoot: string;
  readonly artifacts: string;
  readonly managed: ManagedInstall;
  readonly catalog: readonly RuntimeCombination[];
  readonly dispatch: (method: string, input: unknown) => ContractResponse<unknown>;
  readonly localArtifacts: string;
}

const roots: string[] = [];

/**
 * The synthetic catalog below is macOS ARM64. The real dispatcher platform
 * gate now reads an explicit host (no silent darwin fallback), so every
 * harness must declare the host it is simulating.
 */
const TEST_HOST = { platform: 'darwin', arch: 'arm64' } as const;

const listFilesRecursively = (root: string): string[] => {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      files.push(...listFilesRecursively(path));
    } else {
      files.push(path);
    }
  }
  return files;
};

const freshRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

interface HarnessOptions {
  readonly catalog?: readonly RuntimeCombination[];
  readonly fixtures?: boolean;
  readonly faults?: {
    readonly failBeforeCommit?: boolean;
    readonly pauseBeforeCommit?: boolean;
    readonly pauseAfterPointerSwitch?: boolean;
  };
  readonly faultsRuntime?: {
    readonly failDownloadAfterBytes?: number;
    readonly corruptDownload?: boolean;
    readonly forceDiskFull?: boolean;
    readonly failExtraction?: boolean;
    readonly mismatchProfileName?: boolean;
    readonly mismatchProfileDigest?: boolean;
  };
  readonly dataRoot?: string;
  readonly profileInit?: boolean;
  readonly executeCommand?: unknown;
  readonly extraLocalArtifacts?: readonly { readonly sha256: string; readonly tarball: Buffer }[];
}

const buildHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const dataRoot = options.dataRoot ?? freshRoot('hdsl-data-');
  const localArtifacts = freshRoot('hdsl-artifacts-');
  for (const tarball of [nodeA, nodeB, dshA, dshB]) {
    writeLocalArtifact(localArtifacts, sha256(tarball), tarball);
  }
  for (const extra of options.extraLocalArtifacts ?? []) {
    writeLocalArtifact(localArtifacts, extra.sha256, extra.tarball);
  }
  const runtime = createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    host: TEST_HOST,
    ...(options.profileInit === true ? { profileInit: true } : {}),
    ...(options.executeCommand === undefined ? {} : { executeCommand: options.executeCommand as never }),
    localArtifactDirectory: localArtifacts,
    ...(options.faultsRuntime === undefined ? {} : { faults: options.faultsRuntime }),
  });
  const catalog = options.catalog ?? [combinationA, combinationB, unverifiedCombination, windowsCombination];
  const managed = await createManagedInstall({
    dataRoot,
    catalog,
    runtime,
    host: TEST_HOST,
    ...(options.fixtures === false ? {} : { fixtures: { allowArtifactsOnly: true } }),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  const contract = createContractRuntime({ port: managed.port });
  return {
    dataRoot,
    artifacts: localArtifacts,
    managed,
    catalog,
    localArtifacts,
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

const createEnvironment = async (
  harness: Harness,
  combinationId: string,
  requestId: string,
  name = 'environment',
): Promise<string> => {
  const response = harness.dispatch('environments.create', {
    requestId,
    name,
    catalogCombinationId: combinationId,
  });
  return operationRefOf(response);
};

const waitForJournalPhase = async (
  dataRoot: string,
  phase: string,
  timeoutMs = 5000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const directory = resolveLayout(dataRoot).transactions;
  for (;;) {
    if (existsSync(directory)) {
      for (const name of readdirSync(directory)) {
        const record = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { phase: string };
        if (record.phase === phase) {
          return;
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`journal never reached phase ${phase}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('environment creation', () => {
  it('creates two independent environments with different exact compositions', async () => {
    const harness = await buildHarness();
    const homeDirectory = join(homedir(), '.dsh');
    const homeSnapshot = (): string[] =>
      existsSync(homeDirectory) ? readdirSync(homeDirectory).sort() : [];
    const homeBefore = homeSnapshot();

    const catalogResponse = harness.dispatch('catalog.list', {});
    expect(catalogResponse.ok).toBe(true);
    if (catalogResponse.ok) {
      const ids = (catalogResponse.value as RuntimeCombination[]).map((entry) => entry.id);
      expect(ids).toContain(combinationA.id);
      expect(ids).toContain(combinationB.id);
      expect(ids).not.toContain(unverifiedCombination.id);
    }

    const operationA = await createEnvironment(harness, combinationA.id, 'req-a', 'alpha');
    const operationB = await createEnvironment(harness, combinationB.id, 'req-b', 'beta');
    expect(operationA).not.toBe(operationB);

    const settledA = await harness.managed.waitForOperation(operationA);
    const settledB = await harness.managed.waitForOperation(operationB);
    expect(settledA.status).toBe('succeeded');
    expect(settledB.status).toBe('succeeded');
    expect(settledA.sequence).toBeGreaterThan(0);

    const listResponse = harness.dispatch('environments.list', {});
    expect(listResponse.ok).toBe(true);
    if (!listResponse.ok) {
      return;
    }
    const environments = listResponse.value as Array<{
      id: string;
      name: string;
      state: string;
      revision: number;
      activeGenerationId: string | null;
      compositionDigest: string | null;
    }>;
    expect(environments).toHaveLength(2);
    const alpha = environments.find((entry) => entry.name === 'alpha');
    const beta = environments.find((entry) => entry.name === 'beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    if (alpha === undefined || beta === undefined) {
      return;
    }
    expect(alpha.state).toBe('stopped');
    expect(beta.state).toBe('stopped');
    expect(alpha.revision).toBe(1);
    expect(alpha.activeGenerationId).not.toBeNull();
    expect(alpha.compositionDigest).not.toBe(beta.compositionDigest);

    const layout = resolveLayout(harness.dataRoot);
    const pathsA = generationPaths(layout, alpha.id, alpha.activeGenerationId as string);
    const pathsB = generationPaths(layout, beta.id, beta.activeGenerationId as string);
    expect(pathsA.generationDirectory).not.toBe(pathsB.generationDirectory);
    expect(existsSync(join(pathsA.nodeDirectory, 'bin', 'node'))).toBe(true);
    expect(existsSync(join(pathsA.dshDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))).toBe(true);
    expect(existsSync(join(pathsB.nodeDirectory, 'bin', 'node'))).toBe(true);

    const lockA = JSON.parse(readFileSync(pathsA.lockPath, 'utf8')) as {
      node: { sha256: string };
      dsh: { sha256: string };
    };
    expect(lockA.node.sha256).toBe(sha256(nodeA));
    expect(lockA.dsh.sha256).toBe(sha256(dshA));

    const manifestA = harness.managed.service.readInstallManifest(alpha.id);
    expect(manifestA.installMode).toBe('artifacts-only');
    expect(manifestA.preflight.skipped).toBe(true);
    expect(manifestA.compositionDigest).toBe(alpha.compositionDigest);
    const manifestB = harness.managed.service.readInstallManifest(beta.id);
    expect(manifestB.installMode).toBe('artifacts-only');

    // Per ADR 0006 the home is environment-scoped: generation directories must
    // not grow their own `home`, and each environment's shared home is distinct.
    expect(existsSync(pathsA.legacyHomeDirectory)).toBe(false);
    expect(existsSync(pathsB.legacyHomeDirectory)).toBe(false);
    expect(existsSync(pathsA.homeDirectory)).toBe(true);
    expect(existsSync(pathsB.homeDirectory)).toBe(true);
    expect(pathsA.homeDirectory).not.toBe(pathsB.homeDirectory);

    // The host default DSH home is untouched (FR-001).
    expect(homeSnapshot()).toEqual(homeBefore);

    await harness.managed.close();
  });

  it('replays an idempotent create and conflicts on a changed payload', async () => {
    const harness = await buildHarness();
    const first = harness.dispatch('environments.create', {
      requestId: 'req-replay',
      name: 'one',
      catalogCombinationId: combinationA.id,
    });
    const replay = harness.dispatch('environments.create', {
      requestId: 'req-replay',
      name: 'one',
      catalogCombinationId: combinationA.id,
    });
    expect(first.ok && replay.ok).toBe(true);
    if (first.ok && replay.ok) {
      expect(replay.value).toEqual(first.value);
    }
    await harness.managed.waitForOperation(operationRefOf(first));

    const conflict = harness.dispatch('environments.create', {
      requestId: 'req-replay',
      name: 'two',
      catalogCombinationId: combinationA.id,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
    }

    const list = harness.dispatch('environments.list', {});
    if (list.ok) {
      expect(list.value).toHaveLength(1);
    }
    await harness.managed.close();
  });

  it('creates six environments concurrently from the same composition with one valid cache entry', { timeout: 20_000 }, async () => {
    const harness = await buildHarness({ catalog: [combinationA] });
    const operationIds = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        createEnvironment(harness, combinationA.id, `req-c${String(index)}`, `concurrent-${String(index)}`),
      ),
    );
    const settled = await Promise.all(
      operationIds.map((operationId) => harness.managed.waitForOperation(operationId)),
    );
    expect(settled.every((snapshot) => snapshot.status === 'succeeded')).toBe(true);
    const list = harness.dispatch('environments.list', {});
    if (list.ok) {
      expect(list.value).toHaveLength(6);
    }
    // The content-addressed cache holds exactly the two verified entries and no
    // staging leftovers; ordering-independent, digest-checked.
    const cacheFiles = listFilesRecursively(join(resolveLayout(harness.dataRoot).artifacts));
    expect(cacheFiles).toHaveLength(2);
    const digests = cacheFiles.map((file) =>
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    );
    expect(new Set(digests)).toEqual(new Set([sha256(nodeA), sha256(dshA)]));
    expect(listFilesRecursively(join(resolveLayout(harness.dataRoot).tmp))).toHaveLength(0);
    await harness.managed.close();
  });

  it('rejects unknown, unverified and platform-mismatched combinations before any effect', async () => {
    const harness = await buildHarness();
    const unknown = harness.dispatch('environments.create', {
      requestId: 'req-unknown',
      name: 'x',
      catalogCombinationId: 'does-not-exist',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('NOT_FOUND');
    }
    const unverified = harness.dispatch('environments.create', {
      requestId: 'req-unverified',
      name: 'x',
      catalogCombinationId: unverifiedCombination.id,
    });
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) {
      expect(unverified.error.code).toBe('UNSUPPORTED_COMBINATION');
    }
    const wrongPlatform = harness.dispatch('environments.create', {
      requestId: 'req-windows',
      name: 'x',
      catalogCombinationId: windowsCombination.id,
    });
    expect(wrongPlatform.ok).toBe(false);
    if (!wrongPlatform.ok) {
      expect(wrongPlatform.error.code).toBe('UNSUPPORTED_COMBINATION');
    }
    const list = harness.dispatch('environments.list', {});
    if (list.ok) {
      expect(list.value).toHaveLength(0);
    }
    await harness.managed.close();
  });
});

describe('creation failure terminal states', () => {
  const expectFailedEnvironment = (harness: Harness, operationId: string, code: string) =>
    harness.managed.waitForOperation(operationId).then((snapshot) => {
      expect(snapshot.status).toBe('failed');
      expect(snapshot.error?.code).toBe(code);
      const list = harness.dispatch('environments.list', {});
      if (list.ok) {
        const environments = list.value as Array<{
          state: string;
          activeGenerationId: string | null;
          compositionDigest: string | null;
        }>;
        expect(environments).toHaveLength(1);
        expect(environments[0]?.state).toBe('error');
        expect(environments[0]?.activeGenerationId).toBeNull();
        expect(environments[0]?.compositionDigest).toBeNull();
      }
      return snapshot;
    });

  it('records DIGEST_MISMATCH when the artifact bytes do not match the catalog', async () => {
    const claimed = 'f'.repeat(64);
    const broken = syntheticCombination({
      id: 'broken-digest',
      nodeVersion: '22.0.0',
      nodeTarball: nodeA,
      nodeSha256Override: claimed,
      dshVersion: '0.1.5-rc.2',
      dshTarball: dshA,
    });
    const harness = await buildHarness({
      catalog: [broken],
      extraLocalArtifacts: [{ sha256: claimed, tarball: nodeA }],
    });
    const operation = await createEnvironment(harness, broken.id, 'req-broken');
    await expectFailedEnvironment(harness, operation, 'DIGEST_MISMATCH');
    await harness.managed.close();
  });

  it('records DOWNLOAD_FAILED when the artifact host is unreachable', async () => {
    const unreachable = syntheticCombination({
      id: 'unreachable-host',
      nodeVersion: '22.0.0',
      nodeTarball: nodeA,
      // Not present in the offline fixture root, so the installer must reach out;
      // port 1 refuses the connection deterministically.
      nodeSha256Override: 'e'.repeat(64),
      dshVersion: '0.1.5-rc.2',
      dshTarball: dshA,
      urlBase: 'http://127.0.0.1:1',
    });
    const harness = await buildHarness({ catalog: [unreachable] });
    const operation = await createEnvironment(harness, unreachable.id, 'req-unreachable');
    await expectFailedEnvironment(harness, operation, 'DOWNLOAD_FAILED');
    await harness.managed.close();
  });

  it('records DISK_FULL from the injected disk guard', async () => {
    const harness = await buildHarness({
      catalog: [combinationA],
      faultsRuntime: { forceDiskFull: true },
    });
    const operation = await createEnvironment(harness, combinationA.id, 'req-disk');
    await expectFailedEnvironment(harness, operation, 'DISK_FULL');
    await harness.managed.close();
  });

  it('refuses an artifacts-only generation on the production path', async () => {
    const harness = await buildHarness({ catalog: [combinationA], fixtures: false });
    const operation = await createEnvironment(harness, combinationA.id, 'req-gate');
    await expectFailedEnvironment(harness, operation, 'INTERNAL_ERROR');
    await harness.managed.close();
  });
});

describe('journal recovery', () => {
  it('reconciles an interrupted create after a restart', async () => {
    const dataRoot = freshRoot('hdsl-recover-');
    const harness = await buildHarness({
      catalog: [combinationA],
      dataRoot,
      faults: { pauseBeforeCommit: true },
    });
    const operation = await createEnvironment(harness, combinationA.id, 'req-paused');
    await waitForJournalPhase(dataRoot, 'artifacts-installed');
    const running = harness.managed.service.findOperation(operation);
    expect(running.ok && running.value.status).toBe('running');
    await harness.managed.close();

    // A fresh service (simulated application restart) reconciles the journal.
    const restarted = await buildHarness({ catalog: [combinationA], dataRoot });
    const report = await restarted.managed.recover();
    expect(report.reconciled).toBe(1);
    expect(report.rolledBack).toBe(1);
    expect(report.details[0]?.generationId).not.toBeNull();

    const settled = restarted.managed.service.findOperation(operation);
    expect(settled.ok).toBe(true);
    if (settled.ok) {
      expect(settled.value.status).toBe('failed');
      expect(settled.value.error?.code).toBe('INTERNAL_ERROR');
    }
    const list = restarted.dispatch('environments.list', {});
    if (list.ok) {
      const environments = list.value as Array<{ state: string; activeGenerationId: string | null }>;
      expect(environments[0]?.state).toBe('error');
      expect(environments[0]?.activeGenerationId).toBeNull();
    }
    const generationId = report.details[0]?.generationId as string;
    const environmentId = report.details[0]?.environmentId as string;
    expect(existsSync(generationPaths(resolveLayout(dataRoot), environmentId, generationId).generationDirectory)).toBe(false);
    expect(readdirSync(resolveLayout(dataRoot).transactions)).toHaveLength(0);
    await restarted.managed.close();
  });

  it('cancels a paused operation and keeps the journal recoverable', async () => {
    const dataRoot = freshRoot('hdsl-cancel-');
    const harness = await buildHarness({
      catalog: [combinationA],
      dataRoot,
      faults: { pauseBeforeCommit: true },
    });
    const operation = await createEnvironment(harness, combinationA.id, 'req-cancel');
    await waitForJournalPhase(dataRoot, 'artifacts-installed');
    const cancelled = harness.managed.service.cancelOperation(operation);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value.status).toBe('cancelled');
    }
    await harness.managed.close();
  });

  it('does not roll back a create that is still in flight in this process', async () => {
    const dataRoot = freshRoot('hdsl-inflight-');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      resolveComposition,
      compositionDigest: computeCompositionDigest,
      install: async () => {
        await gate;
        return portFail('DOWNLOAD_FAILED' as const, 'released by the test');
      },
    };
    const managed = await createManagedInstall({
      dataRoot,
      catalog: [combinationA],
      runtime,
      host: TEST_HOST,
      fixtures: { allowArtifactsOnly: true },
    });
    const contract = createContractRuntime({ port: managed.port });
    const created = contract.dispatch({
      apiVersion: API_VERSION,
      method: 'environments.create',
      input: { requestId: 'req-live', name: 'live', catalogCombinationId: combinationA.id },
    });
    expect(created.ok).toBe(true);
    const operationId = created.ok ? (created.value as { operationId: string }).operationId : '';

    // The install is deliberately blocked, so the operation is live when
    // recover() runs; recovery must leave it and its journal alone.
    const report = await managed.recover();
    expect(report.reconciled).toBe(0);
    const running = managed.service.findOperation(operationId);
    expect(running.ok).toBe(true);
    if (running.ok) {
      expect(running.value.status).toBe('running');
    }
    expect(readdirSync(resolveLayout(dataRoot).transactions)).toHaveLength(1);

    release?.();
    const settled = await managed.waitForOperation(operationId);
    expect(settled.status).toBe('failed');
    expect(settled.error?.code).toBe('DOWNLOAD_FAILED');
    await managed.close();
  });

  it('fails an environment stuck in creating with no journal or operation', async () => {
    const dataRoot = freshRoot('hdsl-orphan-');
    const harness = await buildHarness({ catalog: [combinationA], dataRoot });
    const layout = resolveLayout(dataRoot);
    const store = new EnvironmentStore(layout);
    const now = new Date().toISOString();
    const orphanId = 'env-orphancreating0';
    store.write({
      schemaVersion: '1',
      id: orphanId,
      name: 'orphan',
      revision: 0,
      stateVersion: 1,
      state: 'creating',
      activeGenerationId: null,
      compositionDigest: null,
      createdAt: now,
      updatedAt: now,
    });
    const report = await harness.managed.recover();
    expect(report.details.some((detail) => detail.environmentId === orphanId)).toBe(true);
    expect(store.read(orphanId)?.state).toBe('error');
    await harness.managed.close();
  });
});


describe('production pointer/journal recovery window (A2)', () => {
  it('rejects cancel when the pointer already switched and finalizes operation/ledger consistently (D1 same pattern)', async () => {
    const dataRoot = freshRoot('hdsl-pointer-cancel-');
    const paused = await buildHarness({ dataRoot, faults: { pauseAfterPointerSwitch: true } });
    const operationId = await createEnvironment(paused, combinationA.id, 'req-pointer-cancel');
    const deadline = Date.now() + 10_000;
    let environment: { id: string; activeGenerationId: string | null } | undefined;
    for (;;) {
      const listed = paused.managed.service.listEnvironments();
      environment = listed.ok ? listed.value[0] : undefined;
      if (environment !== undefined && environment.activeGenerationId !== null) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('the active generation pointer was never switched');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const cancel = paused.managed.service.cancelOperation(operationId);
    expect(cancel?.ok).toBe(false);
    if (cancel !== undefined && !cancel.ok) {
      expect(cancel.code).toBe('CANNOT_CANCEL');
    }
    const afterCancel = paused.managed.service.findOperation(operationId);
    expect(afterCancel.ok ? afterCancel.value.status : undefined).toBe('running');
    await paused.managed.close();

    // Simulate a crash that left the request `in-progress` at the commit boundary.
    const layout = resolveLayout(dataRoot);
    new IdempotencyStore(layout).write('req-pointer-cancel', {
      state: 'in-progress',
      method: 'environments.create',
      fingerprint: 'fp',
    });

    const restarted = await buildHarness({ dataRoot });
    const report = await restarted.managed.recover();
    expect(report.finalized).toBeGreaterThanOrEqual(1);
    const operation = restarted.managed.service.findOperation(operationId);
    expect(operation.ok ? operation.value.status : undefined).toBe('succeeded');
    expect(new IdempotencyStore(layout).read('req-pointer-cancel')?.state).toBe('completed');
    const after = restarted.managed.service.listEnvironments();
    expect(after.ok ? after.value[0]?.activeGenerationId : undefined).toBe(environment.activeGenerationId);
    await restarted.managed.close();
  });

  it('repairs a pre-existing cancelled create operation over a committed pointer (upgrade path)', async () => {
    const dataRoot = freshRoot('hdsl-pointer-upgrade-');
    const paused = await buildHarness({ dataRoot, faults: { pauseAfterPointerSwitch: true } });
    const operationId = await createEnvironment(paused, combinationA.id, 'req-pointer-upgrade');
    const deadline = Date.now() + 10_000;
    for (;;) {
      const listed = paused.managed.service.listEnvironments();
      const environment = listed.ok ? listed.value[0] : undefined;
      if (environment !== undefined && environment.activeGenerationId !== null) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('the active generation pointer was never switched');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await paused.managed.close();

    // Simulate the residue an older build could leave: pointer committed but the
    // operation already stored as `cancelled`, with an in-progress ledger.
    const layout = resolveLayout(dataRoot);
    const operations = new OperationStore(layout);
    const record = operations.read(operationId)!;
    operations.write({
      ...record,
      status: 'cancelled',
      phase: 'cancelled',
      sequence: record.sequence + 1,
      updatedAt: '2026-09-22T00:05:00.000Z',
    });
    new IdempotencyStore(layout).write('req-pointer-upgrade', {
      state: 'in-progress',
      method: 'environments.create',
      fingerprint: 'fp',
    });

    const restarted = await buildHarness({ dataRoot });
    const report = await restarted.managed.recover();
    expect(report.finalized).toBeGreaterThanOrEqual(1);
    const operation = restarted.managed.service.findOperation(operationId);
    expect(operation.ok ? operation.value.status : undefined).toBe('succeeded');
    expect(new IdempotencyStore(layout).read('req-pointer-upgrade')?.state).toBe('completed');
    await restarted.managed.close();
  });

  it('rolls forward when the pointer switched but the journal was not committed', async () => {
    const dataRoot = freshRoot('hdsl-pointer-window-');
    const paused = await buildHarness({ dataRoot, faults: { pauseAfterPointerSwitch: true } });
    const operationId = await createEnvironment(paused, combinationA.id, 'req-pointer-window');

    // Wait until the pointer is authoritative (the crashed state).
    const deadline = Date.now() + 10_000;
    let environment: { id: string; activeGenerationId: string | null } | undefined;
    for (;;) {
      const listed = paused.managed.service.listEnvironments();
      environment = listed.ok ? listed.value[0] : undefined;
      if (environment !== undefined && environment.activeGenerationId !== null) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('the active generation pointer was never switched');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const generationId = environment.activeGenerationId;
    await paused.managed.close();

    // A fresh instance must roll forward (finalize), never roll back/delete.
    const restarted = await buildHarness({ dataRoot });
    const report = await restarted.managed.recover();
    expect(report.finalized).toBeGreaterThanOrEqual(1);
    const after = restarted.managed.service.listEnvironments();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value[0]?.activeGenerationId).toBe(generationId);
    }
    const operation = restarted.managed.service.findOperation(operationId);
    expect(operation.ok).toBe(true);
    if (operation.ok) {
      expect(operation.value.status).toBe('succeeded');
    }
    expect(existsSync(generationPaths(resolveLayout(dataRoot), environment.id, generationId ?? '').generationDirectory)).toBe(true);
    await restarted.managed.close();
  });
});

describe('generation profile init adapter seam (A2)', () => {
  interface ExecCall {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
  }

  const makeExecutor = (options: { create?: boolean; symlinkDeclaration?: boolean; internalLink?: boolean } = {}) => {
    const calls: ExecCall[] = [];
    const execute = async (
      executable: string,
      args: readonly string[],
      runOptions: { cwd: string; env: Record<string, string> },
    ) => {
      calls.push({ executable, args, cwd: runOptions.cwd, env: runOptions.env });
      if (options.create !== false) {
        const name = args[args.indexOf('--profile') + 1] as string;
        const home = runOptions.env['DSH_HOME'] as string;
        const directory = join(home, 'profiles', name);
        mkdirSync(directory, { recursive: true });
        if (options.symlinkDeclaration === true) {
          const real = join(home, 'real-package.json');
          writeFileSync(real, '{"name":"elsewhere"}');
          symlinkSync(real, join(directory, 'package.json'));
        } else {
          writeFileSync(
            join(directory, 'package.json'),
            JSON.stringify({ name: 'dsh-profile-fixture', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
          );
        }
        writeFileSync(join(directory, 'cordis.patch.yml'), '# patch\n');
        if (options.internalLink === true) {
          const real = join(home, 'staging-owned.txt');
          writeFileSync(real, 'x');
          symlinkSync(real, join(directory, 'internal-link'));
        }
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    return { execute, calls };
  };

  const settle = async (harness: Harness, requestId: string): Promise<string> => {
    const operationId = await createEnvironment(harness, combinationA.id, requestId);
    await harness.managed.waitForOperation(operationId, { timeoutMs: 15_000 });
    return operationId;
  };

  it('runs the exact argv/cwd/isolated env and closes install->publish->record->argv', async () => {
    const { execute, calls } = makeExecutor();
    const harness = await buildHarness({ profileInit: true, executeCommand: execute });
    await settle(harness, 'req-seam-loop');

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    const listed = harness.managed.service.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const environment = listed.value[0];
    expect(environment).toBeDefined();
    if (environment === undefined || environment.activeGenerationId === null) {
      return;
    }
    const layout = resolveLayout(harness.dataRoot);
    const paths = generationPaths(layout, environment.id, environment.activeGenerationId);
    const profileName = managedProfileName(environment.activeGenerationId);

    // Exact argv (argv[0] is the DSH entrypoint), cwd, and isolated env.
    expect(call.args.slice(1)).toEqual([
      '--profile',
      profileName,
      '--from-default-profile',
      'web',
      '--dump-config',
    ]);
    expect(call.args[0]).toBe(paths.dshDirectory + '/node_modules/@deepseek-ai/dsh/lib/bin.js');
    expect(call.cwd).toBe(paths.generationDirectory);
    expect(call.env['DSH_HOME']).toBe(join(paths.generationDirectory, '.profile-stage-home'));
    expect(call.env['HOME']).toBe(call.env['DSH_HOME']);
    expect(call.env['TMPDIR']).toBe(join(paths.generationDirectory, '.profile-stage-home', '.tmp'));
    expect(call.env['PATH']).toContain(join(paths.generationDirectory, 'node', 'bin'));
    expect(call.env['OPENAI_API_KEY']).toBeUndefined();

    // Staged immutable source retained; published profile + record name/digest.
    expect(existsSync(join(paths.generationDirectory, 'profile', 'package.json'))).toBe(true);
    expect(existsSync(join(environmentPaths(layout, environment.id).profilesDirectory, profileName))).toBe(true);
    const record = JSON.parse(readFileSync(paths.generationRecordPath, 'utf8')) as {
      profileName?: string;
      profileDigest?: string;
    };
    expect(record.profileName).toBe(profileName);
    expect((record.profileDigest ?? '').length).toBe(64);

    await harness.managed.close();
  });

  it('fails closed when the managed DSH does not produce the declaration source', async () => {
    const { execute } = makeExecutor({ create: false });
    const harness = await buildHarness({ profileInit: true, executeCommand: execute });
    const operationId = await createEnvironment(harness, combinationA.id, 'req-seam-missing');
    const snapshot = await harness.managed.waitForOperation(operationId, { timeoutMs: 15_000 });
    expect(snapshot.status).toBe('failed');
    const listed = harness.managed.service.listEnvironments();
    expect(listed.ok && listed.value[0]?.activeGenerationId).toBeNull();
    await harness.managed.close();
  });

  it('fails closed on a non-regular declaration file', async () => {
    const { execute } = makeExecutor({ symlinkDeclaration: true });
    const harness = await buildHarness({ profileInit: true, executeCommand: execute });
    const operationId = await createEnvironment(harness, combinationA.id, 'req-seam-symlink');
    const snapshot = await harness.managed.waitForOperation(operationId, { timeoutMs: 15_000 });
    expect(snapshot.status).toBe('failed');
    await harness.managed.close();
  });

  it('fails closed when the staged profile links back into the staging home', async () => {
    const { execute } = makeExecutor({ internalLink: true });
    const harness = await buildHarness({ profileInit: true, executeCommand: execute });
    const operationId = await createEnvironment(harness, combinationA.id, 'req-seam-internal-link');
    const snapshot = await harness.managed.waitForOperation(operationId, { timeoutMs: 15_000 });
    expect(snapshot.status).toBe('failed');
    await harness.managed.close();
  });

  it('fails closed when the manifest profile name mismatches the staged source', async () => {
    const { execute } = makeExecutor();
    const harness = await buildHarness({
      profileInit: true,
      executeCommand: execute,
      faultsRuntime: { mismatchProfileName: true },
    });
    const operationId = await createEnvironment(harness, combinationA.id, 'req-seam-name');
    const snapshot = await harness.managed.waitForOperation(operationId, { timeoutMs: 15_000 });
    expect(snapshot.status).toBe('failed');
    await harness.managed.close();
  });

  it('fails closed when the manifest profile digest mismatches the staged source', async () => {
    const { execute } = makeExecutor();
    const harness = await buildHarness({
      profileInit: true,
      executeCommand: execute,
      faultsRuntime: { mismatchProfileDigest: true },
    });
    const operationId = await createEnvironment(harness, combinationA.id, 'req-seam-digest');
    const snapshot = await harness.managed.waitForOperation(operationId, { timeoutMs: 15_000 });
    expect(snapshot.status).toBe('failed');
    await harness.managed.close();
  });
});

describe('generations.list (read-only generation surface)', () => {
  it('lists durable generation summaries, marks the active one, and rejects unknown environments', async () => {
    const harness = await buildHarness();
    const operationId = await createEnvironment(harness, combinationA.id, 'req-gen-list');
    const snapshot = await harness.managed.waitForOperation(operationId, { timeoutMs: 15_000 });
    expect(snapshot.status).toBe('succeeded');

    const listed = harness.managed.service.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const environment = listed.value[0];
    expect(environment).toBeDefined();
    if (environment === undefined || environment.activeGenerationId === null) {
      return;
    }

    const generations = harness.managed.service.listGenerations(environment.id);
    expect(generations.ok).toBe(true);
    if (generations.ok) {
      expect(generations.value).toHaveLength(1);
      expect(generations.value[0]?.generationId).toBe(environment.activeGenerationId);
      expect(generations.value[0]?.active).toBe(true);
      expect(generations.value[0]?.profileName).toBeNull();
      expect(generations.value[0]?.compositionDigest).toBe(environment.compositionDigest);
    }

    const unknown = harness.managed.service.listGenerations('env-ffffffffffffffff');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe('NOT_FOUND');
    }

    await harness.managed.close();
  });
});
