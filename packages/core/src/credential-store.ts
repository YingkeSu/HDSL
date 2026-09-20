/**
 * Environment-scoped credential **reference** store (T005c / issue #52).
 *
 * HDSL stores a managed user credential only as an OS credential-store
 * reference (ADR 0002). This module owns the durable, environment-private
 * binding record (`<env>/credentials.json`): variable name → frozen
 * `CredentialReference`. It never stores a secret value, never resolves the
 * keychain (that is `@hdsl/runtime`'s `LaunchCredentialPort`) and never decides
 * `service#account` semantics (that is enforced by the production credential
 * port, T005b.2 / #51).
 *
 * The record is versioned, strictly validated (unknown fields rejected) and
 * written atomically with `0600` permissions. Mutations are only ever issued by
 * `EnvironmentService` under the data-root lock and the environment
 * existence/state guards; this module has no public IPC surface.
 */
import {
  credentialReferenceSchema,
  formatValidationIssues,
  sArray,
  sInteger,
  sLiteral,
  sObject,
  sString,
  type CredentialReference,
  type ValidationIssue,
} from '@hdsl/contracts';
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDirectory, pathExists, readTextFile, removePath } from './fsx.js';
import { environmentDirectory, type AppDataLayout } from './layout.js';

/** One credential the environment requires: an env var name and its reference. */
export interface CredentialBinding {
  /** Environment-variable name the managed child reads the secret from. */
  readonly name: string;
  readonly reference: CredentialReference;
}

/**
 * Structurally equivalent to `@hdsl/runtime`'s `LaunchCredentialRequest` (the
 * loader shape). Core must not import runtime, so the type is declared here.
 */
export interface LaunchCredentialRequest {
  readonly bindings: readonly CredentialBinding[];
  readonly baseEnv: Readonly<Record<string, string>>;
}

export interface EnvironmentCredentialRecord {
  readonly schemaVersion: '1';
  readonly revision: number;
  readonly bindings: readonly CredentialBinding[];
  readonly updatedAt: string;
}

const credentialBindingSchema = sObject({
  name: sString({ minLength: 1, maxLength: 128 }),
  reference: credentialReferenceSchema,
});

/** Strict schema: unknown fields are rejected anywhere in the record. */
export const environmentCredentialRecordSchema = sObject({
  schemaVersion: sLiteral('1'),
  revision: sInteger({ min: 1 }),
  bindings: sArray(credentialBindingSchema, { minLength: 1, maxLength: 64 }),
  updatedAt: sString({ minLength: 1, maxLength: 64 }),
});

export type EnvironmentCredentialRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'valid'; readonly record: EnvironmentCredentialRecord };

export type EnvironmentCredentialValidation =
  | { readonly ok: true; readonly record: EnvironmentCredentialRecord }
  | { readonly ok: false; readonly message: string };

export const validateEnvironmentCredentialRecord = (
  value: unknown,
): EnvironmentCredentialValidation => {
  const issues: ValidationIssue[] = [];
  const parsed = environmentCredentialRecordSchema(value, 'credentials', issues);
  return parsed === undefined
    ? { ok: false, message: formatValidationIssues(issues) }
    : { ok: true, record: parsed };
};

let temporaryCounter = 0;

export class CredentialStore {
  readonly #layout: AppDataLayout;

  constructor(layout: AppDataLayout) {
    this.#layout = layout;
  }

  /** `<dataRoot>/environments/<id>/credentials.json` (id-derived, caller cannot redirect). */
  recordPath(environmentId: string): string {
    return join(environmentDirectory(this.#layout, environmentId), 'credentials.json');
  }

  read(environmentId: string): EnvironmentCredentialRead {
    const path = this.recordPath(environmentId);
    if (!pathExists(path)) {
      return { kind: 'missing' };
    }
    const raw = readTextFile(path);
    if (raw === undefined) {
      return { kind: 'missing' };
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: 'invalid', message: 'the credential record is not valid JSON' };
    }
    const validated = validateEnvironmentCredentialRecord(value);
    return validated.ok
      ? { kind: 'valid', record: validated.record }
      : { kind: 'invalid', message: validated.message };
  }

  /** Validates and atomically replaces the record; throws on an invalid shape. */
  write(
    environmentId: string,
    bindings: readonly CredentialBinding[],
    previousRevision: number,
    now: string,
  ): EnvironmentCredentialRecord {
    const record: EnvironmentCredentialRecord = {
      schemaVersion: '1',
      revision: previousRevision + 1,
      bindings: [...bindings],
      updatedAt: now,
    };
    const validated = validateEnvironmentCredentialRecord(record);
    if (!validated.ok) {
      throw new Error(validated.message);
    }
    this.#writeAtomic(this.recordPath(environmentId), `${JSON.stringify(record, null, 2)}\n`);
    return validated.record;
  }

  clear(environmentId: string): void {
    removePath(this.recordPath(environmentId));
  }

  #writeAtomic(path: string, data: string): void {
    ensureDirectory(dirname(path));
    temporaryCounter += 1;
    const temporary = `${path}.tmp-${String(process.pid)}-${String(temporaryCounter)}`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(descriptor, data);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Some platforms refuse chmod on an already-correct file; the rename kept 0600.
    }
    const directory = openDirectoryBestEffort(dirname(path));
    if (directory !== undefined) {
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }
}

/** Opens a directory for fsync where the platform allows it. */
const openDirectoryBestEffort = (path: string): number | undefined => {
  try {
    return openSync(path, 'r');
  } catch {
    return undefined;
  }
};
