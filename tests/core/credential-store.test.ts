/**
 * Core credential reference store and launch loader (T005c / issue #52).
 *
 * The store persists only `CredentialReference` bindings, never a secret. The
 * loader builds the explicit child base environment from the committed
 * generation paths and fails closed on a missing/corrupt record.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { portOk, type RuntimeCombination } from '@hdsl/contracts';
import {
  createManagedInstall,
  CredentialStore,
  resolveLayout,
  type CredentialBinding,
  type ManagedInstall,
  type ManagedProcessPort,
} from '@hdsl/core';
import { createRuntimePort } from '@hdsl/runtime';
import { sha256, syntheticCombination, syntheticDshTarball, syntheticNodeTarball, writeLocalArtifact } from '../install/synthetic.js';

const nodeTarball = syntheticNodeTarball('22.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});

const binding = (name = 'DEEPSEEK_API_KEY', key = 'hdsl.test.credential#account-1'): CredentialBinding => ({
  name,
  reference: { id: 'cred-1234567890abcdef', store: 'keychain', key },
});

const fakeProcess = (): ManagedProcessPort => ({
  start: () => Promise.resolve(portOk({ pid: 4321, loopbackOrigin: 'http://127.0.0.1:53123' })),
  stop: () => Promise.resolve(portOk({ wasRunning: true })),
  openWebUI: () => portOk({ loopbackOrigin: 'http://127.0.0.1:53123' }),
  recover: () => Promise.resolve({ entries: [] }),
  close: () => Promise.resolve(portOk(undefined)),
});

interface Harness {
  readonly dataRoot: string;
  readonly managed: ManagedInstall;
  readonly environmentId: string;
  readonly revision: number;
  readonly recordPath: string;
}

const roots: string[] = [];

const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-cred-'));
  roots.push(root);
  return root;
};

const buildHarness = async (): Promise<Harness> => {
  const dataRoot = freshRoot();
  const artifacts = freshRoot();
  writeLocalArtifact(artifacts, sha256(nodeTarball), nodeTarball);
  writeLocalArtifact(artifacts, sha256(dshTarball), dshTarball);
  const runtime = createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    localArtifactDirectory: artifacts,
  });
  const managed = await createManagedInstall({
    dataRoot,
    catalog: [combination] as readonly RuntimeCombination[],
    runtime,
    process: fakeProcess(),
    fixtures: { allowArtifactsOnly: true },
    lockWaitTimeoutMs: 200,
  });
  const created = managed.service.createEnvironment({
    requestId: 'req-credential',
    name: 'credential',
    combination,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error('environment creation was refused');
  }
  const settled = await managed.waitForOperation(created.value.operationId);
  expect(settled.status).toBe('succeeded');
  const list = managed.service.listEnvironments();
  if (!list.ok || list.value[0] === undefined) {
    throw new Error('environment was not listed');
  }
  const environment = list.value[0];
  return {
    dataRoot,
    managed,
    environmentId: environment.id,
    revision: environment.revision,
    recordPath: join(managed.service.layout.environments, environment.id, 'credentials.json'),
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('environment credential reference store', () => {
  it('stores only references and returns them with an explicit baseEnv', async () => {
    const harness = await buildHarness();
    const written = harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding()],
      expectedRevision: harness.revision,
    });
    expect(written.ok).toBe(true);
    if (written.ok) {
      expect(written.value.revision).toBe(1);
    }

    const request = await harness.managed.service.launchCredentialRequest(harness.environmentId);
    expect(request.bindings).toEqual([binding()]);
    expect(request.baseEnv['DSH_HOME']).toContain(
      join('environments', harness.environmentId, 'home'),
    );
    expect(request.baseEnv['HOME']).toBe(request.baseEnv['DSH_HOME']);
    expect(request.baseEnv['DSH_AGENTS_HOME']).toBe(`${request.baseEnv['HOME']}/agents`);
    expect(request.baseEnv['TMPDIR']).toBe(`${request.baseEnv['HOME']}/.tmp`);
    expect(request.baseEnv['PATH']).toMatch(/node\/bin/);
    // No host environment inheritance and no secret value.
    expect(Object.keys(request.baseEnv).sort()).toEqual([
      'DSH_AGENTS_HOME',
      'DSH_HOME',
      'HOME',
      'PATH',
      'TMPDIR',
    ]);
    expect(JSON.stringify(request)).not.toContain('SECRET');

    // The stored file is reference-only, mode 0600.
    const mode = statSync(harness.recordPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = readFileSync(harness.recordPath, 'utf8');
    expect(raw).toContain('hdsl.test.credential#account-1');
    expect(raw).not.toContain('secret');
  });

  it('fails closed when no credential binding is configured', async () => {
    const harness = await buildHarness();
    await expect(harness.managed.service.launchCredentialRequest(harness.environmentId)).rejects.toThrow();
  });

  it('fails closed on a corrupt record and lets a trusted write repair it', async () => {
    const harness = await buildHarness();
    writeFileSync(harness.recordPath, '{ not json');
    await expect(harness.managed.service.launchCredentialRequest(harness.environmentId)).rejects.toThrow();

    const repaired = harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding()],
    });
    expect(repaired.ok).toBe(true);
    const request = await harness.managed.service.launchCredentialRequest(harness.environmentId);
    expect(request.bindings).toHaveLength(1);
  });

  it('rejects an invalid binding shape without writing a record', async () => {
    const harness = await buildHarness();
    const invalid = {
      name: 'DEEPSEEK_API_KEY',
      reference: { id: 'cred-1234567890abcdef', store: 'keychain', key: 'service#account', extra: true },
    } as unknown as CredentialBinding;
    const result = harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [invalid],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_INPUT');
    }
    expect(existsSync(harness.recordPath)).toBe(false);
  });

  it('rejects a credential mutation while the environment is running', async () => {
    const harness = await buildHarness();
    const started = harness.managed.service.startEnvironment({
      requestId: 'req-start',
      environmentId: harness.environmentId,
      expectedRevision: harness.revision,
    });
    expect(started.ok).toBe(true);
    if (started.ok) {
      await harness.managed.waitForOperation(started.value.operationId);
    }
    const result = harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ENVIRONMENT_BUSY');
    }
  });

  it('clears the record and fails closed again', async () => {
    const harness = await buildHarness();
    harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding()],
    });
    const cleared = harness.managed.service.clearEnvironmentCredentials({
      environmentId: harness.environmentId,
    });
    expect(cleared.ok).toBe(true);
    expect(existsSync(harness.recordPath)).toBe(false);
    await expect(harness.managed.service.launchCredentialRequest(harness.environmentId)).rejects.toThrow();
  });

  it('cleans its own temp file and preserves the old target when the atomic rename fails', () => {
    const dataRoot = freshRoot();
    const layout = resolveLayout(dataRoot);
    const store = new CredentialStore(layout);
    const environmentId = 'env-credentialtmp0';
    const directory = join(layout.environments, environmentId);
    // A non-empty directory at the target path makes rename(file, target) fail.
    mkdirSync(join(directory, 'credentials.json', 'keep'), { recursive: true });
    expect(() => store.write(environmentId, [binding()], 0, new Date().toISOString())).toThrow();
    expect(statSync(join(directory, 'credentials.json')).isDirectory()).toBe(true);
    const leftovers = readdirSync(directory).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('guards the environment revision and increments the record revision', async () => {
    const harness = await buildHarness();
    const first = harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding()],
    });
    expect(first.ok && first.value.revision).toBe(1);
    const second = harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding('DEEPSEEK_API_KEY', 'hdsl.test.credential#account-2')],
    });
    expect(second.ok && second.value.revision).toBe(2);
    const conflict = harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding()],
      expectedRevision: harness.revision + 99,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe('REVISION_CONFLICT');
    }
  });

  it('never exposes the reference through the environment summary', async () => {
    const harness = await buildHarness();
    harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding()],
    });
    const list = harness.managed.service.listEnvironments();
    expect(list.ok).toBe(true);
    if (list.ok) {
      const serialized = JSON.stringify(list.value);
      expect(serialized).not.toContain('hdsl.test.credential#account-1');
      expect(serialized).not.toContain('cred-1234567890abcdef');
    }
  });
});
