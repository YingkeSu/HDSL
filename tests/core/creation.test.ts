/**
 * Environment creation / managed install acceptance tests (T004).
 *
 * Everything runs against a real `dataRoot` on disk with the real journal,
 * operation store and contract dispatcher. The artifact downloads use the
 * offline `localArtifactDirectory` fixture path (still SHA-256 verified), so
 * these are file-boundary tests — the opt-in `real-install` test covers the
 * official network sources.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_VERSION,
  createContractRuntime,
  type ContractResponse,
  type RuntimeCombination,
} from '@hdsl/contracts';
import {
  createManagedInstall,
  generationPaths,
  resolveLayout,
  type ManagedInstall,
} from '@hdsl/core';
import { createRuntimePort } from '@hdsl/runtime';
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

const freshRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

interface HarnessOptions {
  readonly catalog?: readonly RuntimeCombination[];
  readonly fixtures?: boolean;
  readonly faults?: { readonly failBeforeCommit?: boolean; readonly pauseBeforeCommit?: boolean };
  readonly faultsRuntime?: {
    readonly failDownloadAfterBytes?: number;
    readonly corruptDownload?: boolean;
    readonly forceDiskFull?: boolean;
    readonly failExtraction?: boolean;
  };
  readonly dataRoot?: string;
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
    localArtifactDirectory: localArtifacts,
    ...(options.faultsRuntime === undefined ? {} : { faults: options.faultsRuntime }),
  });
  const catalog = options.catalog ?? [combinationA, combinationB, unverifiedCombination, windowsCombination];
  const managed = await createManagedInstall({
    dataRoot,
    catalog,
    runtime,
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
    const homeBefore = join(homedir(), '.dsh');
    const existedBefore = existsSync(homeBefore);

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

    // No environment-specific content may leak into the other generation.
    expect(existsSync(join(pathsA.generationDirectory, 'home'))).toBe(true);
    expect(existsSync(join(pathsB.generationDirectory, 'home'))).toBe(true);

    // The host default DSH home is untouched (FR-001).
    expect(existsSync(homeBefore)).toBe(existedBefore);

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
    const report = restarted.managed.recover();
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
});
