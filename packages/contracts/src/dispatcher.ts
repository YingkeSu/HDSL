/**
 * The contract dispatcher: stateless validation first, then the state-aware
 * guards and idempotency bookkeeping, delegating real effects to the context
 * port.
 *
 * Ordering is deliberate and frozen:
 *   1. envelope shape (object, known keys)        → INVALID_INPUT
 *   2. `apiVersion` well-formedness               → INVALID_INPUT
 *   3. exact `API_VERSION` match                  → CONTRACT_VERSION_MISMATCH
 *   4. method whitelist and strict method input    → INVALID_INPUT
 *   5. idempotency fingerprint / replay            → IDEMPOTENCY_CONFLICT
 *   6. resource, revision, platform guards         → NOT_FOUND / REVISION_CONFLICT / UNSUPPORTED_COMBINATION
 *   7. port effect and loopback re-check           → domain codes / WEBUI_UNAVAILABLE
 *
 * No side effect can happen before step 3, and a replayed request returns the
 * original result without calling the port again.
 */
import {
  contractError,
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
import type {
  ContractPort,
  StoredOutcome,
} from './context.js';
import type { RuntimeCombination } from './dto.js';
import type { ValidationIssue } from './schema.js';

const ENVELOPE_KEYS: readonly string[] = ['apiVersion', 'method', 'input'];

/** `http(s)://127.0.0.1:<port>` or `[::1]`, with no token, query or fragment. */
export const LOOPBACK_ORIGIN_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/;

export const isLoopbackOrigin = (value: string): boolean => LOOPBACK_ORIGIN_PATTERN.test(value);

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
  readonly message: string;
}

const failure = (code: ErrorCode, message: string): ContractResponse<never> =>
  contractFail(API_VERSION, contractError(code, message));

const guardFailure = (outcome: PortFailureLike): Execution => ({
  response: failure(outcome.code, outcome.message),
  executed: false,
});

const executedFailure = (outcome: PortFailureLike): Execution => ({
  response: failure(outcome.code, outcome.message),
  executed: true,
});

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

const publishIfKnown = (runtime: ContractRuntime, operationId: string): void => {
  const snapshot = runtime.port.findOperation(operationId);
  if (snapshot.ok) {
    runtime.subscriptions.publish(snapshot.value);
  }
};

const execute = (
  runtime: ContractRuntime,
  method: ContractMethod,
  input: MethodInputs[ContractMethod],
): Execution => {
  switch (method) {
    case 'catalog.list': {
      const outcome = runtime.port.listCatalog();
      return outcome.ok
        ? { response: contractOk(API_VERSION, outcome.value), executed: true }
        : executedFailure(outcome);
    }
    case 'environments.list': {
      const outcome = runtime.port.listEnvironments();
      return outcome.ok
        ? { response: contractOk(API_VERSION, outcome.value), executed: true }
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
      const created = runtime.port.createEnvironment({
        requestId: typed.requestId,
        name: typed.name,
        combination: combination.value,
      });
      if (!created.ok) {
        return executedFailure(created);
      }
      publishIfKnown(runtime, created.value.operationId);
      return { response: contractOk(API_VERSION, created.value), executed: true };
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
          response: failure('REVISION_CONFLICT', 'expectedRevision does not match the current composition revision'),
          executed: false,
        };
      }
      const command = {
        requestId: typed.requestId,
        environmentId: typed.environmentId,
        expectedRevision: typed.expectedRevision,
      };
      const outcome =
        method === 'environments.start'
          ? runtime.port.startEnvironment(command)
          : runtime.port.stopEnvironment(command);
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      publishIfKnown(runtime, outcome.value.operationId);
      return { response: contractOk(API_VERSION, outcome.value), executed: true };
    }
    case 'environments.openWebUI': {
      const typed = input as MethodInputs['environments.openWebUI'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      const outcome = runtime.port.openWebUI({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      if (!isLoopbackOrigin(outcome.value.loopbackOrigin)) {
        return {
          response: failure('WEBUI_UNAVAILABLE', 'managed endpoint is not a verified loopback origin'),
          executed: true,
        };
      }
      return { response: contractOk(API_VERSION, outcome.value), executed: true };
    }
    case 'operations.get': {
      const typed = input as MethodInputs['operations.get'];
      const outcome = runtime.port.findOperation(typed.operationId);
      return outcome.ok
        ? { response: contractOk(API_VERSION, outcome.value), executed: true }
        : guardFailure(outcome);
    }
    case 'operations.cancel': {
      const typed = input as MethodInputs['operations.cancel'];
      const outcome = runtime.port.cancelOperation({
        requestId: typed.requestId,
        operationId: typed.operationId,
      });
      if (!outcome.ok) {
        return executedFailure(outcome);
      }
      runtime.subscriptions.publish(outcome.value);
      return { response: contractOk(API_VERSION, outcome.value), executed: true };
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
      const reference = runtime.subscriptions.subscribe(operationId);
      return { response: contractOk(API_VERSION, reference), executed: true };
    }
    case 'operations.unsubscribe': {
      const typed = input as MethodInputs['operations.unsubscribe'];
      if (!runtime.subscriptions.unsubscribe(typed.subscriptionId)) {
        return { response: failure('NOT_FOUND', 'subscription was not found'), executed: false };
      }
      return { response: contractOk(API_VERSION, null), executed: true };
    }
    case 'diagnostics.export': {
      const typed = input as MethodInputs['diagnostics.export'];
      const environment = runtime.port.findEnvironment(typed.environmentId);
      if (!environment.ok) {
        return guardFailure(environment);
      }
      const outcome = runtime.port.exportDiagnostics({
        requestId: typed.requestId,
        environmentId: typed.environmentId,
      });
      return outcome.ok
        ? { response: contractOk(API_VERSION, outcome.value), executed: true }
        : executedFailure(outcome);
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
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request must be an object'),
    };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ENVELOPE_KEYS.includes(key)) {
      return {
        kind: 'failure',
        response: failure('INVALID_INPUT', `request.${key}: unknown field`),
      };
    }
  }
  const apiVersion = record['apiVersion'];
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
  const method = record['method'];
  if (!isContractMethod(method)) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request.method: must be a known contract method'),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'input')) {
    return {
      kind: 'failure',
      response: failure('INVALID_INPUT', 'request.input: is required'),
    };
  }
  const issues: ValidationIssue[] = [];
  const input = validateMethodInput(method, record['input'], issues);
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
      const parsed = parseEnvelope(rawRequest);
      if (parsed.kind === 'failure') {
        return parsed.response;
      }
      const { method, input } = parsed.call;
      const definition = METHOD_DEFINITIONS[method];

      let requestId: string | undefined;
      let fingerprint: string | undefined;
      if (definition.idempotent) {
        requestId = (input as { readonly requestId: string }).requestId;
        fingerprint = canonicalizeJson(input);
        const existing = runtime.port.readIdempotency(requestId);
        if (existing !== undefined) {
          if (existing.method !== method || existing.fingerprint !== fingerprint) {
            return failure('IDEMPOTENCY_CONFLICT', 'requestId was already used with different parameters');
          }
          if (existing.outcome !== undefined) {
            return materialize(existing.outcome);
          }
        } else {
          runtime.port.writeIdempotency(requestId, { method, fingerprint });
        }
      }

      const result = execute(runtime, method, input);
      if (requestId !== undefined && fingerprint !== undefined && result.executed) {
        runtime.port.writeIdempotency(requestId, {
          method,
          fingerprint,
          outcome: toStoredOutcome(result.response),
        });
      }
      return result.response;
    },
  };
  return runtime;
};
