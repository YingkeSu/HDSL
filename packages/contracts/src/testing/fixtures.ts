/**
 * Machine-readable 「方法 × 合法/非法 fixture × 期望错误码」 table.
 *
 * The table is the single source of truth: `tests/contracts` iterates it and
 * asserts the dispatcher produces the recorded outcome, so the documentation
 * in `specs/001-environment-lifecycle/contracts/local-api.md` and the executable
 * behavior cannot drift. It runs against the TEST-ONLY in-memory port; durable
 * idempotency and real effects remain T004–T006 responsibilities.
 */
import { createContractRuntime, type ContractRuntime } from '../dispatcher.js';
import type { ContractResponse, ErrorCode } from '../errors.js';
import type { ContractMethod } from '../methods.js';
import type {
  EnvironmentSummary,
  OperationSnapshot,
  RuntimeArtifactRef,
  RuntimeCombination,
} from '../dto.js';
import type { Arch, Platform } from '../platform.js';
import { API_VERSION } from '../version.js';
import { ReferenceContractPort, type ReferenceSeed } from './reference-port.js';

const SHA_NODE = 'a'.repeat(64);
const SHA_DSH = 'b'.repeat(64);

export const FIXTURE_IDS = {
  host: { platform: 'darwin', arch: 'arm64' },
  combination: {
    verified: 'combo-darwin-arm64',
    win32: 'combo-win32-x64',
    unverified: 'combo-darwin-arm64-unverified',
  },
  environment: {
    running: 'env-running',
    stopped: 'env-stopped',
  },
  operation: {
    running: 'op-running',
    final: 'op-final',
  },
  subscription: {
    first: 'sub-1',
  },
} as const;

const artifactRef = (
  version: string,
  platform: Platform,
  arch: Arch,
  sha256: string,
): RuntimeArtifactRef => ({ version, platform, arch, sha256 });

const combination = (
  id: string,
  platform: Platform,
  arch: Arch,
  status: 'verified' | 'unverified',
): RuntimeCombination => ({
  id,
  platform,
  arch,
  node: artifactRef('24.21.0', platform, arch, SHA_NODE),
  dsh: artifactRef('0.1.5-rc.2', platform, arch, SHA_DSH),
  compatibility: { status, evidenceRef: 'docs/research/dsh-compatibility.md' },
  artifactLocations: {
    node: {
      version: '24.21.0',
      platform,
      arch,
      url: `https://example.invalid/node-${platform}-${arch}.tar.gz`,
      sha256: SHA_NODE,
    },
    dsh: {
      version: '0.1.5-rc.2',
      platform,
      arch,
      url: `https://example.invalid/dsh-${platform}-${arch}.tgz`,
      sha256: SHA_DSH,
    },
  },
});

const environment = (
  id: string,
  name: string,
  revision: number,
  stateVersion: number,
  state: EnvironmentSummary['state'],
): EnvironmentSummary => ({
  id,
  name,
  revision,
  stateVersion,
  state,
  activeGenerationId: `gen-${id}`,
  compositionDigest: SHA_NODE,
});

const operation = (
  id: string,
  environmentId: string,
  status: OperationSnapshot['status'],
  sequence: number,
): OperationSnapshot => ({
  id,
  environmentId,
  kind: 'start',
  phase: 'running',
  status,
  sequence,
});

export const FIXTURE_SEED: ReferenceSeed = {
  host: { platform: 'darwin', arch: 'arm64' },
  catalog: [
    combination(FIXTURE_IDS.combination.verified, 'darwin', 'arm64', 'verified'),
    // Fixture-only `verified`: exists to exercise the host/platform mismatch
    // path. Windows x64 has no T001 host evidence and this is NOT a support
    // claim (issue #21 review F7).
    combination(FIXTURE_IDS.combination.win32, 'win32', 'x64', 'verified'),
    combination(FIXTURE_IDS.combination.unverified, 'darwin', 'arm64', 'unverified'),
  ],
  environments: [
    environment(FIXTURE_IDS.environment.running, 'Running env', 3, 5, 'running'),
    environment(FIXTURE_IDS.environment.stopped, 'Stopped env', 1, 2, 'stopped'),
  ],
  operations: [
    operation(FIXTURE_IDS.operation.running, FIXTURE_IDS.environment.running, 'running', 2),
    operation(FIXTURE_IDS.operation.final, FIXTURE_IDS.environment.running, 'succeeded', 4),
  ],
  webUIEndpoints: { [FIXTURE_IDS.environment.running]: 'http://127.0.0.1:53123' },
};

const EXPORT_FAILURE_SEED: ReferenceSeed = { ...FIXTURE_SEED, failExport: true };
const TOKEN_URL_SEED: ReferenceSeed = {
  ...FIXTURE_SEED,
  webUIOriginOverride: 'http://127.0.0.1:53123/?token=canary-token',
};
const ZERO_PORT_SEED: ReferenceSeed = { ...FIXTURE_SEED, webUIOriginOverride: 'http://127.0.0.1:0' };
const TOO_HIGH_PORT_SEED: ReferenceSeed = {
  ...FIXTURE_SEED,
  webUIOriginOverride: 'http://127.0.0.1:65536',
};
const HUGE_PORT_SEED: ReferenceSeed = { ...FIXTURE_SEED, webUIOriginOverride: 'http://127.0.0.1:99999' };
const LEADING_ZERO_PORT_SEED: ReferenceSeed = {
  ...FIXTURE_SEED,
  webUIOriginOverride: 'http://127.0.0.1:00080',
};

export interface FixtureRuntime {
  readonly port: ReferenceContractPort;
  readonly runtime: ContractRuntime;
}

/** TEST/FIXTURE ONLY factory; see reference-port.ts. */
export const createReferenceRuntime = (seed: ReferenceSeed = FIXTURE_SEED): FixtureRuntime => {
  const port = new ReferenceContractPort(seed);
  return { port, runtime: createContractRuntime({ port }) };
};

export const contractRequest = (method: ContractMethod, input: unknown): unknown => ({
  apiVersion: API_VERSION,
  method,
  input,
});

export type FixtureExpectation = 'ok' | ErrorCode;

export interface ContractFixture {
  readonly id: string;
  /** `null` for envelope/version fixtures that are not scoped to one method. */
  readonly method: ContractMethod | null;
  readonly kind: 'legal' | 'illegal';
  readonly description: string;
  readonly request: unknown;
  readonly expected: FixtureExpectation;
  /** Requests dispatched (and ignored) before the measured request. */
  readonly prelude?: readonly unknown[];
  readonly seed?: ReferenceSeed;
}

const request = contractRequest;

export const ENVELOPE_FIXTURES: readonly ContractFixture[] = [
  {
    id: 'envelope-strict-ok',
    method: null,
    kind: 'legal',
    description: 'well-formed envelope with the frozen apiVersion',
    request: { apiVersion: API_VERSION, method: 'catalog.list', input: {} },
    expected: 'ok',
  },
  {
    id: 'envelope-major-mismatch',
    method: null,
    kind: 'illegal',
    description: 'major version mismatch is rejected',
    request: { apiVersion: '2.0', method: 'catalog.list', input: {} },
    expected: 'CONTRACT_VERSION_MISMATCH',
  },
  {
    id: 'envelope-minor-mismatch',
    method: null,
    kind: 'illegal',
    description: 'minor version mismatch is rejected (exact match only)',
    request: { apiVersion: '1.1', method: 'catalog.list', input: {} },
    expected: 'CONTRACT_VERSION_MISMATCH',
  },
  {
    id: 'envelope-malformed-version',
    method: null,
    kind: 'illegal',
    description: 'non major.minor apiVersion is structurally invalid',
    request: { apiVersion: '1', method: 'catalog.list', input: {} },
    expected: 'INVALID_INPUT',
  },
  {
    id: 'envelope-missing-version',
    method: null,
    kind: 'illegal',
    description: 'missing apiVersion',
    request: { method: 'catalog.list', input: {} },
    expected: 'INVALID_INPUT',
  },
  {
    id: 'envelope-non-string-version',
    method: null,
    kind: 'illegal',
    description: 'apiVersion must be a string',
    request: { apiVersion: 1, method: 'catalog.list', input: {} },
    expected: 'INVALID_INPUT',
  },
  {
    id: 'envelope-unknown-method',
    method: null,
    kind: 'illegal',
    description: 'method outside the frozen whitelist',
    request: { apiVersion: API_VERSION, method: 'envs.delete', input: {} },
    expected: 'INVALID_INPUT',
  },
  {
    id: 'envelope-unknown-key',
    method: null,
    kind: 'illegal',
    description: 'unknown envelope key',
    request: { apiVersion: API_VERSION, method: 'catalog.list', input: {}, extra: true },
    expected: 'INVALID_INPUT',
  },
  {
    id: 'envelope-missing-input',
    method: null,
    kind: 'illegal',
    description: 'input is required even for no-argument methods',
    request: { apiVersion: API_VERSION, method: 'catalog.list' },
    expected: 'INVALID_INPUT',
  },
  {
    id: 'envelope-not-an-object',
    method: null,
    kind: 'illegal',
    description: 'request must be an object',
    request: 'catalog.list',
    expected: 'INVALID_INPUT',
  },
  {
    id: 'envelope-input-not-object',
    method: null,
    kind: 'illegal',
    description: 'method input must be an object',
    request: { apiVersion: API_VERSION, method: 'catalog.list', input: [] },
    expected: 'INVALID_INPUT',
  },
];

export const CONTRACT_FIXTURES: readonly ContractFixture[] = [
  // catalog.list
  {
    id: 'catalog-list-legal',
    method: 'catalog.list',
    kind: 'legal',
    description: 'no-argument query',
    request: request('catalog.list', {}),
    expected: 'ok',
  },
  {
    id: 'catalog-list-unknown-field',
    method: 'catalog.list',
    kind: 'illegal',
    description: 'unknown field is rejected',
    request: request('catalog.list', { platform: 'darwin' }),
    expected: 'INVALID_INPUT',
  },

  // environments.list
  {
    id: 'environments-list-legal',
    method: 'environments.list',
    kind: 'legal',
    description: 'no-argument query',
    request: request('environments.list', {}),
    expected: 'ok',
  },
  {
    id: 'environments-list-unknown-field',
    method: 'environments.list',
    kind: 'illegal',
    description: 'unknown field is rejected',
    request: request('environments.list', { name: 'x' }),
    expected: 'INVALID_INPUT',
  },

  // environments.create
  {
    id: 'environments-create-legal',
    method: 'environments.create',
    kind: 'legal',
    description: 'verified combination on a verified host',
    request: request('environments.create', {
      requestId: 'req-create-1',
      name: 'Work env',
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    }),
    expected: 'ok',
  },
  {
    id: 'environments-create-name-too-long',
    method: 'environments.create',
    kind: 'illegal',
    description: 'name longer than 80 characters',
    request: request('environments.create', {
      requestId: 'req-create-2',
      name: 'x'.repeat(81),
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'environments-create-name-path',
    method: 'environments.create',
    kind: 'illegal',
    description: 'name must not be a path',
    request: request('environments.create', {
      requestId: 'req-create-3',
      name: 'a/b',
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'environments-create-illegal-id',
    method: 'environments.create',
    kind: 'illegal',
    description: 'catalogCombinationId is not an opaque id',
    request: request('environments.create', {
      requestId: 'req-create-4',
      name: 'Work env',
      catalogCombinationId: 'bad id',
    }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'environments-create-unknown-combination',
    method: 'environments.create',
    kind: 'illegal',
    description: 'unknown catalogCombinationId',
    request: request('environments.create', {
      requestId: 'req-create-5',
      name: 'Work env',
      catalogCombinationId: 'combo-missing',
    }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'environments-create-platform-mismatch',
    method: 'environments.create',
    kind: 'illegal',
    description: 'combination targets a different platform than the host',
    request: request('environments.create', {
      requestId: 'req-create-6',
      name: 'Work env',
      catalogCombinationId: FIXTURE_IDS.combination.win32,
    }),
    expected: 'UNSUPPORTED_COMBINATION',
  },
  {
    id: 'environments-create-unverified',
    method: 'environments.create',
    kind: 'illegal',
    description: 'unverified catalog combination',
    request: request('environments.create', {
      requestId: 'req-create-7',
      name: 'Work env',
      catalogCombinationId: FIXTURE_IDS.combination.unverified,
    }),
    expected: 'UNSUPPORTED_COMBINATION',
  },
  {
    id: 'environments-create-missing-request-id',
    method: 'environments.create',
    kind: 'illegal',
    description: 'requestId is required',
    request: request('environments.create', {
      name: 'Work env',
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'environments-create-unknown-field',
    method: 'environments.create',
    kind: 'illegal',
    description: 'unknown input field is rejected',
    request: request('environments.create', {
      requestId: 'req-create-8',
      name: 'Work env',
      catalogCombinationId: FIXTURE_IDS.combination.verified,
      platform: 'darwin',
    }),
    expected: 'INVALID_INPUT',
  },

  // environments.start
  {
    id: 'environments-start-legal',
    method: 'environments.start',
    kind: 'legal',
    description: 'stopped environment with the current revision',
    request: request('environments.start', {
      requestId: 'req-start-1',
      environmentId: FIXTURE_IDS.environment.stopped,
      expectedRevision: 1,
    }),
    expected: 'ok',
  },
  {
    id: 'environments-start-unknown',
    method: 'environments.start',
    kind: 'illegal',
    description: 'unknown environmentId',
    request: request('environments.start', {
      requestId: 'req-start-2',
      environmentId: 'env-missing',
      expectedRevision: 1,
    }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'environments-start-revision',
    method: 'environments.start',
    kind: 'illegal',
    description: 'expectedRevision does not match',
    request: request('environments.start', {
      requestId: 'req-start-3',
      environmentId: FIXTURE_IDS.environment.stopped,
      expectedRevision: 999,
    }),
    expected: 'REVISION_CONFLICT',
  },
  {
    id: 'environments-start-illegal-id',
    method: 'environments.start',
    kind: 'illegal',
    description: 'environmentId is not an opaque id',
    request: request('environments.start', {
      requestId: 'req-start-4',
      environmentId: 'bad id',
      expectedRevision: 1,
    }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'environments-start-missing-revision',
    method: 'environments.start',
    kind: 'illegal',
    description: 'expectedRevision is required',
    request: request('environments.start', {
      requestId: 'req-start-5',
      environmentId: FIXTURE_IDS.environment.stopped,
    }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'environments-start-negative-revision',
    method: 'environments.start',
    kind: 'illegal',
    description: 'expectedRevision must be non-negative',
    request: request('environments.start', {
      requestId: 'req-start-6',
      environmentId: FIXTURE_IDS.environment.stopped,
      expectedRevision: -1,
    }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'environments-start-busy',
    method: 'environments.start',
    kind: 'illegal',
    description: 'running environment is busy',
    request: request('environments.start', {
      requestId: 'req-start-7',
      environmentId: FIXTURE_IDS.environment.running,
      expectedRevision: 3,
    }),
    expected: 'ENVIRONMENT_BUSY',
  },

  // environments.stop
  {
    id: 'environments-stop-legal',
    method: 'environments.stop',
    kind: 'legal',
    description: 'running environment with the current revision',
    request: request('environments.stop', {
      requestId: 'req-stop-1',
      environmentId: FIXTURE_IDS.environment.running,
      expectedRevision: 3,
    }),
    expected: 'ok',
  },
  {
    id: 'environments-stop-unknown',
    method: 'environments.stop',
    kind: 'illegal',
    description: 'unknown environmentId',
    request: request('environments.stop', {
      requestId: 'req-stop-2',
      environmentId: 'env-missing',
      expectedRevision: 1,
    }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'environments-stop-revision',
    method: 'environments.stop',
    kind: 'illegal',
    description: 'expectedRevision does not match',
    request: request('environments.stop', {
      requestId: 'req-stop-3',
      environmentId: FIXTURE_IDS.environment.running,
      expectedRevision: 1,
    }),
    expected: 'REVISION_CONFLICT',
  },
  {
    id: 'environments-stop-not-running',
    method: 'environments.stop',
    kind: 'illegal',
    description: 'stopped environment cannot be stopped',
    request: request('environments.stop', {
      requestId: 'req-stop-4',
      environmentId: FIXTURE_IDS.environment.stopped,
      expectedRevision: 1,
    }),
    expected: 'ENVIRONMENT_BUSY',
  },

  // environments.openWebUI
  {
    id: 'environments-openwebui-legal',
    method: 'environments.openWebUI',
    kind: 'legal',
    description: 'running environment with a managed loopback origin',
    request: request('environments.openWebUI', {
      requestId: 'req-webui-1',
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'ok',
  },
  {
    id: 'environments-openwebui-unknown',
    method: 'environments.openWebUI',
    kind: 'illegal',
    description: 'unknown environmentId',
    request: request('environments.openWebUI', {
      requestId: 'req-webui-2',
      environmentId: 'env-missing',
    }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'environments-openwebui-stopped',
    method: 'environments.openWebUI',
    kind: 'illegal',
    description: 'environment is not running',
    request: request('environments.openWebUI', {
      requestId: 'req-webui-3',
      environmentId: FIXTURE_IDS.environment.stopped,
    }),
    expected: 'WEBUI_UNAVAILABLE',
  },
  {
    id: 'environments-openwebui-token-url',
    method: 'environments.openWebUI',
    kind: 'illegal',
    description: 'main rejects a token-bearing endpoint before it reaches the renderer',
    request: request('environments.openWebUI', {
      requestId: 'req-webui-4',
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'WEBUI_UNAVAILABLE',
    seed: TOKEN_URL_SEED,
  },
  {
    id: 'environments-openwebui-port-zero',
    method: 'environments.openWebUI',
    kind: 'illegal',
    description: 'port 0 is not a usable loopback endpoint',
    request: request('environments.openWebUI', {
      requestId: 'req-webui-port0',
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'WEBUI_UNAVAILABLE',
    seed: ZERO_PORT_SEED,
  },
  {
    id: 'environments-openwebui-port-too-high',
    method: 'environments.openWebUI',
    kind: 'illegal',
    description: 'port above 65535 is not a usable loopback endpoint',
    request: request('environments.openWebUI', {
      requestId: 'req-webui-porthigh',
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'WEBUI_UNAVAILABLE',
    seed: TOO_HIGH_PORT_SEED,
  },
  {
    id: 'environments-openwebui-port-huge',
    method: 'environments.openWebUI',
    kind: 'illegal',
    description: 'five-digit out-of-range port is not a usable loopback endpoint',
    request: request('environments.openWebUI', {
      requestId: 'req-webui-porthuge',
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'WEBUI_UNAVAILABLE',
    seed: HUGE_PORT_SEED,
  },
  {
    id: 'environments-openwebui-port-leading-zero',
    method: 'environments.openWebUI',
    kind: 'illegal',
    description: 'leading-zero port is rejected',
    request: request('environments.openWebUI', {
      requestId: 'req-webui-portzero',
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'WEBUI_UNAVAILABLE',
    seed: LEADING_ZERO_PORT_SEED,
  },
  {
    id: 'environments-openwebui-missing-id',
    method: 'environments.openWebUI',
    kind: 'illegal',
    description: 'environmentId is required',
    request: request('environments.openWebUI', { requestId: 'req-webui-5' }),
    expected: 'INVALID_INPUT',
  },

  // operations.get
  {
    id: 'operations-get-legal',
    method: 'operations.get',
    kind: 'legal',
    description: 'query an existing operation',
    request: request('operations.get', { operationId: FIXTURE_IDS.operation.running }),
    expected: 'ok',
  },
  {
    id: 'operations-get-unknown',
    method: 'operations.get',
    kind: 'illegal',
    description: 'unknown operationId',
    request: request('operations.get', { operationId: 'op-missing' }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'operations-get-illegal-id',
    method: 'operations.get',
    kind: 'illegal',
    description: 'operationId is not an opaque id',
    request: request('operations.get', { operationId: 'bad id' }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'operations-get-unknown-field',
    method: 'operations.get',
    kind: 'illegal',
    description: 'unknown field is rejected',
    request: request('operations.get', {
      operationId: FIXTURE_IDS.operation.running,
      name: 'x',
    }),
    expected: 'INVALID_INPUT',
  },

  // operations.cancel
  {
    id: 'operations-cancel-legal',
    method: 'operations.cancel',
    kind: 'legal',
    description: 'cancel a running operation',
    request: request('operations.cancel', {
      requestId: 'req-cancel-1',
      operationId: FIXTURE_IDS.operation.running,
    }),
    expected: 'ok',
  },
  {
    id: 'operations-cancel-unknown',
    method: 'operations.cancel',
    kind: 'illegal',
    description: 'unknown operationId',
    request: request('operations.cancel', {
      requestId: 'req-cancel-2',
      operationId: 'op-missing',
    }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'operations-cancel-final',
    method: 'operations.cancel',
    kind: 'illegal',
    description: 'final operation cannot be cancelled',
    request: request('operations.cancel', {
      requestId: 'req-cancel-3',
      operationId: FIXTURE_IDS.operation.final,
    }),
    expected: 'CANNOT_CANCEL',
  },
  {
    id: 'operations-cancel-missing-request-id',
    method: 'operations.cancel',
    kind: 'illegal',
    description: 'requestId is required',
    request: request('operations.cancel', { operationId: FIXTURE_IDS.operation.running }),
    expected: 'INVALID_INPUT',
  },

  // operations.subscribe
  {
    id: 'operations-subscribe-legal-operation',
    method: 'operations.subscribe',
    kind: 'legal',
    description: 'subscribe to one operation',
    request: request('operations.subscribe', {
      requestId: 'req-sub-1',
      operationId: FIXTURE_IDS.operation.running,
    }),
    expected: 'ok',
  },
  {
    id: 'operations-subscribe-legal-all',
    method: 'operations.subscribe',
    kind: 'legal',
    description: 'subscribe to all operations (operationId omitted)',
    request: request('operations.subscribe', { requestId: 'req-sub-2' }),
    expected: 'ok',
  },
  {
    id: 'operations-subscribe-unknown',
    method: 'operations.subscribe',
    kind: 'illegal',
    description: 'unknown operationId',
    request: request('operations.subscribe', {
      requestId: 'req-sub-3',
      operationId: 'op-missing',
    }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'operations-subscribe-illegal-id',
    method: 'operations.subscribe',
    kind: 'illegal',
    description: 'operationId is not an opaque id',
    request: request('operations.subscribe', {
      requestId: 'req-sub-4',
      operationId: 'bad id',
    }),
    expected: 'INVALID_INPUT',
  },
  {
    id: 'operations-subscribe-unknown-field',
    method: 'operations.subscribe',
    kind: 'illegal',
    description: 'unknown field is rejected',
    request: request('operations.subscribe', {
      requestId: 'req-sub-5',
      channel: 'operation.updated',
    }),
    expected: 'INVALID_INPUT',
  },

  // operations.unsubscribe
  {
    id: 'operations-unsubscribe-legal',
    method: 'operations.unsubscribe',
    kind: 'legal',
    description: 'unsubscribe from an established subscription',
    request: request('operations.unsubscribe', {
      requestId: 'req-unsub-1',
      subscriptionId: FIXTURE_IDS.subscription.first,
    }),
    expected: 'ok',
    prelude: [request('operations.subscribe', { requestId: 'req-sub-prelude' })],
  },
  {
    id: 'operations-unsubscribe-unknown',
    method: 'operations.unsubscribe',
    kind: 'illegal',
    description: 'unknown subscriptionId',
    request: request('operations.unsubscribe', {
      requestId: 'req-unsub-2',
      subscriptionId: 'sub-999',
    }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'operations-unsubscribe-illegal-id',
    method: 'operations.unsubscribe',
    kind: 'illegal',
    description: 'subscriptionId is not an opaque id',
    request: request('operations.unsubscribe', {
      requestId: 'req-unsub-3',
      subscriptionId: 'bad id',
    }),
    expected: 'INVALID_INPUT',
  },

  // diagnostics.export
  {
    id: 'diagnostics-export-legal',
    method: 'diagnostics.export',
    kind: 'legal',
    description: 'export redacted diagnostics for an existing environment',
    request: request('diagnostics.export', {
      requestId: 'req-export-1',
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'ok',
  },
  {
    id: 'diagnostics-export-unknown',
    method: 'diagnostics.export',
    kind: 'illegal',
    description: 'unknown environmentId',
    request: request('diagnostics.export', {
      requestId: 'req-export-2',
      environmentId: 'env-missing',
    }),
    expected: 'NOT_FOUND',
  },
  {
    id: 'diagnostics-export-failed',
    method: 'diagnostics.export',
    kind: 'illegal',
    description: 'export failure is a terminal error, not a partial success',
    request: request('diagnostics.export', {
      requestId: 'req-export-3',
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'EXPORT_FAILED',
    seed: EXPORT_FAILURE_SEED,
  },
  {
    id: 'diagnostics-export-missing-request-id',
    method: 'diagnostics.export',
    kind: 'illegal',
    description: 'requestId is required',
    request: request('diagnostics.export', {
      environmentId: FIXTURE_IDS.environment.running,
    }),
    expected: 'INVALID_INPUT',
  },

  // idempotency conflict
  {
    id: 'idempotency-conflict',
    method: 'environments.create',
    kind: 'illegal',
    description: 'same requestId with different parameters after a committed call',
    request: request('environments.create', {
      requestId: 'req-idem-1',
      name: 'Second name',
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    }),
    expected: 'IDEMPOTENCY_CONFLICT',
    prelude: [
      request('environments.create', {
        requestId: 'req-idem-1',
        name: 'First name',
        catalogCombinationId: FIXTURE_IDS.combination.verified,
      }),
    ],
  },
  {
    id: 'idempotency-guard-retry',
    method: 'environments.create',
    kind: 'legal',
    description: 'a pure guard rejection does not persist the fingerprint, so corrected parameters retry',
    request: request('environments.create', {
      requestId: 'req-guard-retry',
      name: 'Env',
      catalogCombinationId: FIXTURE_IDS.combination.verified,
    }),
    expected: 'ok',
    prelude: [
      request('environments.create', {
        requestId: 'req-guard-retry',
        name: 'Env',
        catalogCombinationId: 'combo-missing',
      }),
    ],
  },
];

export const ALL_CONTRACT_FIXTURES: readonly ContractFixture[] = [
  ...ENVELOPE_FIXTURES,
  ...CONTRACT_FIXTURES,
];

export interface FixtureObservation {
  readonly fixture: ContractFixture;
  readonly outcome: FixtureExpectation;
  readonly response: ContractResponse<unknown>;
}

/** Dispatches the fixture against a fresh TEST-ONLY runtime. */
export const evaluateContractFixture = (fixture: ContractFixture): FixtureObservation => {
  const { runtime } = createReferenceRuntime(fixture.seed ?? FIXTURE_SEED);
  for (const preludeRequest of fixture.prelude ?? []) {
    runtime.dispatch(preludeRequest);
  }
  const response = runtime.dispatch(fixture.request);
  return { fixture, outcome: response.ok ? 'ok' : response.error.code, response };
};
