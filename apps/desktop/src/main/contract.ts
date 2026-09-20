/**
 * Main-process side of the frozen preload contract.
 *
 * T003 only proves that main and the renderer consume the same contract build.
 * The real use-case port (environments, operations, install, process) is wired
 * in T004–T006; this module deliberately holds no launcher behavior, no window
 * and no arbitrary IPC channel.
 */
import {
  API_VERSION,
  type ApiVersion,
  type ContractResponse,
  type ContractRuntime,
} from '@hdsl/contracts';

/** Exported so the renderer/preload build can assert it shares this version. */
export const MAIN_CONTRACT_API_VERSION: ApiVersion = API_VERSION;

/**
 * Single validated entry point a future IPC handler calls with the raw request
 * from the renderer. Validation and error mapping stay inside the contract.
 */
export const dispatchMainRequest = (
  runtime: ContractRuntime,
  request: unknown,
): ContractResponse<unknown> => runtime.dispatch(request);
