/**
 * T007b — bounded real-DSH independent verification (issue #45, opt-in).
 *
 * Runs against a real audited managed install (npm-ci) in the caller's own
 * temporary dataRoot, with the real core loader (`service.launchCredentialRequest`)
 * → strict credential port (controlled provider) → process manager. It starts
 * one environment, waits for the upstream ready line/loopback endpoint, stops
 * it and closes, and checks the host default `~/.dsh` is unchanged. No model
 * call, no personal credential, and the author's evidence data root is never
 * modified.
 *
 * Opt-in only:
 *   HDSL_QA_REAL_DSH=1 \
 *   HDSL_QA_REAL_DSH_DATA_ROOT=/tmp/<own-copy> \
 *     pnpm exec vitest run tests/integration/process/process.real-dsh.evidence.test.ts
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManagedInstall, generationPaths } from '@hdsl/core';
import {
  VERIFIED_COMBINATIONS,
  createCredentialInjection,
  createLaunchCredentialPort,
  createPosixProcessProbe,
  createProcessManager,
  createRuntimePort,
  type OsCredentialProvider,
  type ProcessManager,
} from '@hdsl/runtime';

import { captureHostDefaults, diffHostDefaults } from './support/isolation.js';

const enabled = process.env['HDSL_QA_REAL_DSH'] === '1';
const dataRoot = process.env['HDSL_QA_REAL_DSH_DATA_ROOT'];

describe.skipIf(!enabled || dataRoot === undefined)('real DSH bounded QA (opt-in)', () => {
  it('starts, reaches a loopback endpoint, stops and closes without touching host HOME', async () => {
    const before = captureHostDefaults();
    const canary = `hdsl-qa-canary-${randomUUID()}`;
    const provider: OsCredentialProvider = {
      store: 'keychain',
      read: async () => canary,
    };

    const managed = await createManagedInstall({
      dataRoot: dataRoot as string,
      catalog: VERIFIED_COMBINATIONS,
      runtime: createRuntimePort(),
      operationTimeoutMs: 30 * 60_000,
    });

    let manager: ProcessManager | undefined;
    try {
      expect(managed.available).toBe(true);
      const list = managed.service.listEnvironments();
      expect(list.ok).toBe(true);
      const environments = list.ok
        ? (list.value as readonly { id: string; revision: number; activeGenerationId: string | null }[])
        : [];
      const environment = environments.find((entry) => entry.activeGenerationId !== null);
      expect(environment).toBeDefined();
      if (environment === undefined || environment.activeGenerationId === null) {
        return;
      }

      const binding = managed.service.writeEnvironmentCredentials({
        environmentId: environment.id,
        bindings: [
          {
            name: 'DSH_QA_CANARY',
            reference: { id: 'qa-real-canary', store: 'keychain', key: 'hdsl-qa-real#canary' },
          },
        ],
      });
      expect(binding.ok, JSON.stringify(binding)).toBe(true);

      const paths = generationPaths(managed.service.layout, environment.id, environment.activeGenerationId);
      const credentials = createLaunchCredentialPort({
        load: (environmentId) => managed.service.launchCredentialRequest(environmentId),
        injection: createCredentialInjection({ provider }),
      });
      manager = createProcessManager({
        dataRoot: dataRoot as string,
        credentials,
        probe: createPosixProcessProbe(),
      });

      const request = {
        environmentId: environment.id,
        expectedRevision: environment.revision,
        generationDirectory: paths.generationDirectory,
        homeDirectory: paths.homeDirectory,
        configDirectory: paths.configDirectory,
        dataDirectory: paths.dataDirectory,
        nodeExecutable: join(paths.nodeDirectory, 'bin', 'node'),
        dshEntrypoint: join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        installMode: 'npm-ci' as const,
        signal: new AbortController().signal,
        port: 'auto' as const,
      };

      const started = await manager.start(request);
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) {
        return;
      }
      expect(started.value.loopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const record = manager.readLaunchRecord(environment.id);
      expect(record?.state).toBe('running');
      // Endpoint restriction: only a canonical loopback origin, no token/query.
      expect(record?.endpoint?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(JSON.stringify(record ?? {}).includes('token=')).toBe(false);

      const stopped = await manager.stop(request);
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      expect(manager.readLaunchRecord(environment.id)?.state).not.toBe('running');

      // Affected cleanup path: restart after a clean stop, then stop and close.
      const restarted = await manager.start(request);
      expect(restarted.ok, JSON.stringify(restarted)).toBe(true);
      if (!restarted.ok) {
        return;
      }
      expect(restarted.value.loopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(manager.readLaunchRecord(environment.id)?.state).toBe('running');
      const stoppedAgain = await manager.stop(request);
      expect(stoppedAgain.ok, JSON.stringify(stoppedAgain)).toBe(true);
      expect(manager.readLaunchRecord(environment.id)?.state).not.toBe('running');

      const closed = await manager.close();
      expect(closed.ok, JSON.stringify(closed)).toBe(true);

      expect(diffHostDefaults(before, captureHostDefaults()).equal).toBe(true);
    } finally {
      await manager?.close().catch(() => undefined);
      await managed.close().catch(() => undefined);
    }
  }, 20 * 60_000);
});
