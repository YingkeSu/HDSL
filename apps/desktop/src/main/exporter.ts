/**
 * Native diagnostic export (T006 / issue #6).
 *
 * `diagnostics.export` is a **synchronous** frozen method, so main chooses the
 * target with a synchronous native save dialog, writes a whitelist bundle with
 * `0600` permissions, and returns only `{ exportId, exported, redacted }`. The
 * chosen path is never returned, logged or stored; a cancelled dialog is
 * `EXPORT_FAILED`. The dispatcher's idempotency ledger guarantees a replayed
 * `requestId` returns the original summary and does not write a second file.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  portFail,
  portOk,
  type ErrorCode,
  type ExportResult,
  type PortOutcome,
} from '@hdsl/contracts';
import type { AppDataLayout, DiagnosticsExporter, EnvironmentService, OperationStore } from '@hdsl/core';
import { generationPaths, tryReadJsonFile } from '@hdsl/core';
import {
  buildDiagnostics,
  serializeDiagnostics,
  type DiagnosticAppInfo,
  type DiagnosticLaunchSummary,
  type DiagnosticsInput,
} from './diagnostics.js';

/** Synchronous native path chooser; returns null when the user cancels. */
export interface DiagnosticsPathChooser {
  chooseExportPath(defaultFileName: string): string | null;
}

export interface DiagnosticsLaunchRecord {
  readonly state: string;
  readonly endpointOrigin: string | null;
  readonly identityRecorded: boolean;
  readonly exitCode: number | null;
  readonly errorCode: ErrorCode | null;
}

export interface CreateDiagnosticsExporterOptions {
  readonly service: EnvironmentService;
  readonly layout: AppDataLayout;
  readonly operations: OperationStore;
  readonly readLaunchRecord: (environmentId: string) => DiagnosticsLaunchRecord | null;
  readonly app: DiagnosticAppInfo;
  readonly pathChooser: DiagnosticsPathChooser;
  readonly clock?: () => Date;
  /** Test-injected canary values that must never survive serialization. */
  readonly redactions?: readonly string[];
  /** Swappable file sink (tests); defaults to a `0600` atomic write. */
  readonly writeFile?: (targetPath: string, content: string) => void;
}

const defaultWriteFile = (targetPath: string, content: string): void => {
  mkdirSync(dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.hdsl-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, targetPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

const defaultFileName = (environmentName: string, now: Date): string => {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const safeName = environmentName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
  return `hdsl-diagnostics-${safeName}-${stamp}.json`;
};

const launchSummary = (record: DiagnosticsLaunchRecord | null): DiagnosticLaunchSummary | null =>
  record === null
    ? null
    : {
        state: record.state,
        loopbackOrigin: record.endpointOrigin,
        identityRecorded: record.identityRecorded,
        exitCode: record.exitCode,
        errorCode: record.errorCode,
      };

/**
 * Reads only the whitelisted sources for one environment. It never touches the
 * environment home, `home/logs`, stored sessions or `<env>/credentials.json`.
 */
export const collectDiagnosticsInput = (
  options: Pick<
    CreateDiagnosticsExporterOptions,
    'service' | 'layout' | 'operations' | 'readLaunchRecord' | 'app' | 'clock' | 'redactions'
  >,
  environmentId: string,
  now: Date,
): DiagnosticsInput | null => {
  const environment = options.service.findEnvironment(environmentId);
  if (!environment.ok) {
    return null;
  }
  const manifestOutcome = options.service.tryReadInstallManifest(environmentId);
  const manifest = manifestOutcome.ok ? manifestOutcome.value : null;
  const activeGenerationId = environment.value.activeGenerationId;
  const paths =
    activeGenerationId === null ? null : generationPaths(options.layout, environmentId, activeGenerationId);
  const compositionLock =
    paths === null ? null : tryReadJsonFile<unknown>(paths.lockPath) ?? null;
  const operations = options.operations
    .list()
    .filter((operation) => operation.environmentId === environmentId);
  return {
    generatedAt: now.toISOString(),
    app: options.app,
    environment: environment.value,
    manifest,
    compositionLock,
    operations,
    launch: launchSummary(options.readLaunchRecord(environmentId)),
    ...(options.redactions === undefined ? {} : { redactions: options.redactions }),
    pathReplacements: [
      ...(paths === null
        ? []
        : [
            { from: paths.homeDirectory, to: '<generation-home>' },
            { from: paths.generationDirectory, to: '<generation>' },
          ]),
      { from: options.layout.root, to: '<data-root>' },
    ],
  };
};

export const createDiagnosticsExporter = (
  options: CreateDiagnosticsExporterOptions,
): DiagnosticsExporter => {
  const write = options.writeFile ?? defaultWriteFile;
  return (environmentId: string): PortOutcome<ExportResult> => {
    const environment = options.service.findEnvironment(environmentId);
    if (!environment.ok) {
      return portFail('NOT_FOUND', 'the environment was not found');
    }
    const now = (options.clock ?? (() => new Date()))();
    const target = options.pathChooser.chooseExportPath(
      defaultFileName(environment.value.name, now),
    );
    if (target === null) {
      return portFail('EXPORT_FAILED', 'the diagnostic export was cancelled');
    }
    const input = collectDiagnosticsInput(options, environmentId, now);
    if (input === null) {
      return portFail('NOT_FOUND', 'the environment was not found');
    }
    const content = serializeDiagnostics(buildDiagnostics(input), {
      ...(options.redactions === undefined ? {} : { redactions: options.redactions }),
      ...(input.pathReplacements === undefined
        ? {}
        : { pathReplacements: input.pathReplacements }),
    });
    try {
      write(target, content);
    } catch {
      return portFail('EXPORT_FAILED', 'the diagnostic export could not be written');
    }
    return portOk({
      exportId: `exp-${randomUUID()}`,
      exported: true,
      redacted: true,
    });
  };
};

/** Convenience for tests and the menu: the default file-name helper. */
export const diagnosticsDefaultFileName = defaultFileName;
