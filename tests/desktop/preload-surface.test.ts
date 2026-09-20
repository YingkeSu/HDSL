/**
 * Preload surface pinning (T006 / issue #6).
 *
 * The runtime preload is a sandboxed CommonJS file that cannot import the ESM
 * channel module. This test statically pins its channel literals and exposed
 * members to the shared constants so the two cannot drift, and asserts the
 * surface carries no token/cookie handling.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HDSL_CONTRACT_CHANNEL,
  HDSL_OPERATION_UPDATED_CHANNEL,
  HDSL_SELECTION_CHANNEL,
} from '../../apps/desktop/src/ipc-channels.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf8');

describe('sandboxed preload bridge', () => {
  const bridge = source('apps/desktop/src/preload/bridge.cts');

  it('uses the shared channel names', () => {
    expect(bridge).toContain(`'${HDSL_CONTRACT_CHANNEL}'`);
    expect(bridge).toContain(`'${HDSL_SELECTION_CHANNEL}'`);
    expect(bridge).toContain(`'${HDSL_OPERATION_UPDATED_CHANNEL}'`);
    expect(HDSL_OPERATION_UPDATED_CHANNEL).toBe('operation.updated');
  });

  it('exposes exactly three members through a single fixed world key', () => {
    expect(bridge).toContain("exposeInMainWorld('hdsl'");
    for (const member of ['call(', 'onOperationUpdated(', 'selectEnvironment(']) {
      expect(bridge).toContain(member);
    }
    // No arbitrary channel or node/electron surface is exposed.
    for (const forbidden of ['dsh-auth', 'localStorage', 'nodeIntegration']) {
      expect(bridge).not.toContain(forbidden);
    }
  });

  it('sends only to the two fixed channels', () => {
    expect(bridge).toContain('invoke(CONTRACT_CHANNEL');
    expect(bridge).toContain('send(SELECTION_CHANNEL');
    expect(bridge).not.toMatch(/invoke\([^)]*environmentId/);
  });
});

describe('production renderer wiring', () => {
  const production = source('apps/desktop/src/renderer/production.ts');

  it('builds the versioned envelope itself and validates pushed events', () => {
    expect(production).toContain("apiVersion: API_VERSION");
    expect(production).toContain('operationUpdatedEventSchema');
    expect(production).not.toContain('tokenUrl');
  });
});
