/**
 * Durable environment records (`environment.json`).
 *
 * `revision` is the composition revision (created + generation switches),
 * `stateVersion` is the state-transition counter; neither is a timestamp or a
 * PID (data-model.md). The record never stores a user name as a path and the
 * summary view exposes no secret or local path.
 */
import type { EnvironmentState, EnvironmentSummary } from '@hdsl/contracts';
import { OPAQUE_ID_PATTERN } from '@hdsl/contracts';
import { tryReadJsonFile, readDirectoryNames, writeJsonAtomic } from './fsx.js';
import { environmentDirectory, environmentRecordPath, type AppDataLayout } from './layout.js';

export interface EnvironmentRecord {
  readonly schemaVersion: '1';
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly stateVersion: number;
  readonly state: EnvironmentState;
  readonly activeGenerationId: string | null;
  readonly compositionDigest: string | null;
  /**
   * Additive (#114, A2): the generation this environment last started
   * successfully and the DSH version it ran. Missing on records written by
   * older builds and read as "unknown", which never produces a restore
   * compatibility warning.
   */
  readonly lastStartedGenerationId?: string | null;
  readonly lastStartedDshVersion?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const toEnvironmentSummary = (record: EnvironmentRecord): EnvironmentSummary => ({
  id: record.id,
  name: record.name,
  revision: record.revision,
  stateVersion: record.stateVersion,
  state: record.state,
  activeGenerationId: record.activeGenerationId,
  compositionDigest: record.compositionDigest,
});

export class EnvironmentStore {
  readonly #layout: AppDataLayout;

  constructor(layout: AppDataLayout) {
    this.#layout = layout;
  }

  read(environmentId: string): EnvironmentRecord | undefined {
    if (!OPAQUE_ID_PATTERN.test(environmentId)) {
      return undefined;
    }
    return tryReadJsonFile<EnvironmentRecord>(environmentRecordPath(this.#layout, environmentId));
  }

  /** Reads every record whose directory is still present, skipping torn ones. */
  list(): EnvironmentRecord[] {
    const records: EnvironmentRecord[] = [];
    for (const name of readDirectoryNames(this.#layout.environments)) {
      if (!OPAQUE_ID_PATTERN.test(name)) {
        continue;
      }
      const record = this.read(name);
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  write(record: EnvironmentRecord): void {
    environmentDirectory(this.#layout, record.id);
    writeJsonAtomic(environmentRecordPath(this.#layout, record.id), record);
  }
}
