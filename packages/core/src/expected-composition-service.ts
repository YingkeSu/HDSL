/**
 * Core-owned lifecycle for the environment-scoped, read-only
 * `compositions.expected` operation (#118).
 *
 * It mirrors {@link VersionDiscoveryService}: it owns the operation record in
 * the durable `OperationStore`, resolves the ACTIVE generation's managed Node +
 * DSH entrypoint and published profile, runs the injected
 * {@link ExpectedCompositionPort} outside the renderer/main request path with a
 * hard abort seam for cancellation, and writes the terminal
 * `ExpectedCompositionView` to `OperationRecord.output`.
 *
 * The view is ALWAYS the desired/expected composition from the offline
 * `--dump-config` dump. It never claims the runtime ACTIVE plugin set: the
 * terminal payload carries fixed `basis: 'dump-config'` and
 * `runtimeVerification: 'unavailable'`. `--dump-config` runs no plugin code,
 * needs no credential, and `!!js` expressions are preserved, never evaluated.
 *
 * A running environment is refused with `ENVIRONMENT_BUSY`: `--dump-config`
 * rewrites the derived `cordis.yml` of its profile, and HDSL must not touch a
 * profile a live DSH process is using.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  contractErrorForCode,
  portFail,
  portOk,
  sanitizeBoundedMessage,
  EXPECTED_COMPOSITION_BUNDLES_MAX,
  EXPECTED_COMPOSITION_DIAGNOSTICS_MAX,
  EXPECTED_COMPOSITION_ROW_CONFIG_MAX,
  EXPECTED_COMPOSITION_STDERR_MAX,
  type ContractError,
  type ExpectedCompositionDiagnostic,
  type ExpectedCompositionGroup,
  type ExpectedCompositionView,
  type OperationRef,
  type OperationSnapshot,
  type PortOutcome,
} from '@hdsl/contracts';
import { newOperationId } from './ids.js';
import { environmentPaths, generationPaths, type AppDataLayout } from './layout.js';
import { isTerminalStatus, OperationStore, toOperationSnapshot } from './operation-store.js';
import { readGenerationProfileName } from './generation-profile.js';
import { tryReadJsonFile } from './fsx.js';
import type { EnvironmentStore } from './environment-store.js';
import type { ExpectedCompositionDumpResult, ExpectedCompositionPort } from './ports.js';

export interface ExpectedCompositionServiceOptions {
  readonly layout: AppDataLayout;
  readonly environments: EnvironmentStore;
  readonly port: ExpectedCompositionPort;
  readonly now?: () => Date;
}

interface ProfileMeta {
  readonly bundles: string[];
  readonly patchReload: 'live' | 'startup' | 'unknown';
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Reads the declared `dsh.profile` metadata of a profile `package.json`. */
const readProfileMeta = (path: string): ProfileMeta => {
  const declaration = asRecord(tryReadJsonFile<unknown>(path));
  const dsh = asRecord(declaration?.['dsh']);
  const profile = asRecord(dsh?.['profile']);
  const bundles = Array.isArray(profile?.['bundles'])
    ? profile['bundles']
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, EXPECTED_COMPOSITION_BUNDLES_MAX)
    : [];
  const reload = profile?.['patchReload'];
  const patchReload = reload === 'live' || reload === 'startup' ? reload : 'unknown';
  return { bundles, patchReload };
};

const stateIsBusy = (state: string): boolean =>
  state === 'starting' || state === 'running' || state === 'stopping';

/** Operation kind owned by this service. */
const COMPOSITION_OPERATION_KINDS: ReadonlySet<string> = new Set(['composition']);

export class ExpectedCompositionService {
  readonly #layout: AppDataLayout;
  readonly #environments: EnvironmentStore;
  readonly #port: ExpectedCompositionPort;
  readonly #store: OperationStore;
  readonly #now: () => Date;
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: ExpectedCompositionServiceOptions) {
    this.#layout = options.layout;
    this.#environments = options.environments;
    this.#port = options.port;
    this.#store = new OperationStore(options.layout);
    this.#now = options.now ?? (() => new Date());
  }

  owns(operationId: string): boolean {
    const record = this.#store.read(operationId);
    return record !== undefined && COMPOSITION_OPERATION_KINDS.has(record.kind);
  }

  findOperation(operationId: string): PortOutcome<OperationSnapshot> | undefined {
    if (!this.owns(operationId)) {
      return undefined;
    }
    const record = this.#store.read(operationId);
    return record === undefined
      ? portFail('NOT_FOUND', 'operation was not found')
      : portOk(toOperationSnapshot(record));
  }

  /** Starts a cancellable expected-composition read; returns immediately. */
  describe(environmentId: string): PortOutcome<OperationRef> {
    const environment = this.#environments.read(environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    if (stateIsBusy(environment.state)) {
      return portFail(
        'ENVIRONMENT_BUSY',
        'the expected composition can only be read while the environment is stopped',
      );
    }
    const generationId = environment.activeGenerationId;
    if (generationId === null) {
      return portFail('NOT_FOUND', 'the environment has no active generation to inspect');
    }
    const paths = generationPaths(this.#layout, environmentId, generationId);
    const profileName =
      readGenerationProfileName(this.#layout, environmentId, generationId) ??
      // Legacy generations were launched without `--profile` (the manager's
      // default `web`); their published profile is `home/profiles/web`.
      'web';
    const profileDirectory = join(
      environmentPaths(this.#layout, environmentId).profilesDirectory,
      profileName,
    );
    if (!existsSync(profileDirectory)) {
      return portFail('INTERNAL_ERROR', 'the active generation has no published profile to inspect');
    }
    const nodeExecutable = join(
      paths.nodeDirectory,
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    const dshEntrypoint = join(
      paths.dshDirectory,
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    );
    if (!existsSync(nodeExecutable) || !existsSync(dshEntrypoint)) {
      return portFail('INTERNAL_ERROR', 'the active generation has no complete managed runtime');
    }
    const meta = readProfileMeta(join(profileDirectory, 'package.json'));

    const operationId = newOperationId();
    const controller = new AbortController();
    this.#store.create({
      id: operationId,
      kind: 'composition',
      environmentId,
      phase: 'reading dump',
      status: 'running',
      createdAt: this.#now().toISOString(),
    });
    this.#controllers.set(operationId, controller);
    void this.#run(
      operationId,
      {
        environmentId,
        revision: environment.revision,
        generationId,
        profileName,
        meta,
        request: {
          nodeExecutable,
          dshEntrypoint,
          profileName,
          homeDirectory: paths.homeDirectory,
          cwd: paths.dataDirectory,
        },
      },
      controller.signal,
    );
    return portOk({ operationId });
  }

  cancelOperation(operationId: string): PortOutcome<OperationSnapshot> | undefined {
    if (!this.owns(operationId)) {
      return undefined;
    }
    const record = this.#store.read(operationId);
    if (record === undefined) {
      return portFail('NOT_FOUND', 'operation was not found');
    }
    if (isTerminalStatus(record.status)) {
      return portFail('CANNOT_CANCEL', 'operation already reached a final state');
    }
    this.#controllers.get(operationId)?.abort();
    this.#controllers.delete(operationId);
    const cancelled = this.#store.update(
      record,
      { status: 'cancelled', phase: 'cancelled' },
      this.#now().toISOString(),
    );
    return portOk(toOperationSnapshot(cancelled));
  }

  async #run(
    operationId: string,
    context: {
      readonly environmentId: string;
      readonly revision: number;
      readonly generationId: string;
      readonly profileName: string;
      readonly meta: ProfileMeta;
      readonly request: Parameters<ExpectedCompositionPort['describeExpectedComposition']>[0];
    },
    signal: AbortSignal,
  ): Promise<void> {
    let outcome: PortOutcome<ExpectedCompositionDumpResult>;
    try {
      outcome = await this.#port.describeExpectedComposition(context.request, signal);
    } catch {
      outcome = portFail('INTERNAL_ERROR', 'the expected-composition reader threw');
    }
    this.#controllers.delete(operationId);
    const record = this.#store.read(operationId);
    if (record === undefined || isTerminalStatus(record.status)) {
      return;
    }
    const now = this.#now().toISOString();
    if (!outcome.ok) {
      const error: ContractError = contractErrorForCode(
        outcome.code,
        outcome.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: outcome.retryAfterSeconds },
      );
      this.#store.update(record, { status: 'failed', phase: 'failed', error }, now);
      return;
    }
    const dump = outcome.value;
    const view: ExpectedCompositionView = {
      environmentId: context.environmentId,
      revision: context.revision,
      generationId: context.generationId,
      profileName: context.profileName,
      basis: 'dump-config',
      runtimeVerification: 'unavailable',
      bundles: context.meta.bundles,
      patchReload: context.meta.patchReload,
      groups: sanitizeGroups(dump.groups),
      rowCount: dump.rowCount,
      stdoutBytes: dump.stdoutBytes,
      stderr: sanitizeBoundedMessage(dump.stderr, EXPECTED_COMPOSITION_STDERR_MAX),
      exitCode: dump.exitCode,
      timedOut: dump.timedOut,
      diagnostics: sanitizeDiagnostics(dump.diagnostics),
      observedAt: dump.observedAt,
    };
    this.#store.update(record, { status: 'succeeded', phase: 'finished', output: view }, now);
  }
}

const sanitizeGroups = (
  groups: readonly ExpectedCompositionGroup[],
): ExpectedCompositionGroup[] =>
  groups.map((group) => ({
    label: sanitizeBoundedMessage(group.label, 256),
    rows: group.rows.map((row) =>
      row.config === undefined
        ? row
        : {
            ...row,
            config: {
              ...row.config,
              text: sanitizeBoundedMessage(row.config.text, EXPECTED_COMPOSITION_ROW_CONFIG_MAX),
            },
          },
    ),
  }));

const sanitizeDiagnostics = (
  diagnostics: readonly ExpectedCompositionDiagnostic[],
): ExpectedCompositionDiagnostic[] =>
  diagnostics.slice(0, EXPECTED_COMPOSITION_DIAGNOSTICS_MAX).map((diagnostic) => ({
    ...diagnostic,
    message: sanitizeBoundedMessage(diagnostic.message, 512),
  }));
