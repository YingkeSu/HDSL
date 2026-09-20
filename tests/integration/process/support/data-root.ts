/**
 * Dual-instance `dataRoot` fixture and dedicated QA canary credentials.
 *
 * T005a (#43) must make cross-process use of one `dataRoot` exclusive while
 * keeping each instance's environment home separate. This fixture builds two
 * instance roots that share a single `dataRoot` and gives each a distinct,
 * clearly-fake canary secret in its own DSH home, so a scenario can prove
 * instance A never reads B's secret and neither instance writes the host home.
 *
 * A canary is only ever a fixture value (`hdsl-qa-canary-<uuid>`); no real OS
 * credential, API key or user HOME entry is read or written.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempRoot, type TempRoot } from './isolation.js';

export interface InstanceDescriptor {
  readonly id: string;
  readonly root: string;
  readonly home: string;
  readonly dshHome: string;
  readonly canaryFile: string;
  readonly canaryValue: string;
  /** Marker written into this instance's home to detect cross-instance reads. */
  readonly markerFile: string;
}

export interface DualInstanceFixture {
  readonly root: TempRoot;
  readonly sharedDataRoot: string;
  readonly instanceA: InstanceDescriptor;
  readonly instanceB: InstanceDescriptor;
  /** Environment for spawning exactly one instance against the shared dataRoot. */
  envFor(instance: InstanceDescriptor): Record<string, string>;
  readCanary(instance: InstanceDescriptor): string | undefined;
  cleanup(): void;
}

const buildInstance = (root: string, id: string): InstanceDescriptor => {
  const instanceRoot = join(root, id);
  const home = join(instanceRoot, 'home');
  const dshHome = join(instanceRoot, 'dsh-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(dshHome, { recursive: true });
  const canaryValue = `hdsl-qa-canary-${randomUUID()}`;
  const canaryFile = join(dshHome, '.credentials.yaml');
  writeFileSync(canaryFile, `token: ${canaryValue}\n`, { mode: 0o600 });
  chmodSync(canaryFile, 0o600);
  const markerFile = join(home, `${id}-marker.txt`);
  writeFileSync(markerFile, `owner=${id}\n`);
  return { id, root: instanceRoot, home, dshHome, canaryFile, canaryValue, markerFile };
};

export const createDualInstanceFixture = (label = 'dataroot'): DualInstanceFixture => {
  const root = createTempRoot(label);
  const sharedDataRoot = join(root.path, 'data-root');
  mkdirSync(sharedDataRoot, { recursive: true });
  const instanceA = buildInstance(root.path, 'instance-a');
  const instanceB = buildInstance(root.path, 'instance-b');
  return {
    root,
    sharedDataRoot,
    instanceA,
    instanceB,
    envFor: (instance) => ({
      HOME: instance.home,
      DSH_HOME: instance.dshHome,
      HDSL_DATA_ROOT: sharedDataRoot,
      // Keep every XDG/cache root inside the instance so the host is untouched.
      XDG_CONFIG_HOME: join(instance.home, '.config'),
      XDG_DATA_HOME: join(instance.home, '.local', 'share'),
      XDG_CACHE_HOME: join(instance.home, '.cache'),
      XDG_STATE_HOME: join(instance.home, '.local', 'state'),
    }),
    readCanary: (instance) =>
      existsSync(instance.canaryFile) ? readFileSync(instance.canaryFile, 'utf8') : undefined,
    cleanup: () => root.cleanup(),
  };
};

/**
 * A one-shot file gate for deterministic dual-process ordering: one side
 * `open()`s it, the other `waitFor` it. No sleeps are involved.
 */
export interface FileGate {
  readonly path: string;
  open(): void;
  isOpen(): boolean;
}

export const createFileGate = (path: string): FileGate => ({
  path,
  open: () => writeFileSync(path, `${Date.now()}\n`),
  isOpen: () => existsSync(path),
});
