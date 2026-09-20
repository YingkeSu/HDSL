/**
 * Isolated dataRoot fixture for the desktop E2E slice.
 *
 * Real-window acceptance starts the app against a temporary dataRoot with two
 * separately named environment homes, each holding its own clearly-fake canary
 * credential. That makes isolation, the dual-instance lock and the secret-leak
 * checks observable without ever reading the developer's OS keychain, calling a
 * model, or touching the user's `~/.dsh` / DSH instance.
 *
 * The host guard snapshots the real default locations read-only, so a launcher
 * that ignores the managed root is caught. `harness.test.ts` proves the
 * snapshot diff reacts to a real write (see `tree.ts`), and that cleanup only
 * removes registered resources.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createCanary, plantUpstreamCredentialArtifacts, type UpstreamCredentialArtifacts } from './canary.js';
import type { CleanupReport, QaResourceRegistry } from './resources.js';
import { snapshotTree, type TreeEntry } from './tree.js';

export interface E2eInstanceDescriptor {
  readonly id: string;
  readonly root: string;
  readonly home: string;
  readonly dshHome: string;
  readonly canaryValue: string;
  readonly credential: UpstreamCredentialArtifacts;
  readonly markerFile: string;
}

export interface IsolatedDataRootFixture {
  readonly root: string;
  readonly dataRoot: string;
  readonly instances: readonly E2eInstanceDescriptor[];
  envFor(instanceId: string): Record<string, string>;
  cleanup(): Promise<CleanupReport>;
}

const buildInstance = (root: string, id: string): E2eInstanceDescriptor => {
  const instanceRoot = join(root, id);
  const home = join(instanceRoot, 'home');
  const dshHome = join(instanceRoot, 'dsh-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  const canaryValue = createCanary(id);
  const credential = plantUpstreamCredentialArtifacts(dshHome, canaryValue);
  const markerFile = join(home, `${id}-marker.txt`);
  writeFileSync(markerFile, `owner=${id}\n`);
  return { id, root: instanceRoot, home, dshHome, canaryValue, credential, markerFile };
};

/**
 * Builds `dataRoot` + one isolated instance per id inside a registered temp
 * root. All files are created under the temp root; the fixture never writes to
 * the real home and never reads an OS credential store.
 */
export const createIsolatedDataRootFixture = (
  registry: QaResourceRegistry,
  label: string,
  instanceIds: readonly string[] = ['instance-a', 'instance-b'],
): IsolatedDataRootFixture => {
  const root = registry.registerTempRoot(label);
  const dataRoot = join(root, 'data-root');
  mkdirSync(dataRoot, { recursive: true });
  const instances = instanceIds.map((id) => buildInstance(root, id));
  return {
    root,
    dataRoot,
    instances,
    envFor: (instanceId) => {
      const instance = instances.find((candidate) => candidate.id === instanceId);
      if (instance === undefined) {
        throw new Error(`unknown instance id: ${instanceId}`);
      }
      return {
        HDSL_DATA_ROOT: dataRoot,
        HOME: instance.home,
        DSH_HOME: instance.dshHome,
        XDG_CONFIG_HOME: join(instance.home, '.config'),
        XDG_DATA_HOME: join(instance.home, '.local', 'share'),
        XDG_CACHE_HOME: join(instance.home, '.cache'),
        XDG_STATE_HOME: join(instance.home, '.local', 'state'),
        TMPDIR: join(instance.root, 'tmp'),
        USERPROFILE: instance.home,
        APPDATA: join(instance.home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(instance.home, 'AppData', 'Local'),
      };
    },
    cleanup: () => registry.cleanup(),
  };
};

export interface HostGuardSnapshot {
  readonly path: string;
  readonly entries: readonly TreeEntry[];
}

/**
 * Read-only snapshot of locations a managed launcher must not write when a
 * managed dataRoot is configured: the upstream default `~/.dsh` and the
 * conventional HDSL app-data directories (see `docs/architecture/tdd.md`).
 */
export const HOST_GUARD_PATHS: readonly string[] = [
  join(homedir(), '.dsh'),
  join(homedir(), '.config', 'hdsl'),
  join(homedir(), '.config', 'HDSL'),
  join(homedir(), 'Library', 'Application Support', 'HDSL'),
  join(homedir(), 'Library', 'Application Support', 'hdsl'),
];

export const captureHostGuard = (): readonly HostGuardSnapshot[] =>
  HOST_GUARD_PATHS.map((path) => ({ path, entries: snapshotTree(path) }));
