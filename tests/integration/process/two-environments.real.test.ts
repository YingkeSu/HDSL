/**
 * T007 S2 + S3 — real two-environment isolation, concurrent start/stop, and
 * cross-manager restart reconciliation (opt-in, issue #7).
 *
 * Gap this closes (from the T007 phase-1 audit):
 * - FR-001/SC-001: the real install lane proves two *installed* compositions are
 *   isolated, but no real evidence started two managed environments at once.
 * - FR-008: restart reconciliation was only proven deterministically with
 *   synthetic launch records; no real DSH process was adopted across a manager
 *   restart.
 *
 * What runs here (real, bounded, no model call):
 * - a real managed `npm ci` install of both audited macOS ARM64 compositions in
 *   the caller's own temporary dataRoot;
 * - two real DSH processes started concurrently through the production
 *   `createProcessManager`, each with the real core credential loader and a
 *   self-built synthetic canary value (never a personal credential);
 * - a second `ProcessManager` on the same dataRoot that adopts both running
 *   processes via `recover()`, then stops them;
 * - host `HOME` / `~/.dsh` byte-level unchanged.
 *
 * Opt-in only:
 *   HDSL_QA_REAL_DSH=1 \
 *     pnpm exec vitest run tests/integration/process/two-environments.real.test.ts
 *
 * Set `HDSL_EVIDENCE_KEEP=1` to keep the temporary dataRoot for inspection.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_VERSION, createContractRuntime } from '@hdsl/contracts';
import { createManagedInstall, generationPaths } from '@hdsl/core';
import {
  VERIFIED_COMBINATIONS,
  createCredentialInjection,
  createLaunchCredentialPort,
  createPosixProcessProbe,
  createProcessManager,
  createRuntimePort,
  isProcessAlive,
  type OsCredentialProvider,
  type ProcessManager,
} from '@hdsl/runtime';

import { captureHostDefaults, diffHostDefaults } from './support/isolation.js';

const enabled = process.env['HDSL_QA_REAL_DSH'] === '1';
const keep = process.env['HDSL_EVIDENCE_KEEP'] === '1';
const providedRoot = process.env['HDSL_QA_REAL_DSH_DATA_ROOT'];
const dataRoot = providedRoot ?? mkdtempSync(join(tmpdir(), 'hdsl-t007-two-'));

interface ManagedLaunch {
  readonly environmentId: string;
  readonly revision: number;
  readonly homeDirectory: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly generationDirectory: string;
  readonly nodeExecutable: string;
  readonly dshEntrypoint: string;
}

describe.skipIf(!enabled)('real two-environment isolation and restart adoption (opt-in)', () => {
  it('starts two real environments concurrently, adopts both after a manager restart, and stops both', async () => {
    const before = captureHostDefaults();
    const canary = `hdsl-t007-canary-${randomUUID()}`;
    const provider: OsCredentialProvider = {
      store: 'keychain',
      read: async () => canary,
    };

    const managed = await createManagedInstall({
      dataRoot,
      catalog: VERIFIED_COMBINATIONS,
      runtime: createRuntimePort(),
      operationTimeoutMs: 30 * 60_000,
    });
    let manager1: ProcessManager | undefined;
    let manager2: ProcessManager | undefined;
    try {
      expect(managed.available).toBe(true);
      const contract = createContractRuntime({ port: managed.port });
      const listEnvironments = (): readonly {
        id: string;
        name: string;
        revision: number;
        activeGenerationId: string | null;
      }[] => {
        const listed = managed.service.listEnvironments();
        if (!listed.ok) {
          throw new Error(`environments.list failed: ${JSON.stringify(listed)}`);
        }
        return listed.value;
      };

      const wanted = [
        { name: 't007-alpha', combinationId: (VERIFIED_COMBINATIONS[0] as { id: string }).id },
        { name: 't007-beta', combinationId: (VERIFIED_COMBINATIONS[1] as { id: string }).id },
      ];

      const launches: ManagedLaunch[] = [];
      for (const entry of wanted) {
        const existing = listEnvironments().find(
          (environment) =>
            environment.name === entry.name && environment.activeGenerationId !== null,
        );
        let environmentId = existing?.id;
        if (environmentId === undefined) {
          const created = contract.dispatch({
            apiVersion: API_VERSION,
            method: 'environments.create',
            input: {
              requestId: `t007-two-${entry.name}-${String(Date.now())}`,
              name: entry.name,
              catalogCombinationId: entry.combinationId,
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
          const listed = listEnvironments().find(
            (environment) => environment.name === entry.name,
          );
          environmentId = listed?.id;
        }
        expect(environmentId, `environment ${entry.name} must exist`).toBeDefined();
        if (environmentId === undefined) {
          return;
        }
        const environment = listEnvironments().find(
          (candidate) => candidate.id === environmentId,
        );
        expect(environment?.activeGenerationId, JSON.stringify(environment)).toBeTruthy();
        if (environment?.activeGenerationId == null) {
          return;
        }

        const written = managed.service.writeEnvironmentCredentials({
          environmentId,
          bindings: [
            {
              name: 'DSH_QA_CANARY',
              reference: { id: `t007-${entry.name}`, store: 'keychain', key: `hdsl-t007#${entry.name}` },
            },
          ],
        });
        expect(written.ok, JSON.stringify(written)).toBe(true);

        const paths = generationPaths(
          managed.service.layout,
          environmentId,
          environment.activeGenerationId,
        );
        launches.push({
          environmentId,
          revision: environment.revision,
          homeDirectory: paths.homeDirectory,
          configDirectory: paths.configDirectory,
          dataDirectory: paths.dataDirectory,
          generationDirectory: paths.generationDirectory,
          nodeExecutable: join(paths.nodeDirectory, 'bin', 'node'),
          dshEntrypoint: join(
            paths.dshDirectory,
            'node_modules',
            '@deepseek-ai',
            'dsh',
            'lib',
            'bin.js',
          ),
        });
      }

      expect(launches).toHaveLength(2);
      const [alpha, beta] = launches as [ManagedLaunch, ManagedLaunch];

      // FR-001: the two environments must not share any managed directory.
      const roots = [
        alpha.homeDirectory,
        alpha.configDirectory,
        alpha.dataDirectory,
        alpha.generationDirectory,
        beta.homeDirectory,
        beta.configDirectory,
        beta.dataDirectory,
        beta.generationDirectory,
      ];
      expect(new Set(roots).size).toBe(roots.length);
      expect(alpha.environmentId).not.toBe(beta.environmentId);
      expect(alpha.homeDirectory.includes(beta.environmentId)).toBe(false);
      expect(beta.homeDirectory.includes(alpha.environmentId)).toBe(false);

      const credentials = createLaunchCredentialPort({
        load: (environmentId) => managed.service.launchCredentialRequest(environmentId),
        injection: createCredentialInjection({ provider }),
      });
      const request = (launch: ManagedLaunch) => ({
        environmentId: launch.environmentId,
        expectedRevision: launch.revision,
        generationDirectory: launch.generationDirectory,
        homeDirectory: launch.homeDirectory,
        configDirectory: launch.configDirectory,
        dataDirectory: launch.dataDirectory,
        nodeExecutable: launch.nodeExecutable,
        dshEntrypoint: launch.dshEntrypoint,
        installMode: 'npm-ci' as const,
        signal: new AbortController().signal,
        port: 'auto' as const,
      });

      manager1 = createProcessManager({
        dataRoot,
        credentials,
        probe: createPosixProcessProbe(),
      });

      // FR-005/SC-001: start both concurrently and prove each gets its own
      // loopback origin.
      const [startedAlpha, startedBeta] = await Promise.all([
        manager1.start(request(alpha)),
        manager1.start(request(beta)),
      ]);
      expect(startedAlpha.ok, JSON.stringify(startedAlpha)).toBe(true);
      expect(startedBeta.ok, JSON.stringify(startedBeta)).toBe(true);
      if (!startedAlpha.ok || !startedBeta.ok) {
        return;
      }
      expect(startedAlpha.value.loopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(startedBeta.value.loopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(startedAlpha.value.loopbackOrigin).not.toBe(startedBeta.value.loopbackOrigin);

      for (const launch of launches) {
        const record = manager1.readLaunchRecord(launch.environmentId);
        expect(record?.state).toBe('running');
        expect(record?.endpoint?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(JSON.stringify(record ?? {})).not.toContain(canary);
        expect(JSON.stringify(record ?? {})).not.toContain('token=');
      }

      // FR-008: a fresh manager on the same dataRoot adopts both real processes
      // (no signal, no respawn), then owns the stop.
      manager2 = createProcessManager({
        dataRoot,
        credentials,
        probe: createPosixProcessProbe(),
      });
      const report = await manager2.recover();
      const byEnvironment = new Map(
        report.entries.map((entry) => [entry.environmentId, entry.resolution]),
      );
      expect(byEnvironment.get(alpha.environmentId)).toBe('adopted');
      expect(byEnvironment.get(beta.environmentId)).toBe('adopted');

      const pids = launches.map((launch) => manager2?.readLaunchRecord(launch.environmentId)?.identity?.pid);
      for (const pid of pids) {
        expect(pid).toBeTypeOf('number');
        expect(isProcessAlive(pid ?? -1)).toBe(true);
      }

      for (const launch of launches) {
        const stopped = await manager2.stop(request(launch));
        expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
        expect(manager2.readLaunchRecord(launch.environmentId)?.state).not.toBe('running');
      }
      for (const pid of pids) {
        expect(isProcessAlive(pid ?? -1)).toBe(false);
      }

      expect((await manager2.close()).ok).toBe(true);
      manager2 = undefined;
      expect((await manager1.close()).ok).toBe(true);
      manager1 = undefined;

      expect(diffHostDefaults(before, captureHostDefaults()).equal).toBe(true);

      // eslint-disable-next-line no-console
      console.log(
        `HDSL_T007_TWO_ENV_EVIDENCE ${JSON.stringify(
          {
            dataRoot: providedRoot === undefined ? '<temporary>' : dataRoot,
            alpha: { id: alpha.environmentId, origin: startedAlpha.value.loopbackOrigin },
            beta: { id: beta.environmentId, origin: startedBeta.value.loopbackOrigin },
            recoverResolutions: [...byEnvironment.values()],
            hostHomeUntouched: true,
          },
          null,
          2,
        )}`,
      );
    } finally {
      await manager2?.close().catch(() => undefined);
      await manager1?.close().catch(() => undefined);
      await managed.close().catch(() => undefined);
      if (providedRoot === undefined && !keep) {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    }
  }, 40 * 60_000);
});
