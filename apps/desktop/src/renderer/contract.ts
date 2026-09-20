/**
 * Renderer-side view of the shared contract.
 *
 * The renderer consumes the same `@hdsl/contracts` build as main; this module
 * records the shared version and the narrow client shape. It must not import
 * Node builtins, Electron, or the domain runtime packages. UI behavior is T006.
 */
import {
  API_VERSION,
  type ApiVersion,
  type ContractMethod,
  type ContractResponse,
} from '@hdsl/contracts';

export const RENDERER_CONTRACT_API_VERSION: ApiVersion = API_VERSION;

/**
 * The only surface the renderer may use to reach main. `call` takes a whitelisted
 * method and returns the versioned envelope; there is no direct IPC or channel
 * access, and `operations.openWebUI` returns only a loopback origin.
 */
export interface RendererContractClient {
  readonly apiVersion: ApiVersion;
  readonly methods: readonly ContractMethod[];
  call(method: ContractMethod, input: unknown): Promise<ContractResponse<unknown>>;
}
