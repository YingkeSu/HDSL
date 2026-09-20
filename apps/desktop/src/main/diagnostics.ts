/**
 * Diagnostic export whitelist and sanitizer (T006 / issue #6).
 *
 * The export is an explicit **allowlist**: only the fields selected here are
 * ever read and written. It never walks the environment home, never reads
 * `<env>/credentials.json`, never reads the environment `home/logs` or session
 * storage, and never copies a raw record. Each string is path-replaced,
 * value-redacted and passed through `sanitizeBoundedMessage` before it can be
 * serialized, so a secret or local path that reached a whitelisted field is
 * still removed.
 *
 * Rationale and exclusion rules: ADR 0002 (credential boundary) and
 * `docs/development/desktop-integration.md`. This module is intentionally free
 * of Electron and of any file-system read of secret-bearing locations.
 */
import type { EnvironmentSummary } from '@hdsl/contracts';
import { redactSecretValues, sanitizeBoundedMessage } from '@hdsl/contracts';
import type { InstallManifest, OperationRecord } from '@hdsl/core';

/** Maximum code points kept for one sanitized diagnostic string. */
export const DIAGNOSTIC_STRING_MAX_LENGTH = 2048;

export interface DiagnosticAppInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly electron?: string;
}

/** Only the launch facts that are already token-free; identity is reduced to a boolean. */
export interface DiagnosticLaunchSummary {
  readonly state: string;
  readonly loopbackOrigin: string | null;
  readonly identityRecorded: boolean;
  readonly exitCode: number | null;
  readonly errorCode: string | null;
}

export interface DiagnosticsInput {
  readonly generatedAt: string;
  readonly app: DiagnosticAppInfo;
  readonly environment: EnvironmentSummary;
  readonly manifest: InstallManifest | null;
  /** Parsed `composition.lock.json` of the active generation, or null. */
  readonly compositionLock: unknown;
  readonly operations: readonly OperationRecord[];
  readonly launch: DiagnosticLaunchSummary | null;
  /** Test-injected canary values that must never survive serialization. */
  readonly redactions?: readonly string[];
  /** Absolute roots replaced by stable placeholders before sanitizing. */
  readonly pathReplacements?: readonly { readonly from: string; readonly to: string }[];
}

export interface DiagnosticBundle {
  readonly schemaVersion: '1';
  readonly generatedAt: string;
  readonly app: DiagnosticAppInfo;
  readonly environment: {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
    readonly stateVersion: number;
    readonly state: string;
    readonly activeGenerationId: string | null;
    readonly compositionDigest: string | null;
  };
  readonly manifest: unknown;
  readonly compositionLock: unknown;
  readonly operations: readonly {
    readonly id: string;
    readonly kind: string;
    readonly phase: string;
    readonly status: string;
    readonly sequence: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly progress: number | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  }[];
  readonly launch: DiagnosticLaunchSummary | null;
}

const SECRETISH_KEY = /(secret|password|passwd|token|cookie|authorization|api[_-]?key)/i;

/**
 * Applies the fixed sanitizer to one string. Exported for focused tests; the
 * recursive walker below is the only production caller.
 */
export const sanitizeDiagnosticString = (
  value: string,
  context: Pick<DiagnosticsInput, 'redactions' | 'pathReplacements'>,
): string => {
  let result = value;
  for (const replacement of context.pathReplacements ?? []) {
    if (replacement.from.length > 0) {
      result = result.split(replacement.from).join(replacement.to);
    }
  }
  result = redactSecretValues(result, context.redactions ?? []);
  return sanitizeBoundedMessage(result, DIAGNOSTIC_STRING_MAX_LENGTH);
};

const sanitizeUnknown = (
  value: unknown,
  context: Pick<DiagnosticsInput, 'redactions' | 'pathReplacements'>,
  depth: number,
): unknown => {
  if (depth > 12) {
    return '<truncated>';
  }
  if (typeof value === 'string') {
    return sanitizeDiagnosticString(value, context);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 512).map((entry) => sanitizeUnknown(entry, context, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Defence in depth: a whitelisted source should not carry a secret key,
      // but if one appears it is dropped rather than exported.
      if (SECRETISH_KEY.test(key)) {
        continue;
      }
      output[key] = sanitizeUnknown(entry, context, depth + 1);
    }
    return output;
  }
  return '<unsupported>';
};

/**
 * Builds the exportable bundle. The environment summary is projected field by
 * field (never spread) so a future field cannot silently enter the export.
 */
export const buildDiagnostics = (input: DiagnosticsInput): DiagnosticBundle => {
  const environment = input.environment;
  const operations = input.operations.map((operation) => ({
    id: operation.id,
    kind: String(operation.kind),
    phase: sanitizeDiagnosticString(operation.phase, input),
    status: String(operation.status),
    sequence: operation.sequence,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    progress: operation.progress ?? null,
    errorCode: operation.error?.code ?? null,
    errorMessage:
      operation.error === undefined ? null : sanitizeDiagnosticString(operation.error.message, input),
  }));
  const launch =
    input.launch === null
      ? null
      : {
          state: sanitizeDiagnosticString(input.launch.state, input),
          loopbackOrigin:
            input.launch.loopbackOrigin === null
              ? null
              : sanitizeDiagnosticString(input.launch.loopbackOrigin, input),
          identityRecorded: input.launch.identityRecorded,
          exitCode: input.launch.exitCode,
          errorCode: input.launch.errorCode,
        };
  return {
    schemaVersion: '1',
    generatedAt: input.generatedAt,
    app: {
      name: input.app.name,
      version: input.app.version,
      platform: input.app.platform,
      arch: input.app.arch,
      node: input.app.node,
      ...(input.app.electron === undefined ? {} : { electron: input.app.electron }),
    },
    environment: {
      id: environment.id,
      name: environment.name,
      revision: environment.revision,
      stateVersion: environment.stateVersion,
      state: String(environment.state),
      activeGenerationId: environment.activeGenerationId,
      compositionDigest: environment.compositionDigest,
    },
    manifest: input.manifest === null ? null : sanitizeUnknown(input.manifest, input, 0),
    compositionLock:
      input.compositionLock === null ? null : sanitizeUnknown(input.compositionLock, input, 0),
    operations,
    launch,
  };
};

/** Serializes a bundle with the final sanitizer pass; the file content is this string. */
export const serializeDiagnostics = (
  bundle: DiagnosticBundle,
  context: Pick<DiagnosticsInput, 'redactions' | 'pathReplacements'> = {},
): string => `${JSON.stringify(sanitizeUnknown(bundle, context, 0), null, 2)}\n`;
