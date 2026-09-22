/**
 * Plan-bound target-profile cache (review 5776435420).
 *
 * `changes.preview` resolves the EXPECTED TARGET PROFILE lock in isolation and
 * caches it here, bound to the plan id. `changes.apply` reads it back, verifies
 * every digest, and installs with the frozen lock. A missing, tampered or
 * mismatched cache is a controlled failure that never triggers execution.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import { tryReadJsonFile, writeJsonAtomic } from './fsx.js';
import type { AppDataLayout } from './layout.js';

export interface TargetProfileCache {
  readonly schemaVersion: '1';
  readonly planId: string;
  readonly lockText: string;
  readonly lockSha256: string;
  readonly declarationText: string;
  readonly workspaceText: string | null;
  readonly declarationSha256: string;
}

export interface TargetProfilePayload {
  readonly lockText: string;
  readonly declarationText: string;
  readonly workspaceText: string | null;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Binding digest over package.json + workspace config (mirrors the resolver). */
const declarationBinding = (declarationText: string, workspaceText: string | null): string =>
  sha256(JSON.stringify({ declaration: declarationText, workspace: workspaceText }));

export const targetProfileCachePath = (layout: AppDataLayout, planId: string): string =>
  join(layout.plans, `${planId}.target-profile.json`);

export const writeTargetProfileCache = (
  layout: AppDataLayout,
  planId: string,
  payload: TargetProfilePayload,
): PortOutcome<TargetProfileCache> => {
  const record: TargetProfileCache = {
    schemaVersion: '1',
    planId,
    lockText: payload.lockText,
    lockSha256: sha256(payload.lockText),
    declarationText: payload.declarationText,
    workspaceText: payload.workspaceText,
    declarationSha256: declarationBinding(payload.declarationText, payload.workspaceText),
  };
  try {
    writeJsonAtomic(targetProfileCachePath(layout, planId), record);
    return portOk(record);
  } catch {
    return portFail('INTERNAL_ERROR', 'the target profile cache could not be written');
  }
};

/**
 * Reads and verifies the cached target profile against the plan's bound digests.
 * Missing, tampered or mismatched content is a controlled failure.
 */
export const readTargetProfileCache = (
  layout: AppDataLayout,
  planId: string,
  expected: { readonly lockSha256: string | null | undefined; readonly declarationSha256: string | null | undefined },
): PortOutcome<TargetProfileCache> => {
  if (typeof expected.lockSha256 !== 'string' || typeof expected.declarationSha256 !== 'string') {
    return portFail('PLAN_STALE', 'the plan does not bind a target profile');
  }
  const record = tryReadJsonFile<TargetProfileCache>(targetProfileCachePath(layout, planId));
  if (record === undefined || record.planId !== planId) {
    return portFail('PLAN_STALE', 'the plan target profile cache is missing');
  }
  if (sha256(record.lockText) !== record.lockSha256 || record.lockSha256 !== expected.lockSha256) {
    return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the cached target lock does not match the plan');
  }
  if (
    declarationBinding(record.declarationText, record.workspaceText) !== record.declarationSha256 ||
    record.declarationSha256 !== expected.declarationSha256
  ) {
    return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the cached target declaration does not match the plan');
  }
  return portOk(record);
};

/**
 * Removal cache read: the cache is bound to the plan by `planId` + internal
 * integrity only. The plan's `planInputsDigest` is a composite that binds the
 * cached declaration binding to the target's exact source/runtime identity; the
 * apply transaction recomputes that composite from its own fresh derivation and
 * refuses a mismatch (`PLAN_STALE`) before any effect.
 */
export const readTargetProfileCacheForRemoval = (
  layout: AppDataLayout,
  planId: string,
): PortOutcome<TargetProfileCache> => {
  const record = tryReadJsonFile<TargetProfileCache>(targetProfileCachePath(layout, planId));
  if (record === undefined || record.planId !== planId) {
    return portFail('PLAN_STALE', 'the plan target profile cache is missing');
  }
  if (sha256(record.lockText) !== record.lockSha256) {
    return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the cached target lock does not match its recorded digest');
  }
  if (declarationBinding(record.declarationText, record.workspaceText) !== record.declarationSha256) {
    return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the cached target declaration does not match its recorded digest');
  }
  return portOk(record);
};
