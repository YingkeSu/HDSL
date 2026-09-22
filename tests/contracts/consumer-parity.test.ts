/**
 * Consumer parity: main, preload and renderer all consume the single frozen
 * `@hdsl/contracts` build. A drifting version tag or a second method list
 * would fail here.
 */
import {
  API_VERSION,
  CONTRACT_METHODS,
  OPERATION_UPDATED_CHANNEL,
} from '@hdsl/contracts';
import { MAIN_CONTRACT_API_VERSION } from '../../apps/desktop/src/main/contract.js';
import {
  PRELOAD_CONTRACT_METHODS,
  PRELOAD_OPERATION_UPDATED_CHANNEL,
} from '../../apps/desktop/src/preload/index.js';
import { RENDERER_CONTRACT_API_VERSION } from '../../apps/desktop/src/renderer/contract.js';
import { describe, expect, it } from 'vitest';

describe('renderer/main/preload consume the same contract', () => {
  it('shares the exact same API version', () => {
    expect(MAIN_CONTRACT_API_VERSION).toBe(API_VERSION);
    expect(RENDERER_CONTRACT_API_VERSION).toBe(API_VERSION);
    expect(API_VERSION).toBe('1.1');
  });

  it('exposes exactly the frozen method whitelist through preload', () => {
    expect(PRELOAD_CONTRACT_METHODS).toBe(CONTRACT_METHODS);
    expect(CONTRACT_METHODS).toEqual([
      'catalog.list',
      'environments.list',
      'environments.create',
      'environments.start',
      'environments.stop',
      'environments.openWebUI',
      'operations.get',
      'operations.cancel',
      'operations.subscribe',
      'operations.unsubscribe',
      'diagnostics.export',
      'plugins.search',
      'plugins.inspect',
      'changes.preview',
      'generations.list',
    ]);
  });

  it('exposes a single fixed event channel', () => {
    expect(PRELOAD_OPERATION_UPDATED_CHANNEL).toBe(OPERATION_UPDATED_CHANNEL);
    expect(OPERATION_UPDATED_CHANNEL).toBe('operation.updated');
  });
});
