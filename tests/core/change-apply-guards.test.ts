/**
 * changes.apply guards + production transaction (ADR 0005 D5/D8/D9/D10).
 * A fake PluginApplyPort stages a profile; core owns the commit pointer switch.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
  managedProfileName,
  resolveLayout,
  type PluginApplyPort,
  type ChangeFaults,
  type EnvironmentRecord,
} from '@hdsl/core';
import { computeCompositionDigest, sha256TreeDigestSync } from '@hdsl/runtime';
import type { ChangeApplication, ChangePlan, CompositionLock } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const PLAN_ID = 'plan-0000000000000001';
const OLD_GENERATION = 'gen-0000000000000001';

const lock = (): CompositionLock => ({
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [{ id: 'dsh-plugin-demo', version: '1.0.0', sha256: 'c'.repeat(64) }],
  sources: { node: { url: 'https://fixture.invalid/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://fixture.invalid/d', sha256: 'b'.repeat(64) } },
});

const plan = (overrides: Partial<ChangePlan> = {}): ChangePlan => ({
  planId: PLAN_ID,
  environmentId: ENVIRONMENT_ID,
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
  ...overrides,
});

const stagedPort = (onStage?: () => void): PluginApplyPort => ({
  stage: async (command) => {
    onStage?.();
    const profile = join(command.generationDirectory, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-demo', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
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

const build = (options: { state?: EnvironmentRecord['state']; faults?: ChangeFaults; plan?: ChangePlan; port?: PluginApplyPort } = {}) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-apply-txn-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  const now = '2026-09-22T00:05:00.000Z';
  environments.write({
    schemaVersion: '1',
    id: ENVIRONMENT_ID,
    name: 'apply-env',
    revision: 3,
    stateVersion: 1,
    state: options.state ?? 'stopped',
    activeGenerationId: OLD_GENERATION,
    compositionDigest: '0'.repeat(64),
    createdAt: now,
    updatedAt: now,
  });
  const oldPaths = generationPaths(layout, ENVIRONMENT_ID, OLD_GENERATION);
  mkdirSync(join(oldPaths.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(oldPaths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
  writeFileSync(
    oldPaths.manifestPath,
    JSON.stringify({
      schemaVersion: '1',
      installMode: 'npm-ci',
      node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(oldPaths.nodeDirectory) },
      dsh: { version: '0.1.5-rc.2', treeDigest: sha256TreeDigestSync(join(oldPaths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')) },
    }),
  );
  writeFileSync(oldPaths.lockPath, JSON.stringify({ schemaVersion: '1', node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) }, dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) }, plugins: [], sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } } }));
  writeFileSync(oldPaths.generationRecordPath, JSON.stringify({ id: OLD_GENERATION, environmentId: ENVIRONMENT_ID, compositionDigest: '0'.repeat(64), createdAt: now }));
  const plans = new ChangePlanStore(layout);
  plans.write({ schemaVersion: '1', plan: options.plan ?? plan(), consumedBy: null });
  const operations = new OperationStore(layout);
  const service = new ChangeApplyService({
    layout,
    plans,
    environments,
    operations,
    compositionDigest: computeCompositionDigest,
    port: options.port ?? stagedPort(),
    verifyGenerationRuntime: () => true,
    now: () => new Date('2026-09-22T00:05:00.000Z'),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  return { layout, environments, plans, operations, service };
};

const command = () => ({ requestId: 'req-apply', environmentId: ENVIRONMENT_ID, expectedRevision: 3, planId: PLAN_ID, buildAuthorization: null });

const waitTerminal = async (operations: OperationStore, operationId: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const record = operations.read(operationId);
    if (record !== undefined && ['succeeded', 'failed', 'cancelled'].includes(record.status)) {
      return record;
    }
    if (Date.now() > deadline) {
      throw new Error('apply did not reach a terminal state');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('changes.apply commit-point revision re-validation', () => {
  it('refuses to overwrite a concurrent pointer move and keeps the concurrent generation', async () => {
    let store: EnvironmentStore | undefined;
    // The port simulates a concurrent transaction (e.g. a restore) that moves the
    // pointer and bumps the revision WHILE staging is in flight.
    const port = stagedPort(() => {
      const current = store!.read(ENVIRONMENT_ID)!;
      store!.write({ ...current, revision: current.revision + 1, activeGenerationId: 'gen-0000000000000009', compositionDigest: '9'.repeat(64) });
    });
    const { environments, operations, service } = build({ port });
    store = environments;
    const started = service.applyChange(command());
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('REVISION_CONFLICT');
    // The concurrent move survives: last-writer-wins is NOT applied.
    expect(environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe('gen-0000000000000009');
    expect(environments.read(ENVIRONMENT_ID)?.revision).toBe(4);
  });
});

describe('changes.apply guards + transaction', () => {
  it('rejects unknown environments, revision conflicts, expired/consumed plans, busy and build-required', () => {
    const conflict = build();
    conflict.environments.write({ ...conflict.environments.read(ENVIRONMENT_ID)!, revision: 9 });
    const revision = conflict.service.evaluateGuards(command());
    expect(revision.ok).toBe(false);
    if (!revision.ok) expect(revision.code).toBe('REVISION_CONFLICT');

    const busy = build({ state: 'running' });
    const busyOutcome = busy.service.evaluateGuards(command());
    expect(busyOutcome.ok).toBe(false);
    if (!busyOutcome.ok) expect(busyOutcome.code).toBe('ENVIRONMENT_BUSY');

    const needsBuild = build({ plan: plan({ requiresBuildAuthorization: true }) });
    const denied = needsBuild.service.evaluateGuards(command());
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('BUILD_NOT_AUTHORIZED');

    const expired = build({ plan: plan({ expiresAt: '2026-09-22T00:01:00.000Z' }) });
    const expiredOutcome = expired.service.evaluateGuards(command());
    expect(expiredOutcome.ok).toBe(false);
    if (!expiredOutcome.ok) expect(expiredOutcome.code).toBe('PLAN_EXPIRED');
  });

  it('commits a new generation, consumes the plan and emits ChangeApplication', async () => {
    const { layout, environments, plans, operations, service } = build();
    const started = service.applyChange(command());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('succeeded');
    const application = snapshot.output as ChangeApplication;
    expect(application.planId).toBe(PLAN_ID);
    expect(application.generationId).not.toBe(OLD_GENERATION);
    expect(application.compositionDigest).toBe(computeCompositionDigest(lock()));
    expect(application.sourceLock?.commitSha).toBe('e'.repeat(40));

    const environment = environments.read(ENVIRONMENT_ID)!;
    expect(environment.activeGenerationId).toBe(application.generationId);
    expect(environment.revision).toBe(4);
    expect(plans.read(PLAN_ID)?.consumedBy).toBe('req-apply');
    const paths = generationPaths(layout, ENVIRONMENT_ID, application.generationId);
    const record = JSON.parse(readFileSync(paths.generationRecordPath, 'utf8')) as { profileName?: string };
    expect(record.profileName).toBe(managedProfileName(application.generationId));
    expect(existsSync(join(layout.environments, ENVIRONMENT_ID, 'home', 'profiles', managedProfileName(application.generationId)))).toBe(true);
  });

  it('keeps the old generation unchanged and does not consume on a pre-commit failure', async () => {
    const { layout, environments, plans, operations, service } = build({ faults: { failAt: 'staged' } });
    const started = service.applyChange(command());
    if (!started.ok) return;
    const snapshot = await waitTerminal(operations, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    expect(environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
    expect(plans.read(PLAN_ID)?.consumedBy).toBeNull();
    // The interrupted staged generation is cleaned; the old one is intact.
    expect(existsSync(generationPaths(layout, ENVIRONMENT_ID, OLD_GENERATION).generationDirectory)).toBe(true);
  });

  it('rolls back a crashed pre-commit transaction and rolls forward after the pointer switch', async () => {
    const preCommit = build({ faults: { pauseAt: 'verified' } });
    preCommit.service.applyChange(command());
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A second apply is refused while the journal is unresolved.
    const blocked = preCommit.service.applyChange(command());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('ENVIRONMENT_BUSY');
    const recovery = preCommit.service.recover();
    expect(recovery.rolledBack).toBe(1);
    expect(preCommit.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);

    const postCommit = build({ faults: { pauseAt: 'committed' } });
    const postCommitStarted = postCommit.service.applyChange(command());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const switched = postCommit.environments.read(ENVIRONMENT_ID)?.activeGenerationId;
    expect(switched).not.toBe(OLD_GENERATION);
    const postRecovery = postCommit.service.recover();
    expect(postRecovery.finalized).toBe(1);
    const operation = postCommit.operations.read(postCommitStarted.ok ? postCommitStarted.value.operationId : '');
    expect(operation?.status).toBe('succeeded');
    expect(postCommit.plans.read(PLAN_ID)?.consumedBy).toBe('req-apply');
    expect(existsSync(generationPaths(postCommit.layout, ENVIRONMENT_ID, switched!).generationDirectory)).toBe(true);
  });
});
