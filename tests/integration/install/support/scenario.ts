/**
 * Black-box scenario helpers over the public `@hdsl/contracts` surface.
 *
 * These helpers only use `createContractRuntime(...).dispatch(...)`; they never
 * import a T004–T006 internal module. The eventual install scenarios therefore
 * exercise exactly what a preload/main consumer sees.
 */
import {
  API_VERSION,
  createContractRuntime,
  type ContractError,
  type ContractPort,
  type ContractResponse,
  type EnvironmentSummary,
  type OperationSnapshot,
} from '@hdsl/contracts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { sleep } from './temp-env.js';

export interface InstallRuntime {
  readonly port: ContractPort;
  readonly runtime: ReturnType<typeof createContractRuntime>;
}

export const makeRuntime = (port: ContractPort): InstallRuntime => ({
  port,
  runtime: createContractRuntime({ port }),
});

export const call = (
  runtime: InstallRuntime,
  method: string,
  input: unknown,
): ContractResponse<unknown> =>
  runtime.runtime.dispatch({ apiVersion: API_VERSION, method, input });

export const requireOk = <T>(response: ContractResponse<T>, context: string): T => {
  if (response.ok) {
    return response.value;
  }
  throw new Error(
    `${context}: expected ok, received ${response.error.code}: ${response.error.message}`,
  );
};

export const requireError = (response: ContractResponse<unknown>, context: string): ContractError => {
  if (!response.ok) {
    return response.error;
  }
  throw new Error(`${context}: expected an error envelope, received ok`);
};

export interface PollOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly label?: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Polls `operations.get` until terminal; never waits forever (SC-003). */
export const pollTerminalOperation = async (
  runtime: InstallRuntime,
  operationId: string,
  options: PollOptions = {},
): Promise<OperationSnapshot> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 50;
  const label = options.label ?? `operation ${operationId}`;
  const deadline = Date.now() + timeoutMs;
  let last: OperationSnapshot | undefined;
  for (;;) {
    const snapshot = requireOk(
      call(runtime, 'operations.get', { operationId }),
      `operations.get(${operationId})`,
    ) as OperationSnapshot;
    last = snapshot;
    if (TERMINAL.has(snapshot.status)) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `${label} did not reach a terminal state within ${timeoutMs}ms; last status=${last?.status ?? 'none'} phase=${last?.phase ?? 'none'}`,
  );
};

/** Polls `environments.list` until `predicate` holds; bounded. */
export const pollEnvironment = async (
  runtime: InstallRuntime,
  environmentId: string,
  predicate: (environment: EnvironmentSummary) => boolean,
  options: PollOptions = {},
): Promise<EnvironmentSummary> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: EnvironmentSummary | undefined;
  for (;;) {
    const environments = requireOk(
      call(runtime, 'environments.list', {}),
      'environments.list',
    ) as readonly EnvironmentSummary[];
    const match = environments.find((environment) => environment.id === environmentId);
    if (match !== undefined) {
      last = match;
      if (predicate(match)) {
        return match;
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `environment ${environmentId} did not reach the expected state within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
};

/**
 * Waits until a transaction journal reaches `phase`. Used to make the
 * "crashed after artifacts installed, before commit" restart boundary
 * deterministic instead of relying on a fixed sleep; calling `close()` while
 * the install is still in flight aborts and cleans the journal.
 */
export const waitForJournalPhase = async (
  dataRoot: string,
  phase: string,
  timeoutMs = 15_000,
): Promise<void> => {
  const directory = join(dataRoot, 'transactions');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let names: string[] = [];
    try {
      names = readdirSync(directory).filter((name) => name.endsWith('.json'));
    } catch {
      names = [];
    }
    for (const name of names) {
      try {
        const record = JSON.parse(readFileSync(join(directory, name), 'utf8')) as {
          readonly phase?: string;
        };
        if (record.phase === phase) {
          return;
        }
      } catch {
        // A concurrent atomic write can race the read; retry.
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`no transaction journal reached phase ${phase} within ${timeoutMs}ms`);
    }
    await sleep(25);
  }
};

/** Asserts no absolute fixture path leaked through a contract response. */
export const findLeakedPaths = (payload: unknown, forbidden: readonly string[]): string[] => {
  const text = JSON.stringify(payload) ?? '';
  return forbidden.filter((path) => path.length > 0 && text.includes(path));
};

/** Recursively lists files under `root` (missing root yields an empty list). */
export const walkFiles = (root: string): string[] => {
  const found: string[] = [];
  const visit = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (stats === undefined) {
        continue;
      }
      if (stats.isDirectory()) {
        visit(full);
      } else if (stats.isFile()) {
        found.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return found;
};
