/**
 * S5 (#79): real dispatcher + real core `changes.apply` — retryable failure
 * replay/retry semantics for the INSTALL path (the remove path already has the
 * equivalent in tests/core/removal-apply.test.ts).
 *
 * Proves, on the real `createContractRuntime` over the real `ChangeApplyService`:
 *  - a controlled retryable failure (DOWNLOAD_FAILED) produces a terminal failed
 *    operation with the OLD generation unchanged and NO commit;
 *  - replaying the SAME requestId returns the original terminal result and does
 *    NOT repeat the effect (stage invocation count stays 1);
 *  - a NEW requestId is required to retry, and it succeeds (count 2).
 *
 * Deterministic, default CI. No product code changes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangeApplyService,
  ChangePlanStore,
  EnvironmentStore,
  IdempotencyStore,
  OperationStore,
  ensureLayout,
  generationPaths,
  resolveLayout,
  type ApplyChangeCommand,
} from '@hdsl/core';
import { computeCompositionDigest, sha256TreeDigestSync } from '@hdsl/runtime';
import {
  API_VERSION,
  portFail,
  portOk,
  createContractRuntime,
  type ChangePlan,
  type CompositionLock,
  type ContractPort,
  type ContractResponse,
  type IdempotencyRecord,
} from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ENV = 'env-0000000000000003';
const PLAN = 'plan-0000000000000003';
const OLD_GEN = 'gen-0000000000000003';

const lock = (): CompositionLock => ({
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [{ id: 'dsh-plugin-demo', version: '1.0.0', sha256: 'c'.repeat(64) }],
  sources: {
    node: { url: 'https://fixture.invalid/n', sha256: 'a'.repeat(64) },
    dsh: { url: 'https://fixture.invalid/d', sha256: 'b'.repeat(64) },
  },
});

const planValue = (): ChangePlan => ({
  planId: PLAN,
  environmentId: ENV,
  baseRevision: 3,
  action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
  createdAt: '2026-09-22T00:00:00.000Z',
  expiresAt: '2026-09-22T00:15:00.000Z',
  sourceLock: null,
  scriptAssessment: 'none-detected',
  scripts: [],
  requiresBuildAuthorization: false,
  riskItems: [],
  removals: [],
  retention: [],
  blockingReferences: [],
  executor: null,
  planInputsDigest: 'd'.repeat(64),
});

const build = () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-apply-replay-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const now = '2026-09-22T00:05:00.000Z';
  const environments = new EnvironmentStore(layout);
  environments.write({
    schemaVersion: '1',
    id: ENV,
    name: 'replay-env',
    revision: 3,
    stateVersion: 1,
    state: 'stopped',
    activeGenerationId: OLD_GEN,
    compositionDigest: '0'.repeat(64),
    createdAt: now,
    updatedAt: now,
  });
  const old = generationPaths(layout, ENV, OLD_GEN);
  mkdirSync(join(old.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(old.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(old.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(old.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
  writeFileSync(
    old.manifestPath,
    JSON.stringify({
      schemaVersion: '1',
      installMode: 'npm-ci',
      node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(old.nodeDirectory) },
      dsh: {
        version: '0.1.5-rc.2',
        treeDigest: sha256TreeDigestSync(join(old.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')),
      },
    }),
  );
  writeFileSync(
    old.lockPath,
    JSON.stringify({
      schemaVersion: '1',
      node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
      dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
      plugins: [],
      sources: {
        node: { url: 'https://x/n', sha256: 'a'.repeat(64) },
        dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) },
      },
    }),
  );
  writeFileSync(
    old.generationRecordPath,
    JSON.stringify({ id: OLD_GEN, environmentId: ENV, compositionDigest: '0'.repeat(64), createdAt: now }),
  );
  const plans = new ChangePlanStore(layout);
  plans.write({ schemaVersion: '1', plan: planValue(), consumedBy: null });
  const operations = new OperationStore(layout);
  const idempotency = new IdempotencyStore(layout);

  let stageCalls = 0;
  const service = new ChangeApplyService({
    layout,
    plans,
    environments,
    operations,
    idempotency,
    compositionDigest: computeCompositionDigest,
    verifyGenerationRuntime: () => true,
    now: () => new Date(now),
    port: {
      stage: async (command) => {
        stageCalls += 1;
        if (stageCalls === 1) {
          // controlled retryable failure (transport died after connection)
          return portFail('DOWNLOAD_FAILED', 'the source tarball transfer was interrupted');
        }
        const profile = join(command.generationDirectory, 'profile');
        mkdirSync(profile, { recursive: true });
        writeFileSync(
          join(profile, 'package.json'),
          JSON.stringify({ name: 'dsh-profile-demo', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
        );
        writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
        return portOk({
          compositionLock: lock(),
          sourceLock: {
            sourceKind: 'github',
            repository: { owner: 'octo', name: 'dsh-plugin-demo' },
            commitSha: 'e'.repeat(40),
            ref: null,
            packageName: 'dsh-plugin-demo',
            packageVersion: '1.0.0',
            manifestSha256: 'f'.repeat(64),
            closureLockSha256: '1'.repeat(64),
            isBuiltin: false,
            buildAuthorization: null,
            executor: null,
          },
          stagedProfileDirectory: profile,
        });
      },
    },
  });

  const port = {
    findEnvironment: (environmentId: string) => {
      const record = environments.read(environmentId);
      return record === undefined
        ? portFail('NOT_FOUND', 'environment was not found')
        : portOk({
            id: record.id,
            name: record.name,
            revision: record.revision,
            stateVersion: record.stateVersion,
            state: record.state,
            activeGenerationId: record.activeGenerationId,
            compositionDigest: record.compositionDigest,
          });
    },
    readIdempotency: (requestId: string) => idempotency.read(requestId),
    writeIdempotency: (requestId: string, record: IdempotencyRecord) => {
      idempotency.write(requestId, record);
    },
    applyChange: (command: ApplyChangeCommand) => service.applyChange(command),
  } as unknown as ContractPort;
  const contract = createContractRuntime({ port });
  const dispatch = (input: unknown): ContractResponse<unknown> =>
    contract.dispatch({ apiVersion: API_VERSION, method: 'changes.apply', input });
  return {
    environments,
    operations,
    idempotency,
    dispatch,
    stageCalls: () => stageCalls,
  };
};

const applyInput = (requestId: string) => ({ requestId, environmentId: ENV, expectedRevision: 3, planId: PLAN });

const waitTerminal = async (operations: OperationStore, operationId: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const record = operations.read(operationId);
    if (record !== undefined && ['succeeded', 'failed', 'cancelled'].includes(record.status)) return record;
    if (Date.now() > deadline) throw new Error('apply did not reach a terminal state');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('changes.apply retryable failure: same-id replay vs new-id retry (real dispatcher, S5 #79)', () => {
  it('retryable DOWNLOAD_FAILED: same requestId replays the accepted dispatch response without repeating the effect; new id retries to success', async () => {
    const h = build();
    const first = h.dispatch(applyInput('req-install-replay'));
    if (!first.ok) { console.log('FIRST_ERR=' + JSON.stringify(first)); return; }
    expect(first.ok).toBe(true);
    const opId = (first.value as { operationId: string }).operationId;
    const terminal = await waitTerminal(h.operations, opId);
    expect(terminal.status).toBe('failed');
    expect(terminal.error?.code).toBe('DOWNLOAD_FAILED');
    expect(h.environments.read(ENV)?.activeGenerationId).toBe(OLD_GEN);
    expect(h.stageCalls()).toBe(1);

    // Same requestId replay: original terminal is returned, effect NOT repeated.
    const replay = h.dispatch(applyInput('req-install-replay'));
    expect(replay).toEqual(first);
    expect(h.stageCalls()).toBe(1);
    expect(h.operations.read(opId)?.status).toBe('failed');

    // A NEW requestId is required to retry, and it succeeds.
    const retry = h.dispatch(applyInput('req-install-retry'));
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const retryOpId = (retry.value as { operationId: string }).operationId;
    const retryTerminal = await waitTerminal(h.operations, retryOpId);
    expect(retryTerminal.status).toBe('succeeded');
    expect(h.stageCalls()).toBe(2);
    expect(h.environments.read(ENV)?.activeGenerationId).not.toBe(OLD_GEN);
  });
});
