/**
 * S5 QA (#79): install-apply cancellation semantics at the commit boundary.
 *
 * Deterministic, default-CI. Asserts the frozen contract D10 semantics:
 * - cancel BEFORE the commit point: terminal `cancelled`, old generation active,
 *   revision unchanged, plan NOT consumed;
 * - cancel AFTER the commit point: `CANNOT_CANCEL`, the committed operation stays
 *   `succeeded`, and the NEW generation remains active (after commit we do NOT
 *   assert the old composition is unchanged — that would be a false claim).
 *
 * No product code is changed; this only adds missing QA coverage (grep showed
 * CANNOT_CANCEL was previously exercised only by unexecuted scenario plans and a
 * fixture code list, not by an executed behavior test).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangeApplyService,
  ChangePlanStore,
  EnvironmentStore,
  OperationStore,
  ensureLayout,
  generationPaths,
  resolveLayout,
  type ChangePlan,
  type PluginApplyPort,
  type EnvironmentRecord,
} from '@hdsl/core';
import { computeCompositionDigest, sha256TreeDigestSync } from '@hdsl/runtime';
import type { CompositionLock } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ENV = 'env-0000000000000002';
const PLAN = 'plan-0000000000000002';
const OLD_GEN = 'gen-0000000000000002';

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

const plan = (): ChangePlan => ({
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

const stagedPort = (): PluginApplyPort => ({
  stage: async (command) => {
    const profile = join(command.generationDirectory, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'package.json'),
      JSON.stringify({ name: 'dsh-profile-demo', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    );
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
    return {
      ok: true,
      value: {
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
      },
    };
  },
});

const build = (port: PluginApplyPort) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-apply-cancel-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  const now = '2026-09-22T00:05:00.000Z';
  const record: EnvironmentRecord = {
    schemaVersion: '1',
    id: ENV,
    name: 'cancel-env',
    revision: 3,
    stateVersion: 1,
    state: 'stopped',
    activeGenerationId: OLD_GEN,
    compositionDigest: '0'.repeat(64),
    createdAt: now,
    updatedAt: now,
  };
  environments.write(record);
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
  plans.write({ schemaVersion: '1', plan: plan(), consumedBy: null });
  const operations = new OperationStore(layout);
  const service = new ChangeApplyService({
    layout,
    plans,
    environments,
    operations,
    compositionDigest: computeCompositionDigest,
    port,
    verifyGenerationRuntime: () => true,
    now: () => new Date('2026-09-22T00:05:00.000Z'),
  });
  return { environments, plans, operations, service };
};

const command = { requestId: 'req-cancel-install', environmentId: ENV, expectedRevision: 3, planId: PLAN, buildAuthorization: null };

const waitTerminal = async (operations: OperationStore, id: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const record = operations.read(id);
    if (record !== undefined && ['succeeded', 'failed', 'cancelled'].includes(record.status)) return record;
    if (Date.now() > deadline) throw new Error('apply did not reach a terminal state');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('changes.apply cancellation at the commit boundary (S5 #79)', () => {
  it('pre-commit cancel: terminal cancelled, old generation active, revision unchanged, plan not consumed', async () => {
    const aborting: PluginApplyPort = {
      stage: (_command, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ ok: false, code: 'INTERNAL_ERROR', message: 'aborted before commit' }),
            { once: true },
          );
        }),
    };
    const f = build(aborting);
    const started = f.service.applyChange(command);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 60));
    const cancelled = f.service.cancelOperation(started.value.operationId);
    expect(cancelled?.ok).toBe(true);
    const terminal = await waitTerminal(f.operations, started.value.operationId);
    expect(terminal.status).toBe('cancelled');
    const env = f.environments.read(ENV);
    expect(env?.activeGenerationId).toBe(OLD_GEN);
    expect(env?.revision).toBe(3);
    expect(f.plans.read(PLAN)?.consumedBy).toBeNull();
  });

  it('post-commit cancel: CANNOT_CANCEL, committed operation stays succeeded, new generation stays active', async () => {
    const f = build(stagedPort());
    const started = f.service.applyChange(command);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const terminal = await waitTerminal(f.operations, started.value.operationId);
    expect(terminal.status).toBe('succeeded');
    const committedGen = f.environments.read(ENV)?.activeGenerationId;
    expect(committedGen).not.toBe(OLD_GEN);

    const cancel = f.service.cancelOperation(started.value.operationId);
    expect(cancel?.ok).toBe(false);
    if (cancel?.ok === false) expect(cancel.code).toBe('CANNOT_CANCEL');
    // The committed operation is unchanged and the NEW generation remains active.
    const after = f.operations.read(started.value.operationId);
    expect(after?.status).toBe('succeeded');
    expect(f.environments.read(ENV)?.activeGenerationId).toBe(committedGen);
  });
});
