/** Browser-only QA entry. Actual React UI/controller, explicit in-memory transport. */
import { FIXTURE_SEED } from '@hdsl/contracts/testing';
import { VERIFIED_COMBINATIONS } from '../../../packages/runtime/src/catalog/combinations.js';
import { renderRenderer } from '../../../apps/desktop/src/renderer/index.js';
import {
  createTestRendererClient,
  stubFail,
  stubOk,
  type RecordedCall,
} from './contract-client.js';

const scenario = new URLSearchParams(location.search).get('scenario');
const seed = {
  ...FIXTURE_SEED,
  catalog: VERIFIED_COMBINATIONS,
  environments:
    scenario === 'empty'
      ? []
      : [...FIXTURE_SEED.environments]
          .reverse()
          .map((entry, index) => ({
            ...entry,
            name:
              scenario === 'long' ? '长名称测试'.repeat(16) : index === 0 ? '研究环境' : '脚本环境',
          })),
};
const { client, calls } = createTestRendererClient(seed);
const originalCall = client.call.bind(client);
let loadFailed = false;
let snapshotFailed = false;
let cancelled = false;
client.call = async (method, input) => {
  if (method === 'environments.start') await new Promise((resolve) => setTimeout(resolve, 250));
  if (scenario === 'load-failure' && method === 'catalog.list' && !loadFailed) {
    loadFailed = true;
    calls.push({ method, input });
    return stubFail('INTERNAL_ERROR');
  }
  if (scenario === 'tracking' && method === 'operations.get' && !snapshotFailed) {
    snapshotFailed = true;
    calls.push({ method, input });
    return stubFail('INTERNAL_ERROR');
  }
  if (scenario === 'busy' && method === 'operations.cancel') {
    cancelled = true;
    calls.push({ method, input });
    return stubOk({
      id: (input as { operationId: string }).operationId,
      environmentId: 'env-stopped',
      kind: 'start',
      phase: 'cancelled',
      status: 'cancelled',
      sequence: 3,
    });
  }
  const result = await originalCall(method, input);
  if (method === 'operations.get' && result.ok && (scenario === 'busy' || scenario === 'failure')) {
    return stubOk({
      ...(result.value as object),
      sequence: cancelled ? 3 : 2,
      phase: cancelled ? 'cancelled' : 'starting',
      status: cancelled ? 'cancelled' : scenario === 'failure' ? 'failed' : 'running',
      ...(scenario === 'failure'
        ? {
            error: {
              code: 'START_TIMEOUT',
              message: 'the managed process did not become ready in time',
              retryable: true,
            },
          }
        : {}),
    });
  }
  return result;
};
// QA assertions inspect calls, never reach into React state or replace actions.
(window as unknown as { hdslTestCalls: RecordedCall[] }).hdslTestCalls = calls;
const root = document.getElementById('root');
if (root === null) throw new Error('Missing root');
renderRenderer(root, client, { demo: true, pollIntervalMs: 100 });
