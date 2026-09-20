/**
 * T005 x T005c real composition wiring: core's `launchCredentialRequest`
 * (environment credential store + trusted `generationPaths` baseEnv) feeds the
 * T005b credential port, whose resolved environment is consumed by the T005
 * process manager.
 *
 * This proves the single managed-env mapping agreed with the orchestration:
 * HOME, DSH_HOME, DSH_AGENTS_HOME, PATH and TMPDIR are derived from the
 * request's trusted paths and must exactly match the baseEnv core provides. The
 * managed "DSH" entrypoint is the controlled fixture (synthetic
 * artifacts-only install), never the real CLI.
 */
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { portOk, type CredentialReference, type RuntimeCombination } from '@hdsl/contracts';
import {
  createManagedInstall,
  generationPaths,
  type CredentialBinding,
  type ManagedProcessPort,
} from '@hdsl/core';
import {
  createCredentialInjection,
  createLaunchCredentialPort,
  createProcessManager,
  createRuntimePort,
} from '@hdsl/runtime';
import type { OsCredentialProvider, ProcessManager } from '@hdsl/runtime';
import {
  sha256,
  syntheticCombination,
  syntheticDshTarball,
  syntheticNodeTarball,
  writeLocalArtifact,
} from '../install/synthetic.js';
import { waitFor } from './support/harness.js';

const FAKE_DSH_PATH = fileURLToPath(new URL('./support/fake-dsh.mjs', import.meta.url));

const nodeTarball = syntheticNodeTarball('22.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});

const binding: CredentialBinding = {
  name: 'DEEPSEEK_API_KEY',
  reference: { id: 'cred-t005-wiring', store: 'keychain', key: 'hdsl.t005#account-1' },
};

const fakeProcess = (): ManagedProcessPort => ({
  start: () => Promise.resolve(portOk({ pid: 4321, loopbackOrigin: 'http://127.0.0.1:53123' })),
  stop: () => Promise.resolve(portOk({ wasRunning: true })),
  openWebUI: () => portOk({ loopbackOrigin: 'http://127.0.0.1:53123' }),
  recover: () => Promise.resolve({ entries: [] }),
  close: () => Promise.resolve(portOk(undefined)),
});

const roots: string[] = [];
const freshRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('core loader -> credential port -> process manager', () => {
  it('launches with the exact five-key managed environment from core baseEnv', async () => {
    const dataRoot = freshRoot('hdsl-t005-wiring-');
    const artifacts = freshRoot('hdsl-t005-wiring-artifacts-');
    writeLocalArtifact(artifacts, sha256(nodeTarball), nodeTarball);
    writeLocalArtifact(artifacts, sha256(dshTarball), dshTarball);
    const managed = await createManagedInstall({
      dataRoot,
      catalog: [combination] as readonly RuntimeCombination[],
      runtime: createRuntimePort({
        closureInstall: false,
        precheck: 'none',
        localArtifactDirectory: artifacts,
      }),
      process: fakeProcess(),
      fixtures: { allowArtifactsOnly: true },
      lockWaitTimeoutMs: 500,
    });
    const created = managed.service.createEnvironment({
      requestId: 'req-t005-wiring',
      name: 't005-wiring',
      combination,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) {
      return;
    }
    await managed.waitForOperation(created.value.operationId);
    const listed = managed.service.listEnvironments();
    const summary = listed.ok
      ? listed.value.find((environment) => environment.activeGenerationId !== null)
      : undefined;
    expect(summary).toBeDefined();
    if (summary === undefined || summary.activeGenerationId === null) {
      return;
    }
    managed.service.writeEnvironmentCredentials({
      environmentId: summary.id,
      bindings: [binding],
    });

    const paths = generationPaths(managed.service.layout, summary.id, summary.activeGenerationId);
    // Model the real managed-install layout: the managed node lives under the
    // generation so `dirname(nodeExecutable)` matches core's PATH baseEnv.
    const nodeBin = join(paths.generationDirectory, 'node', 'bin');
    mkdirSync(nodeBin, { recursive: true });
    const nodeExecutable = join(nodeBin, 'node');
    // The synthetic node artifact ships a placeholder at this path; replace it
    // with the real interpreter so the fixture can actually run.
    rmSync(nodeExecutable, { force: true });
    symlinkSync(process.execPath, nodeExecutable);
    const dshEntrypoint = join(paths.generationDirectory, 'fake-dsh.mjs');
    copyFileSync(FAKE_DSH_PATH, dshEntrypoint);
    const infoFile = join(dataRoot, 'wiring-info.json');

    const provider: OsCredentialProvider = {
      store: 'keychain',
      read: (_reference: CredentialReference) => Promise.resolve('wiring-secret-value'),
    };
    const credentials = createLaunchCredentialPort({
      load: (environmentId) => managed.service.launchCredentialRequest(environmentId),
      injection: createCredentialInjection({ provider }),
    });
    // Fixture control variables are test-only extras on top of the real loader
    // env; the five managed keys still come from core's baseEnv unchanged.
    const credentialPort = {
      resolveLaunchEnvironment: async (environmentId: string) => {
        const outcome = await credentials.resolveLaunchEnvironment(environmentId);
        if (!outcome.ok) {
          return outcome;
        }
        return portOk({
          env: {
            ...outcome.value.env,
            FAKE_DSH_MODE: 'ready',
            FAKE_DSH_INFO_FILE: infoFile,
          },
          dispose: outcome.value.dispose,
        });
      },
    };
    const manager: ProcessManager = createProcessManager({ dataRoot, credentials: credentialPort });

    const request = {
      environmentId: summary.id,
      expectedRevision: summary.revision,
      generationDirectory: paths.generationDirectory,
      homeDirectory: paths.homeDirectory,
      configDirectory: paths.configDirectory,
      dataDirectory: paths.dataDirectory,
      nodeExecutable,
      dshEntrypoint,
      installMode: 'npm-ci' as const,
      signal: new AbortController().signal,
      port: 'auto' as const,
      onPhase: () => undefined,
    };

    const started = await manager.start(request);
    expect(started.ok, JSON.stringify(started)).toBe(true);
    await waitFor(() => {
      try {
        return readFileSync(infoFile, 'utf8').includes('"ready"');
      } catch {
        return false;
      }
    });
    const info = JSON.parse(readFileSync(infoFile, 'utf8')) as Record<string, unknown>;

    // The five managed keys are exactly core's baseEnv mapping.
    expect(info['home']).toBe(paths.homeDirectory);
    expect(info['dshHome']).toBe(paths.homeDirectory);
    expect(info['agentsHome']).toBe(join(paths.homeDirectory, 'agents'));
    expect(info['tmpdir']).toBe(join(paths.homeDirectory, '.tmp'));
    expect(info['path']).toBe(`${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(info['hasCredential']).toBe(true);

    const stopped = await manager.stop(request);
    expect(stopped.ok).toBe(true);
    await manager.close();
    await managed.close();
  });
});
