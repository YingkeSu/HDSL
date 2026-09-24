/**
 * Core-owned desired-config entry patch (#135, E1-T1).
 *
 * It edits the **environment-shared home user patch**
 * (`<env>/home/cordis.patch.yml`, i.e. DSH `$DSH_HOME/cordis.patch.yml`) and
 * NEVER a generation's immutable profile declaration source
 * (`<env>/home/profiles/hdsl-<gen>/cordis.patch.yml`), whose fingerprint is part
 * of the generation identity (ADR 0006 / `profileDeclarationFingerprint`).
 *
 * A successful write means **desired config was persisted**, not that the
 * running DSH reached the matching ACTIVE set. The terminal result is always
 * `saved: true` + `runtime: 'pending'` + `runtimeVerification: 'unavailable'`
 * and an `activation` that is `restart-required` or `live-reload-unverified`.
 *
 * Concurrency: the whole read-modify-write runs synchronously inside
 * {@link EntryPatchService.patchEntry}, so a single environment cannot interleave
 * two edits. An explicit per-environment in-flight guard additionally rejects a
 * reentrant edit with `ENVIRONMENT_BUSY` instead of letting it read a stale
 * pre-edit document. A `starting`/`stopping` (`creating`) environment is refused
 * with `ENVIRONMENT_BUSY`; a `running` environment is allowed and takes the hot
 * path, which is still never reported as ACTIVE.
 */
import { join } from 'node:path';
import {
  portFail,
  portOk,
  type EntryPatchCommand,
  type EntryPatchResult,
  type PortOutcome,
} from '@hdsl/contracts';
import { environmentPaths, type AppDataLayout } from './layout.js';
import { readGenerationProfileName } from './generation-profile.js';
import { readTextFile, tryReadJsonFile } from './fsx.js';
import type { EnvironmentStore } from './environment-store.js';
import type { EntryPatchPort } from './ports.js';

export interface EntryPatchServiceOptions {
  readonly layout: AppDataLayout;
  readonly environments: EnvironmentStore;
  readonly port: EntryPatchPort;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Reads the declared `dsh.profile.patchReload` of a published profile. */
const readPatchReloadMode = (packageJsonPath: string): 'live' | 'startup' | 'unknown' => {
  const declaration = asRecord(tryReadJsonFile<unknown>(packageJsonPath));
  const dsh = asRecord(declaration?.['dsh']);
  const profile = asRecord(dsh?.['profile']);
  const value = profile?.['patchReload'];
  return value === 'live' || value === 'startup' ? value : 'unknown';
};

/** Legacy generations were launched without `--profile` (the default `web`). */
const LEGACY_PROFILE_NAME = 'web';

const HOME_PATCH_FILENAME = 'cordis.patch.yml';

const stateIsBusy = (state: string): boolean =>
  state === 'creating' || state === 'starting' || state === 'stopping';

export class EntryPatchService {
  readonly #layout: AppDataLayout;
  readonly #environments: EnvironmentStore;
  readonly #port: EntryPatchPort;
  readonly #inFlight = new Set<string>();

  constructor(options: EntryPatchServiceOptions) {
    this.#layout = options.layout;
    this.#environments = options.environments;
    this.#port = options.port;
  }

  /**
   * Persists one desired-config edit on the environment home user patch. The
   * read-modify-write is synchronous and guarded against reentrancy, so two
   * edits of the same environment can never interleave into a lost update.
   */
  patchEntry(command: EntryPatchCommand): PortOutcome<EntryPatchResult> {
    const environment = this.#environments.read(command.environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    if (stateIsBusy(environment.state)) {
      return portFail(
        'ENVIRONMENT_BUSY',
        'the desired config can only be edited while the environment is not starting or stopping',
      );
    }
    if (environment.activeGenerationId === null) {
      return portFail('NOT_FOUND', 'the environment has no active generation');
    }
    if (this.#inFlight.has(command.environmentId)) {
      return portFail(
        'ENVIRONMENT_BUSY',
        'another desired-config edit is already in progress for this environment',
      );
    }
    this.#inFlight.add(command.environmentId);
    try {
      const paths = environmentPaths(this.#layout, command.environmentId);
      const profileName =
        readGenerationProfileName(this.#layout, command.environmentId, environment.activeGenerationId) ??
        LEGACY_PROFILE_NAME;
      const reloadMode = readPatchReloadMode(
        join(paths.profilesDirectory, profileName, 'package.json'),
      );
      // The write target is the environment-SHARED home user patch. It is never
      // the per-generation immutable profile declaration source.
      const patchPath = join(paths.homeDirectory, HOME_PATCH_FILENAME);
      // A missing patch file is the legal empty array `[]`; a 0-byte file is
      // still an explicit INVALID_INPUT from the runtime boundary (fail loud).
      const text = readTextFile(patchPath) ?? '[]';
      const outcome = this.#port.applyPatch({
        operation: command.operation,
        homeRoot: paths.homeDirectory,
        patchPath,
        text,
        reloadMode,
      });
      if (!outcome.ok) {
        return outcome;
      }
      const applied = outcome.value;
      return portOk({
        environmentId: command.environmentId,
        operation: applied.operation,
        saved: true,
        runtime: 'pending',
        runtimeVerification: 'unavailable',
        activation: applied.activation,
        restartRequired: applied.activation === 'restart-required',
        reloadMode: applied.reloadMode,
        rows: applied.rows,
        diagnostics: applied.diagnostics,
      });
    } finally {
      this.#inFlight.delete(command.environmentId);
    }
  }
}
