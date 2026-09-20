/**
 * T005 x T005b integration: the process manager consumes the real credentials
 * adapter (`createLaunchCredentialPort`) end to end.
 *
 * This is the interop evidence for the two #5 acceptance items: the launch env
 * comes from the T005b adapter, and `dispose()` runs in the same `finally` as
 * the spawn on success, isolation rejection, spawn error and cancellation.
 * The OS provider is an in-test double so no real secret is touched.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCredentialInjection,
  createLaunchCredentialPort,
  createProcessManager,
} from '@hdsl/runtime';
import type {
  CredentialInjection,
  OsCredentialProvider,
  ProcessLifecycleRequest,
  ProcessManager,
} from '@hdsl/runtime';
import { waitFor } from './support/harness.js';

const FAKE_DSH_PATH = fileURLToPath(new URL('./support/fake-dsh.mjs', import.meta.url));
const CANARY = 'canary-interop-secret-value';

interface InteropFixture {
  readonly dataRoot: string;
  readonly environmentId: string;
  readonly homeDirectory: string;
  readonly dataDirectory: string;
  readonly infoFile: string;
  readonly manager: ProcessManager;
  readonly disposals: () => number;
  request(overrides?: Partial<ProcessLifecycleRequest>): ProcessLifecycleRequest;
  cleanup(): Promise<void>;
}

const roots: string[] = [];

const buildFixture = async (mode = 'never-ready'): Promise<InteropFixture> => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-t005-cred-'));
  roots.push(dataRoot);
  const environmentId = 'envcred0001';
  const generationDirectory = join(dataRoot, 'environments', environmentId, 'generations', 'gencred0001');
  const homeDirectory = join(generationDirectory, 'home');
  const configDirectory = join(generationDirectory, 'config');
  const dataDirectory = join(generationDirectory, 'data');
  for (const directory of [homeDirectory, configDirectory, dataDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  const infoFile = join(dataRoot, 'fake-dsh-info.json');
  // Unique fixture copy per environment: an identity-free ownership scan must
  // never match a concurrent test's process that merely shares the script path.
  const localFakeDsh = join(generationDirectory, 'fake-dsh.mjs');
  copyFileSync(FAKE_DSH_PATH, localFakeDsh);

  const provider: OsCredentialProvider = {
    store: 'keychain',
    read: () => Promise.resolve(CANARY),
  };
  let disposals = 0;
  const injection = createCredentialInjection({ provider });
  const counting: CredentialInjection = {
    store: injection.store,
    resolveLaunchEnvironment: async (request) => {
      const launch = await injection.resolveLaunchEnvironment(request);
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
            reference: { id: 'cred-t005', store: 'keychain', key: 'hdsl-t005#account' },
          },
        ],
        baseEnv: {
          HOME: homeDirectory,
          DSH_HOME: homeDirectory,
          // Managed mapping keys (PATH/TMPDIR/DSH_AGENTS_HOME) are filled by the
          // process manager; the adapter supplies credentials and test controls.
          FAKE_DSH_MODE: mode,
          FAKE_DSH_INFO_FILE: infoFile,
        },
      }),
    injection: counting,
  });
  const manager = createProcessManager({
    dataRoot,
    credentials,
    readinessTimeoutMs: 30_000,
    stopGraceMs: 300,
    confirmMs: 3_000,
  });

  return {
    dataRoot,
    environmentId,
    homeDirectory,
    dataDirectory,
    infoFile,
    manager,
    disposals: () => disposals,
    request: (overrides = {}) => ({
      environmentId,
      expectedRevision: 1,
      generationDirectory,
      homeDirectory,
      configDirectory,
      dataDirectory,
      nodeExecutable: process.execPath,
      dshEntrypoint: localFakeDsh,
      installMode: 'npm-ci',
      signal: new AbortController().signal,
      ...overrides,
    }),
    cleanup: async () => {
      try {
        const info = JSON.parse(readFileSync(infoFile, 'utf8')) as Record<string, unknown>;
        const grandchild = info['grandchildPid'];
        if (typeof grandchild === 'number') {
          try {
            process.kill(grandchild, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      } catch {
        // no info file
      }
      await manager.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('process manager x credentials adapter', () => {
  it('injects the adapter env and disposes exactly once after the spawn', async () => {
    const fixture = await buildFixture('ready');
    try {
      const outcome = await fixture.manager.start(fixture.request());
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      await waitFor(() => {
        try {
          return readFileSync(fixture.infoFile, 'utf8').includes('"ready"');
        } catch {
          return false;
        }
      });
      const info = JSON.parse(readFileSync(fixture.infoFile, 'utf8')) as Record<string, unknown>;
      expect(info['hasCredential']).toBe(true);
      expect(info['home']).toBe(fixture.homeDirectory);
      expect(info['dshHome']).toBe(fixture.homeDirectory);
      expect(fixture.disposals()).toBe(1);

      const record = JSON.stringify(fixture.manager.readLaunchRecord(fixture.environmentId));
      expect(record).not.toContain(CANARY);

      const stop = await fixture.manager.stop(fixture.request());
      expect(stop.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('disposes when the spawn itself fails', async () => {
    const fixture = await buildFixture('ready');
    try {
      const outcome = await fixture.manager.start(
        fixture.request({ nodeExecutable: join(fixture.dataRoot, 'missing-node') }),
      );
      expect(outcome.ok).toBe(false);
      expect(fixture.disposals()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('disposes when an in-flight start is cancelled', async () => {
    const fixture = await buildFixture('never-ready');
    try {
      const controller = new AbortController();
      const start = fixture.manager.start(fixture.request({ signal: controller.signal }));
      await waitFor(() => {
        try {
          return JSON.parse(readFileSync(fixture.infoFile, 'utf8')) !== undefined;
        } catch {
          return false;
        }
      });
      controller.abort();
      const outcome = await start;
      expect(outcome.ok).toBe(false);
      expect(fixture.disposals()).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
