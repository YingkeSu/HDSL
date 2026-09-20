/**
 * Test support for the T006a renderer slice.
 *
 * Runs the renderer against the frozen contract by binding a
 * `RendererContractClient` to the TEST-ONLY reference runtime
 * (`@hdsl/contracts/testing`). This is a test double: it proves renderer
 * semantics, never real DSH/Electron behavior, and it lives outside the
 * renderer source so the production entry cannot import it.
 */
import {
  API_VERSION,
  CONTRACT_METHODS,
  type ContractMethod,
  type ContractResponse,
  type ErrorCode,
} from '@hdsl/contracts';
import {
  createReferenceRuntime,
  type ReferenceContractPort,
  type ReferenceSeed,
} from '@hdsl/contracts/testing';
import type { RendererContractClient } from '../../../apps/desktop/src/renderer/contract.js';

export interface RecordedCall {
  readonly method: ContractMethod;
  readonly input: unknown;
}

export interface TestRendererClient {
  readonly client: RendererContractClient;
  readonly port: ReferenceContractPort;
  readonly calls: RecordedCall[];
}

/** A recording restricted client backed by the in-memory reference port. */
export const createTestRendererClient = (seed?: ReferenceSeed): TestRendererClient => {
  const { port, runtime } = createReferenceRuntime(seed);
  const calls: RecordedCall[] = [];
  const client: RendererContractClient = {
    apiVersion: API_VERSION,
    methods: CONTRACT_METHODS,
    call(method: ContractMethod, input: unknown): Promise<ContractResponse<unknown>> {
      calls.push({ method, input });
      return Promise.resolve(runtime.dispatch({ apiVersion: API_VERSION, method, input }));
    },
  };
  return { client, port, calls };
};

/**
 * A stub restricted client for cases the reference port cannot produce
 * (non-terminal operations, transport failures, version mismatches).
 */
export interface StubRendererClient {
  readonly client: RendererContractClient;
  readonly calls: RecordedCall[];
}

export const createStubRendererClient = (
  respond: (method: ContractMethod, input: unknown) => unknown,
): StubRendererClient => {
  const calls: RecordedCall[] = [];
  const client: RendererContractClient = {
    apiVersion: API_VERSION,
    methods: CONTRACT_METHODS,
    call(method: ContractMethod, input: unknown): Promise<ContractResponse<unknown>> {
      calls.push({ method, input });
      return Promise.resolve(respond(method, input) as ContractResponse<unknown>);
    },
  };
  return { client, calls };
};

/** Contract-shaped success envelope for stub responses. */
export const stubOk = (value: unknown): ContractResponse<unknown> => ({
  ok: true,
  apiVersion: API_VERSION,
  value,
});

/** Contract-shaped failure envelope for stub responses. */
export const stubFail = (
  code: ErrorCode,
  message = 'stubbed failure',
  retryable = false,
): ContractResponse<unknown> => ({
  ok: false,
  apiVersion: API_VERSION,
  error: { code, message, retryable },
});
