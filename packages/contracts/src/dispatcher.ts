/**
 * The contract dispatcher: stateless validation first, then the state-aware
 * guards and idempotency bookkeeping, delegating real effects to the context
 * port.
 *
 * Ordering is deliberate and frozen:
 *   1. envelope shape (plain object, own known keys) → INVALID_INPUT
 *   2. `apiVersion` well-formedness                 → INVALID_INPUT
 *   3. exact `API_VERSION` match                    → CONTRACT_VERSION_MISMATCH
 *   4. method whitelist and strict method input      → INVALID_INPUT
 *   5. idempotency fingerprint / replay              → IDEMPOTENCY_CONFLICT
 *   6. resource, revision, platform guards           → NOT_FOUND / REVISION_CONFLICT / UNSUPPORTED_COMBINATION
 *   7. in-progress marker, port effect, DTO re-validation → domain codes / INTERNAL_ERROR
 *
 * No side effect can happen before step 3. Guard rejections write no ledger
 * entry, so corrected parameters can reuse the `requestId`. Executed calls are
 * recorded `in-progress` before the effect and `completed` after, so a replay
 * can never repeat an effect (security/semantic review F1). Every downstream
 * exception or malformed port result is mapped to a controlled, sanitized
 * `INTERNAL_ERROR` envelope instead of escaping `dispatch` (F2 / P1-2).
 */
import {
  contractError,
  contractErrorForCode,
  contractFail,
  contractOk,
  invalidInput,
  type ContractResponse,
  type ErrorCode,
} from './errors.js';
import { canonicalizeJson } from './digest.js';
import { SubscriptionRegistry } from './events.js';
import {
  METHOD_DEFINITIONS,
  validateMethodInput,
  isContractMethod,
  type ContractMethod,
  type MethodInputs,
} from './methods.js';
import { formatHostPlatform, isHostPlatformSupported, type HostPlatform } from './platform.js';
import { API_VERSION, isWellFormedApiVersion } from './version.js';
import type { ContractPort, StoredOutcome } from './context.js';
import {
  changePlanSchema,
  changeApplicationSchema,
  dshVersionListingSchema,
  expectedCompositionViewSchema,
  environmentSummaryListSchema,
  generationSummaryListSchema,
  installedPluginsViewSchema,
  generationSummarySchema,
  exportResultSchema,
  openWebUIResultSchema,
  operationRefSchema,
  operationSnapshotSchema,
  pluginInspectionSchema,
  pluginSearchResultSchema,
  runtimeCombinationListSchema,
  sanitizeOperationPhase,
  subscriptionRefSchema,
  type OperationKind,
  type OperationSnapshot,
  type RuntimeCombination,
  type SubscriptionRef,
} from './dto.js';
import { isPlainRecord, type Schema, type ValidationIssue } from './schema.js';

const ENVELOPE_KEYS: readonly string[] = ['apiVersion', 'method', 'input'];

/** `http(s)://127.0.0.1:<port>` or `[::1]`, with no token, query or fragment. */
export const LOOPBACK_ORIGIN_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]):(\d{1,5})$/;

/**
 * Valid loopback origin. The port must be canonical decimal 1–65535: `:0`,
 * `:65536`, `:99999` are out of range, and a leading zero (`:00080`) is a
 * non-canonical representation of `:80` and is rejected so one endpoint has one
 * textual form.
 */
export const isLoopbackOrigin = (value: string): boolean => {
  const match = LOOPBACK_ORIGIN_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const port = match[1];
  if (port === undefined || (port.length > 1 && port.startsWith('0'))) {
    return false;
  }
  const numeric = Number(port);
  return numeric >= 1 && numeric <= 65535;
};

interface Execution {
  readonly response: ContractResponse<unknown>;
  /** True only when the port (or registry) actually ran; guards stay false. */
  readonly executed: boolean;
}

export interface ContractRuntimeOptions {
  readonly port: ContractPort;
  readonly subscriptions?: SubscriptionRegistry;
}

export interface ContractRuntime {
  readonly port: ContractPort;
  readonly subscriptions: SubscriptionRegistry;
  dispatch(rawRequest: unknown): ContractResponse<unknown>;
}

interface PortFailureLike {
  readonly code: ErrorCode;
  readonly retryAfterSeconds?: number;
}

const failure = (code: ErrorCode, message: string): ContractResponse<never> =>
  contractFail(API_VERSION, contractError(code, message));

/** Controlled-message failure; downstream port text is never forwarded. */
const failureForCode = (
  code: ErrorCode,
  retryAfterSeconds?: number,
): ContractResponse<never> =>
  contractFail(
    API_VERSION,
    retryAfterSeconds === undefined
      ? contractErrorForCode(code)
      : contractErrorForCode(code, { retryAfterSeconds }),
  );

const guardFailure = (outcome: PortFailureLike): Execution => ({
  response: failureForCode(outcome.code, outcome.retryAfterSeconds),
  executed: false,
});

const executedFailure = (outcome: PortFailureLike): Execution => ({
  response: failureForCode(outcome.code, outcome.retryAfterSeconds),
  executed: true,
});

/**
 * A downstream port returned a value that does not match the shared schema.
 * It is a programming error in T004–T006, never surfaced verbatim.
 */
class ContractPortViolation extends Error {}

const validatePortValue = <T>(schema: Schema<T>, value: unknown, label: string): T => {
  const issues: ValidationIssue[] = [];
  const parsed = schema(value, label, issues);
  if (parsed === undefined) {
    throw new ContractPortViolation(`${label} returned an invalid DTO`);
  }
  return parsed;
};

/**
 * Terminal `output` schemas per operation kind (ADR 0005 D5). Only kinds with a
 * real payload are listed; every other kind must carry no `output`.
 */
const OPERATION_OUTPUT_SCHEMAS: Partial<Record<OperationKind, Schema<unknown>>> = {
  search: pluginSearchResultSchema,
  inspect: pluginInspectionSchema,
  preview: changePlanSchema,
  apply: changeApplicationSchema,
  restore: generationSummarySchema,
  versions: dshVersionListingSchema,
  composition: expectedCompositionViewSchema,
};

/**
 * Enforces the D5 `output` rule: a terminal succeeded payload kind must carry a
 * schema-valid `output`; queued/running/failed/cancelled and every kind without
 * a payload must not. A violation is a port contract breach → `INTERNAL_ERROR`.
 */
const assertOperationOutput = (snapshot: OperationSnapshot): OperationSnapshot => {
  const schema = OPERATION_OUTPUT_SCHEMAS[snapshot.kind];
  if (snapshot.status === 'succeeded' && schema !== undefined) {
    const output = validatePortValue(schema, snapshot.output, `${snapshot.kind}.output`);
    return { ...snapshot, output };
  }
  if (snapshot.output !== undefined) {
    throw new ContractPortViolation(
      `${snapshot.kind} must not carry output while ${snapshot.status}`,
    );
  }
  return snapshot;
};

/**
 * A port-produced snapshot is normalized before it can cross the bridge: the
 * free-text `phase` is sanitized and bounded to its own DTO postcondition
 * (matching the event path), a nested error's port message is replaced with the
 * controlled message for its code, and the terminal `output` rule is enforced.
 */
const sanitizeOperationSnapshot = (snapshot: OperationSnapshot): OperationSnapshot => {
  const phase = sanitizeOperationPhase(snapshot.phase);
  const normalized = phase === snapshot.phase ? snapshot : { ...snapshot, phase };
  const withError =
    normalized.error === undefined || normalized.error === null
      ? normalized
      : {
          ...normalized,
          error: { ...normalized.error, message: contractErrorForCode(normalized.error.code).message },
        };
  return assertOperationOutput(withError);
};

export const unsupportedCombinationReason = (
  host: HostPlatform,
  combination: RuntimeCombination,
): string | undefined => {
  if (!isHostPlatformSupported(host)) {
    return `host platform ${formatHostPlatform(host)} is not verified for this build`;
  }
  if (combination.compatibility.status !== 'verified') {
    return `catalog combination ${combination.id} is not verified`;
  }
  if (combination.platform !== host.platform || combination.arch !== host.arch) {
    return `catalog combination ${combination.id} targets ${combination.platform}/${combination.arch}, host is ${formatHostPlatform(host)}`;
  }
  return undefined;
};

const materialize = (outcome: StoredOutcome): ContractResponse<unknown> =>
  outcome.ok ? contractOk(API_VERSION, outcome.value) : contractFail(API_VERSION, outcome.error);

const toStoredOutcome = (response: ContractResponse<unknown>): StoredOutcome =>
  response.ok ? { ok: true, value: response.value } : { ok: false, error: response.error };

/**
 * A stored `operations.subscribe` result whose subscription has since been
 * removed cannot be replayed as a dead reference; the dispatcher reinstates the
 * same subscription id before returning the original ref.
 */
const isStaleSubscriptionReplay = (
  method: ContractMethod,
  outcome: StoredOutcome,
  runtime: ContractRuntime,
): boolean => {
  if (method !== 'operations.subscribe' || !outcome.ok) {
    return false;
  }
  const reference = outcome.value as SubscriptionRef | null;
  return reference === null || !runtime.subscriptions.has(reference.subscriptionId);
};

const publishIfKnown = (runtime: ContractRuntime, operationId: string): void => {
  const snapshot = runtime.port.findOperation(operationId);
  if (!snapshot.ok) {
    return;
  }
  const validated = validatePortValue(operationSnapshotSchema, snapshot.value, 'operation.updated');
  runtime.subscriptions.publish(sanitizeOperationSnapshot(validated));
};

const execute = (
  runtime: ContractRuntime,
  method: ContractMethod,
  input: MethodInputs[ContractMethod],
  markInProgress: () => void,
): Execution => {
  switch (method) {
    case 'catalog.list': {
      const outcome = runtime.port.listCatalog();
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const combinations = validatePortValue(runtimeCombinationListSchema, outcome.value, 'catalog.list');
      // local-api.md / data-model.md: unverified combinations never appear here.
      const verified = combinations.filter(
        (combination) => combination.compatibility.status === 'verified',
      );
      return { response: contractOk(API_VERSION, verified), executed: true };
    }
    case 'environments.list': {
      const outcome = runtime.port.listEnvironments();
      return outcome.ok
        ? {
            response: contractOk(
              API_VERSION,
              validatePortValue(environmentSummaryListSchema, outcome.value, 'environments.list'),
            ),
            executed: true,
          }
        : executedFailure(outcome);
    }
    case 'changes.preview': {
      const typed = input as MethodInputs['changes.preview'];
      const outcome = runtime.port.previewChange({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
        expectedRevision: typed.expectedRevision,
        action: typed.action,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      publishIfKnown(runtime, outcome.value.operationId);
      return { response: contractOk(API_VERSION, outcome.value), executed: true };
    }
    case 'changes.apply': {
      const typed = input as MethodInputs['changes.apply'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      if (environment.value.revision !== typed.expectedRevision) {
        return { response: failureForCode('REVISION_CONFLICT'), executed: false };
      }
      markInProgress();
      const outcome = runtime.port.applyChange({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
        expectedRevision: typed.expectedRevision,
        planId: typed.planId,
        buildAuthorization: typed.buildAuthorization ?? null,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      publishIfKnown(runtime, outcome.value.operationId);
      return { response: contractOk(API_VERSION, outcome.value), executed: true };
    }
    case 'generations.restore': {
      const typed = input as MethodInputs['generations.restore'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      if (environment.value.revision !== typed.expectedRevision) {
        return { response: failureForCode('REVISION_CONFLICT'), executed: false };
      }
      markInProgress();
      const outcome = runtime.port.restoreGeneration({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
        expectedRevision: typed.expectedRevision,
        targetGenerationId: typed.targetGenerationId,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      publishIfKnown(runtime, outcome.value.operationId);
      return { response: contractOk(API_VERSION, outcome.value), executed: true };
    }
    case 'plugins.installed': {
      // Read-only immediate query (ADR 0005 D4): no requestId, no in-progress
      // ledger write, and never ENVIRONMENT_BUSY for a running environment.
      const outcome = runtime.port.listInstalledPlugins(
        (input as MethodInputs['plugins.installed']).environmentId,
      );
      return outcome.ok
        ? {
            response: contractOk(
              API_VERSION,
              validatePortValue(installedPluginsViewSchema, outcome.value, 'plugins.installed'),
            ),
            executed: true,
          }
        : executedFailure(outcome);
    }
    case 'generations.list': {
      const outcome = runtime.port.listGenerations(
        (input as MethodInputs['generations.list']).environmentId,
      );
      return outcome.ok
        ? {
            response: contractOk(
              API_VERSION,
              validatePortValue(generationSummaryListSchema, outcome.value, 'generations.list'),
            ),
            executed: true,
          }
        : executedFailure(outcome);
    }
    case 'environments.create': {
      const typed = input as MethodInputs['environments.create'];
      const combination = runtime.port.findCombination(typed.catalogCombinationId);
      if (!combination.ok) {
        return guardFailure(combination);
      }
      const unsupported = unsupportedCombinationReason(runtime.port.host, combination.value);
      if (unsupported !== undefined) {
        return { response: failure('UNSUPPORTED_COMBINATION', unsupported), executed: false };
      }
      markInProgress();
      const created = runtime.port.createEnvironment({
        requestId: typed.requestId,
        name: typed.name,
        combination: combination.value,
      });
      if (!created.ok) {
        return executedFailure(created);
      }
      const reference = validatePortValue(operationRefSchema, created.value, 'environments.create');
      publishIfKnown(runtime, reference.operationId);
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
    case 'environments.start':
    case 'environments.stop': {
      const typed = input as MethodInputs['environments.start'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      if (environment.value.revision !== typed.expectedRevision) {
        return {
          response: failureForCode('REVISION_CONFLICT'),
          executed: false,
        };
      }
      const command = {
        requestId: typed.requestId,
        environmentId: typed.environmentId,
        expectedRevision: typed.expectedRevision,
      };
      markInProgress();
      const outcome =
        method === 'environments.start'
          ? runtime.port.startEnvironment(command)
          : runtime.port.stopEnvironment(command);
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const reference = validatePortValue(operationRefSchema, outcome.value, method);
      publishIfKnown(runtime, reference.operationId);
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
    case 'environments.switchCombination': {
      const typed = input as MethodInputs['environments.switchCombination'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      if (environment.value.revision !== typed.expectedRevision) {
        return { response: failureForCode('REVISION_CONFLICT'), executed: false };
      }
      const combination = runtime.port.findCombination(typed.catalogCombinationId);
      if (!combination.ok) {
        return guardFailure(combination);
      }
      const unsupported = unsupportedCombinationReason(runtime.port.host, combination.value);
      if (unsupported !== undefined) {
        return { response: failure('UNSUPPORTED_COMBINATION', unsupported), executed: false };
      }
      markInProgress();
      const outcome = runtime.port.switchCombination({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
        expectedRevision: typed.expectedRevision,
        combination: combination.value,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const reference = validatePortValue(
        operationRefSchema,
        outcome.value,
        'environments.switchCombination',
      );
      publishIfKnown(runtime, reference.operationId);
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
    case 'environments.openWebUI': {
      const typed = input as MethodInputs['environments.openWebUI'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      markInProgress();
      const outcome = runtime.port.openWebUI({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const result = validatePortValue(openWebUIResultSchema, outcome.value, 'environments.openWebUI');
      if (!isLoopbackOrigin(result.loopbackOrigin)) {
        return { response: failureForCode('WEBUI_UNAVAILABLE'), executed: true };
      }
      return { response: contractOk(API_VERSION, result), executed: true };
    }
    case 'operations.get': {
      const typed = input as MethodInputs['operations.get'];
      const outcome = runtime.port.findOperation(typed.operationId);
      if (!outcome.ok) {
        return guardFailure(outcome);
      }
      const snapshot = validatePortValue(operationSnapshotSchema, outcome.value, 'operations.get');
      return {
        response: contractOk(API_VERSION, sanitizeOperationSnapshot(snapshot)),
        executed: true,
      };
    }
    case 'operations.cancel': {
      const typed = input as MethodInputs['operations.cancel'];
      // Existence is a pure guard: an unknown operationId must not poison the
      // requestId, matching environments.start/stop (review F1-cancel).
      const existing = runtime.port.findOperation(typed.operationId);
      if (!existing.ok) {
        return guardFailure(existing);
      }
      markInProgress();
      const outcome = runtime.port.cancelOperation({
        requestId: typed.requestId,
        operationId: typed.operationId,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const snapshot = validatePortValue(operationSnapshotSchema, outcome.value, 'operations.cancel');
      const sanitized = sanitizeOperationSnapshot(snapshot);
      runtime.subscriptions.publish(sanitized);
      return { response: contractOk(API_VERSION, sanitized), executed: true };
    }
    case 'operations.subscribe': {
      const typed = input as MethodInputs['operations.subscribe'];
      const operationId = typed.operationId ?? null;
      if (operationId !== null) {
        const outcome = runtime.port.findOperation(operationId);
        if (!outcome.ok) {
          return guardFailure(outcome);
        }
      }
      markInProgress();
      const reference = validatePortValue(
        subscriptionRefSchema,
        runtime.subscriptions.subscribe(operationId),
        'operations.subscribe',
      );
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
    case 'operations.unsubscribe': {
      const typed = input as MethodInputs['operations.unsubscribe'];
      // T003 runs with owner=null, so has() and unsubscribe() agree. T006 must
      // pass the same trusted owner to both so a mismatched owner cannot report
      // a successful unsubscribe (see local-api.md).
      if (!runtime.subscriptions.has(typed.subscriptionId)) {
        return { response: failureForCode('NOT_FOUND'), executed: false };
      }
      markInProgress();
      runtime.subscriptions.unsubscribe(typed.subscriptionId);
      return { response: contractOk(API_VERSION, null), executed: true };
    }
    case 'diagnostics.export': {
      const typed = input as MethodInputs['diagnostics.export'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      markInProgress();
      const outcome = runtime.port.exportDiagnostics({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      return {
        response: contractOk(
          API_VERSION,
          validatePortValue(exportResultSchema, outcome.value, 'diagnostics.export'),
        ),
        executed: true,
      };
    }
    case 'plugins.search': {
      const typed = input as MethodInputs['plugins.search'];
      // Global, environment-independent: no resource guard can reject it and no
      // environment `ENVIRONMENT_BUSY` applies (ADR 0005 D5).
      markInProgress();
      const outcome = runtime.port.searchPlugins({
        requestId: typed.requestId,
        query: typed.query,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const reference = validatePortValue(operationRefSchema, outcome.value, 'plugins.search');
      publishIfKnown(runtime, reference.operationId);
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
    case 'plugins.inspect': {
      const typed = input as MethodInputs['plugins.inspect'];
      markInProgress();
      const outcome = runtime.port.inspectPluginSource({
        requestId: typed.requestId,
        source: typed.source,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const reference = validatePortValue(operationRefSchema, outcome.value, 'plugins.inspect');
      publishIfKnown(runtime, reference.operationId);
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
    case 'versions.dsh': {
      // Global, environment-independent read-only discovery (like plugins.search):
      // no resource guard can reject it and no environment `ENVIRONMENT_BUSY`
      // applies. The terminal `DshVersionListing` is read from `output`.
      const typed = input as MethodInputs['versions.dsh'];
      markInProgress();
      const outcome = runtime.port.listDshVersions({ requestId: typed.requestId });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const reference = validatePortValue(operationRefSchema, outcome.value, 'versions.dsh');
      publishIfKnown(runtime, reference.operationId);
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
    case 'compositions.expected': {
      // Environment-scoped read-only expected composition (#118). Existence is a
      // pure guard so an unknown environment cannot poison the requestId; the
      // port owns the busy/generation checks. The terminal
      // `ExpectedCompositionView` is read from `output`.
      const typed = input as MethodInputs['compositions.expected'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      markInProgress();
      const outcome = runtime.port.describeExpectedComposition({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      const reference = validatePortValue(
        operationRefSchema,
        outcome.value,
        'compositions.expected',
      );
      publishIfKnown(runtime, reference.operationId);
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
  }
};

interface ParsedCall {
  readonly method: ContractMethod;
  readonly input: MethodInputs[ContractMethod];
}

type ParsedEnvelope =
  | { readonly kind: 'call'; readonly call: ParsedCall }
  | { readonly kind: 'failure'; readonly response: ContractResponse<unknown> };

const parseEnvelope = (raw: unknown): ParsedEnvelope => {
  if (!isPlainRecord(raw)) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request must be a plain object with own fields'),
    };
  }
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_KEYS.includes(key)) {
      return {
        kind: 'failure',
        response: failure('INVALID_INPUT', `request.${key.slice(0, 64)}: unknown field`),
      };
    }
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'apiVersion')) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request.apiVersion: is required'),
    };
  }
  const apiVersion = raw['apiVersion'];
  if (typeof apiVersion !== 'string' || !isWellFormedApiVersion(apiVersion)) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request.apiVersion: must be a major.minor string'),
    };
  }
  if (apiVersion !== API_VERSION) {
    return {
      kind: 'failure',
      response: failure('CONTRACT_VERSION_MISMATCH', `request.apiVersion does not match ${API_VERSION}`),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'method')) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request.method: is required'),
    };
  }
  const method = raw['method'];
  if (!isContractMethod(method)) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request.method: must be a known contract method'),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'input')) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request.input: is required'),
    };
  }
  const issues: ValidationIssue[] = [];
  const input = validateMethodInput(method, raw['input'], issues);
  if (input === undefined) {
    return { kind: 'failure', response: contractFail(API_VERSION, invalidInput(issues)) };
  }
  return { kind: 'call', call: { method, input: input as MethodInputs[ContractMethod] } };
};

export const createContractRuntime = (options: ContractRuntimeOptions): ContractRuntime => {
  const runtime: ContractRuntime = {
    port: options.port,
    subscriptions: options.subscriptions ?? new SubscriptionRegistry(),
    dispatch(rawRequest: unknown): ContractResponse<unknown> {
      let parsed: ParsedEnvelope;
      try {
        parsed = parseEnvelope(rawRequest);
      } catch {
        return failureForCode('INTERNAL_ERROR');
      }
      if (parsed.kind === 'failure') {
        return parsed.response;
      }
      const { method, input } = parsed.call;
      const definition = METHOD_DEFINITIONS[method];

      try {
        const requestId = definition.idempotent
          ? (input as { readonly requestId: string }).requestId
          : undefined;
        const fingerprint = requestId === undefined ? undefined : canonicalizeJson(input);

        if (requestId !== undefined && fingerprint !== undefined) {
          const existing = runtime.port.readIdempotency(requestId);
          if (existing !== undefined) {
            if (existing.method !== method || existing.fingerprint !== fingerprint) {
              return failureForCode('IDEMPOTENCY_CONFLICT');
            }
            if (existing.state === 'in-progress') {
              // The previous attempt may have applied the effect; never redo it.
              return failureForCode('ENVIRONMENT_BUSY');
            }
            if (isStaleSubscriptionReplay(method, existing.outcome, runtime)) {
              const reference = existing.outcome.ok
                ? (existing.outcome.value as SubscriptionRef | null)
                : null;
              if (reference !== null) {
                const typed = input as MethodInputs['operations.subscribe'];
                runtime.subscriptions.reinstate(reference.subscriptionId, typed.operationId ?? null);
              }
            }
            return materialize(existing.outcome);
          }
        }

        const markInProgress = (): void => {
          if (requestId !== undefined && fingerprint !== undefined) {
            runtime.port.writeIdempotency(requestId, { state: 'in-progress', method, fingerprint });
          }
        };

        const result = execute(runtime, method, input, markInProgress);
        if (requestId !== undefined && fingerprint !== undefined && result.executed) {
          runtime.port.writeIdempotency(requestId, {
            state: 'completed',
            method,
            fingerprint,
            outcome: toStoredOutcome(result.response),
          });
        }
        return result.response;
      } catch {
        // The effect (if any) stays in-progress so a replay cannot duplicate it.
        return failureForCode('INTERNAL_ERROR');
      }
    },
  };
  return runtime;
};
