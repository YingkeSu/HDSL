/**
 * OPT-IN real-DSH process evidence (T005).
 *
 * Not part of the default unit run: it launches the audited rc.2 DSH from a
 * real managed install, waits for the upstream ready line, verifies the
 * loopback endpoint, stops the owned tree and asserts the host default DSH home
 * is untouched.
 *
 * Run explicitly:
 *
 * ```sh
 * HDSL_REAL_PROCESS=1 HDSL_EVIDENCE_KEEP=1 \
 * HDSL_REAL_PROCESS_DATA_ROOT=/tmp/hdsl-t005-evidence \
 *   pnpm exec vitest run tests/process/real-process.evidence.test.ts --reporter=verbose
 * ```
 *
 * Reusing an existing managed-install data root skips the download; without it
 * the test performs a real managed install first. The credential used is a
 * disposable, non-functional canary: no model call is made.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_VERSION, createContractRuntime } from '@hdsl/contracts';
import { createManagedInstall, generationPaths } from '@hdsl/core';
import {
  VERIFIED_COMBINATIONS,
  createCredentialInjection,
  createLaunchCredentialPort,
  createProcessManager,
  createRuntimePort,
  isProcessAlive,
} from '@hdsl/runtime';
import type { CredentialInjection, OsCredentialProvider, ProcessManager } from '@hdsl/runtime';

const enabled = process.env['HDSL_REAL_PROCESS'] === '1';
const keep = process.env['HDSL_EVIDENCE_KEEP'] === '1';
const dataRoot =
  process.env['HDSL_REAL_PROCESS_DATA_ROOT'] ??
  mkdtempSync(join(tmpdir(), 'hdsl-t005-evidence-'));

const snapshotHome = (): string[] => {
  const dshHome = join(homedir(), '.dsh');
  if (!existsSync(dshHome)) {
    return [];
  }
  return readdirSync(dshHome).sort();
};

describe.skipIf(!enabled)('real DSH process lifecycle (opt-in evidence)', () => {
  it(
    'starts, verifies readiness and ownership, and stops the owned tree',
    async () => {
      const homeBefore = snapshotHome();
      const managed = await createManagedInstall({
        dataRoot,
        catalog: VERIFIED_COMBINATIONS,
        runtime: createRuntimePort(),
        operationTimeoutMs: 30 * 60_000,
      });

      const existing = managed.service.listEnvironments();
      const existingSummaries = existing.ok ? existing.value : [];
      let summary = existingSummaries.find(
        (environment) => environment.activeGenerationId !== null,
      );
      if (summary === undefined) {
        const contract = createContractRuntime({ port: managed.port });
        const created = contract.dispatch({
          apiVersion: API_VERSION,
          method: 'environments.create',
          input: {
            requestId: `t005-evidence-${String(Date.now())}`,
            name: 't005-evidence',
            catalogCombinationId: (VERIFIED_COMBINATIONS[0] as { id: string }).id,
          },
        });
        expect(created.ok, JSON.stringify(created)).toBe(true);
        if (!created.ok) {
          return;
        }
        const operationId = (created.value as { operationId: string }).operationId;
        const snapshot = await managed.waitForOperation(operationId, {
          timeoutMs: 30 * 60_000,
        });
        expect(snapshot.status, JSON.stringify(snapshot)).toBe('succeeded');
        summary = (() => {
          const listed = managed.service.listEnvironments();
          return listed.ok
            ? listed.value.find((environment) => environment.activeGenerationId !== null)
            : undefined;
        })();
      }
      expect(summary).toBeDefined();
      if (summary === undefined || summary.activeGenerationId === null) {
        return;
      }

      const manifest = managed.service.readInstallManifest(summary.id);
      expect(manifest.installMode).toBe('npm-ci');
      const paths = generationPaths(managed.service.layout, summary.id, summary.activeGenerationId);
      const generationDirectory = paths.generationDirectory;
      const nodeExecutable = join(generationDirectory, 'node', 'bin', 'node');
      const dshEntrypoint = join(
        generationDirectory,
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js',
      );

      let disposals = 0;
      // The real T005b adapter with an in-test OS provider: the managed launch
      // environment is built by the credentials module, not by the test.
      const provider: OsCredentialProvider = {
        store: 'keychain',
        read: () => Promise.resolve('hdsl-t005-canary-no-model-call'),
      };
      const injection = createCredentialInjection({ provider });
      const counting: CredentialInjection = {
        store: injection.store,
        resolveLaunchEnvironment: async (input) => {
          const launch = await injection.resolveLaunchEnvironment(input);
          return {
            ...launch,
            dispose: () => {
              disposals += 1;
              launch.dispose();
            },
          };
        },
      };
      const credentials = createLaunchCredentialPort({
        load: () =>
          Promise.resolve({
            bindings: [
              {
                name: 'DEEPSEEK_API_KEY',
                reference: { id: 't005-evidence', store: 'keychain', key: 'hdsl-t005-evidence#t005' },
              },
            ],
            baseEnv: {
              HOME: paths.homeDirectory,
              DSH_HOME: paths.homeDirectory,
              PATH: `${join(generationDirectory, 'node', 'bin')}:/usr/bin:/bin`,
            },
          }),
        injection: counting,
      });
      const manager: ProcessManager = createProcessManager({ dataRoot, credentials });
      const request = {
        environmentId: summary.id,
        expectedRevision: summary.revision,
        generationDirectory,
        homeDirectory: paths.homeDirectory,
        configDirectory: paths.configDirectory,
        dataDirectory: paths.dataDirectory,
        nodeExecutable,
        dshEntrypoint,
        installMode: 'npm-ci' as const,
        signal: new AbortController().signal,
        port: 'auto' as const,
      };

      const started = await manager.start(request);
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) {
        return;
      }
      const origin = started.value.loopbackOrigin;
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // The endpoint answers like DSH (401 without the bootstrap cookie).
      const response = await fetch(origin);
      expect(response.status).toBe(401);

      const web = manager.openWebUI(summary.id);
      expect(web.ok).toBe(true);
      if (web.ok) {
        expect(web.value.loopbackOrigin).toBe(origin);
      }

      const record = manager.readLaunchRecord(summary.id);
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('hdsl-t005-canary-no-model-call');
      expect(serialized).not.toContain('token');
      expect(record?.identity?.startToken.length ?? 0).toBeGreaterThan(0);
      expect(existsSync(generationDirectory)).toBe(true);

      const credentialArtifact = join(paths.homeDirectory, '.credentials.yaml');
      const credentialMode = existsSync(credentialArtifact)
        ? (statSync(credentialArtifact).mode & 0o777).toString(8)
        : null;

      const stopped = await manager.stop(request);
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      if (stopped.ok) {
        expect(stopped.value.wasRunning).toBe(true);
        expect(isProcessAlive(stopped.value.pid ?? -1)).toBe(false);
      }
      const closed = await manager.close();
      expect(closed.ok).toBe(true);
      expect(disposals).toBe(1);
      expect(snapshotHome()).toEqual(homeBefore);

      // eslint-disable-next-line no-console
      console.log(
        `HDSL_REAL_PROCESS_EVIDENCE ${JSON.stringify(
          {
            dataRoot,
            environmentId: summary.id,
            nodeVersion: manifest.node.version,
            dshVersion: manifest.dsh.version,
            installMode: manifest.installMode,
            origin,
            httpStatus: response.status,
            launchRecordState: record?.state,
            startTokenPresent: (record?.identity?.startToken.length ?? 0) > 0,
            upstreamCredentialArtifact: credentialArtifact.replace(dataRoot, '<dataRoot>'),
            upstreamCredentialMode: credentialMode,
            homeUntouched: true,
          },
          null,
          2,
        )}`,
      );

      await managed.close();
      if (!keep) {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    3_600_000,
  );
});
