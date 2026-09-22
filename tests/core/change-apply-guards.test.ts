/**
 * changes.apply guard layer (ADR 0005 D8/D9/D14): order, plan TTL/consumption,
 * revision priority and default-deny build authorization. The transaction itself
 * is not wired yet, so a guarded call fails with a controlled INTERNAL_ERROR
 * (never a fake success).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeApplyService, ChangePlanStore, resolveLayout } from '@hdsl/core';
import type { ChangePlan, EnvironmentSummary } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const PLAN_ID = 'plan-0000000000000001';

const environment = (state: EnvironmentSummary['state'] = 'stopped', revision = 3): EnvironmentSummary => ({
  id: ENVIRONMENT_ID,
  name: 'apply-env',
  revision,
  stateVersion: 1,
  state,
  activeGenerationId: 'gen-0000000000000001',
  compositionDigest: 'a'.repeat(64),
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
  planInputsDigest: 'b'.repeat(64),
  ...overrides,
});

const build = (options: {
  environment?: EnvironmentSummary | undefined;
  plan?: ChangePlan | undefined;
  consumedBy?: string | null;
  nowMs?: number;
} = {}) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-apply-guards-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  const store = new ChangePlanStore(layout);
  if (options.plan !== undefined) {
    store.write({ schemaVersion: '1', plan: options.plan, consumedBy: options.consumedBy ?? null });
  }
  const service = new ChangeApplyService({
    plans: store,
    findEnvironment: () => options.environment,
    now: () => new Date(options.nowMs ?? Date.parse('2026-09-22T00:05:00.000Z')),
  });
  return { service, store };
};

const command = (requestId = 'req-apply') => ({
  requestId,
  environmentId: ENVIRONMENT_ID,
  expectedRevision: 3,
  planId: PLAN_ID,
  buildAuthorization: null,
});

describe('changes.apply guards', () => {
  it('rejects an unknown environment and a revision conflict', () => {
    const unknown = build({ plan: plan() });
    const missing = unknown.service.evaluateGuards(command());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('NOT_FOUND');

    const conflict = build({ environment: environment('stopped', 9), plan: plan() });
    const revision = conflict.service.evaluateGuards(command());
    expect(revision.ok).toBe(false);
    if (!revision.ok) expect(revision.code).toBe('REVISION_CONFLICT');
  });

  it('lets the revision conflict outrank plan expiry and consumption', () => {
    const stalePlan = plan({ expiresAt: '2026-09-22T00:01:00.000Z' });
    const { service } = build({ environment: environment('stopped', 99), plan: stalePlan, consumedBy: 'other' });
    const outcome = service.evaluateGuards(command());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('REVISION_CONFLICT');
  });

  it('rejects a missing plan, an expired plan and a consumed plan', () => {
    const missing = build({ environment: environment() });
    const notFound = missing.service.evaluateGuards(command());
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.code).toBe('NOT_FOUND');

    const expired = build({ environment: environment(), plan: plan({ expiresAt: '2026-09-22T00:01:00.000Z' }) });
    const expiredOutcome = expired.service.evaluateGuards(command());
    expect(expiredOutcome.ok).toBe(false);
    if (!expiredOutcome.ok) expect(expiredOutcome.code).toBe('PLAN_EXPIRED');

    const consumed = build({ environment: environment(), plan: plan(), consumedBy: 'other-request' });
    const consumedOutcome = consumed.service.evaluateGuards(command());
    expect(consumedOutcome.ok).toBe(false);
    if (!consumedOutcome.ok) expect(consumedOutcome.code).toBe('PLAN_CONSUMED');
  });

  it('blocks a running environment and a source that needs build authorization', () => {
    const busy = build({ environment: environment('running'), plan: plan() });
    const busyOutcome = busy.service.evaluateGuards(command());
    expect(busyOutcome.ok).toBe(false);
    if (!busyOutcome.ok) expect(busyOutcome.code).toBe('ENVIRONMENT_BUSY');

    const needsBuild = build({ environment: environment(), plan: plan({ requiresBuildAuthorization: true, scriptAssessment: 'unknown' }) });
    const denied = needsBuild.service.evaluateGuards(command());
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('BUILD_NOT_AUTHORIZED');
  });

  it('passes guards for a valid plan but fails closed until the transaction is wired', () => {
    const { service } = build({ environment: environment(), plan: plan() });
    const guarded = service.evaluateGuards(command());
    expect(guarded.ok).toBe(true);
    const applied = service.applyChange(command());
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.code).toBe('INTERNAL_ERROR');
    }
    // No consumption is marked by a failed/guarded call.
    expect(service.planRecord(PLAN_ID)?.consumedBy).toBeNull();
  });
});
