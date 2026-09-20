/**
 * Real loader-port wiring evidence (T005c / issue #52).
 *
 * The test layer is allowed to import the runtime credential module directly
 * (the runtime root intentionally does not re-export it yet), combining core's
 * `launchCredentialRequest` with `createLaunchCredentialPort` exactly as the
 * composition root (#6) will. Production core never imports runtime, and no
 * runtime export is added for the test.
 *
 * The provider is controlled: no personal keychain, no network, no paid call.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { portOk, type CredentialReference, type RuntimeCombination } from '@hdsl/contracts';
import {
  createManagedInstall,
  type CredentialBinding,
  type ManagedInstall,
  type ManagedProcessPort,
} from '@hdsl/core';
import { createRuntimePort } from '@hdsl/runtime';
import {
  createCredentialInjection,
  createLaunchCredentialPort,
  type OsCredentialProvider,
} from '../../packages/runtime/src/credentials/index.js';
import { sha256, syntheticCombination, syntheticDshTarball, syntheticNodeTarball, writeLocalArtifact } from '../install/synthetic.js';

const nodeTarball = syntheticNodeTarball('22.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});

const binding = (key = 'hdsl.wiring.credential#account-1'): CredentialBinding => ({
  name: 'DEEPSEEK_API_KEY',
  reference: { id: 'cred-1234567890abcdef', store: 'keychain', key },
});

const fakeProcess = (): ManagedProcessPort => ({
  start: () => Promise.resolve(portOk({ pid: 4321, loopbackOrigin: 'http://127.0.0.1:53123' })),
  stop: () => Promise.resolve(portOk({ wasRunning: true })),
  openWebUI: () => portOk({ loopbackOrigin: 'http://127.0.0.1:53123' }),
  recover: () => Promise.resolve({ entries: [] }),
  close: () => Promise.resolve(portOk(undefined)),
});

interface Reads {
  count: number;
  references: readonly CredentialReference[];
}

interface Harness {
  readonly managed: ManagedInstall;
  readonly environmentId: string;
}

const roots: string[] = [];

const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-credwiring-'));
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
    requestId: 'req-wiring',
    name: 'wiring',
    combination,
  });
  if (!created.ok) {
    throw new Error('environment creation was refused');
  }
  await managed.waitForOperation(created.value.operationId);
  const list = managed.service.listEnvironments();
  if (!list.ok || list.value[0] === undefined) {
    throw new Error('environment was not listed');
  }
  return { managed, environmentId: list.value[0].id };
};

const portFor = (harness: Harness, reads: Reads) => {
  const provider: OsCredentialProvider = {
    store: 'keychain',
    read: (reference) => {
      reads.count += 1;
      reads.references = [...reads.references, reference];
      return Promise.resolve('test-secret-value');
    },
  };
  const injection = createCredentialInjection({ provider });
  return createLaunchCredentialPort({
    load: (environmentId) => harness.managed.service.launchCredentialRequest(environmentId),
    injection,
  });
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('core loader wired into the runtime credential port', () => {
  it('resolves a complete reference into an explicit environment with an idempotent dispose', async () => {
    const harness = await buildHarness();
    const reads: Reads = { count: 0, references: [] };
    harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding()],
    });

    const outcome = await portFor(harness, reads).resolveLaunchEnvironment(harness.environmentId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.env['DEEPSEEK_API_KEY']).toBe('test-secret-value');
    // Explicit base environment plus the resolved variable; no host inheritance.
    expect(Object.keys(outcome.value.env).sort()).toEqual([
      'DEEPSEEK_API_KEY',
      'DSH_AGENTS_HOME',
      'DSH_HOME',
      'HOME',
      'PATH',
      'TMPDIR',
    ]);
    expect(reads.count).toBe(1);
    expect(outcome.value.dispose()).toBeUndefined();
    expect(outcome.value.dispose()).toBeUndefined();
  });

  it('rejects a service-only keychain reference before the provider is read', async () => {
    const harness = await buildHarness();
    const reads: Reads = { count: 0, references: [] };
    harness.managed.service.writeEnvironmentCredentials({
      environmentId: harness.environmentId,
      bindings: [binding('hdsl.wiring.credential')],
    });

    const outcome = await portFor(harness, reads).resolveLaunchEnvironment(harness.environmentId);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
      expect(outcome.message).not.toContain('test-secret-value');
    }
    expect(reads.count).toBe(0);
  });

  it('maps a load failure to a controlled failure without throwing', async () => {
    const harness = await buildHarness();
    const reads: Reads = { count: 0, references: [] };
    // No record configured: core's loader rejects.
    const outcome = await portFor(harness, reads).resolveLaunchEnvironment(harness.environmentId);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
    }
    expect(reads.count).toBe(0);
  });
});
