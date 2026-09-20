/**
 * Shared launch/cleanup harness for the real desktop E2E suites.
 *
 * Every suite gets isolated `hdsl-e2e-*` temp roots and its own Electron child;
 * cleanup always closes CDP clients, kills the children and releases every
 * registered resource, reporting failures instead of swallowing them.
 */
import type { CdpClient } from './cdp.js';
import { waitForRender } from './desktop-ui.js';
import { launchDesktopApp, type DesktopApp } from './electron-app.js';
import { QaResourceRegistry } from './resources.js';

export interface AppHarness {
  readonly registry: QaResourceRegistry;
  readonly apps: DesktopApp[];
  readonly clients: CdpClient[];
}

export interface BootExtras {
  readonly entry?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extraArgs?: readonly string[];
  readonly cdpPort?: number;
  readonly dataRoot?: string;
  readonly userDataDir?: string;
}

const APP_HARNESSES: AppHarness[] = [];

export const appHarness = (): AppHarness => {
  const harness: AppHarness = { registry: new QaResourceRegistry(), apps: [], clients: [] };
  APP_HARNESSES.push(harness);
  return harness;
};

export const bootApp = async (
  harness: AppHarness,
  label: string,
  extra: BootExtras = {},
): Promise<{ app: DesktopApp; cdp: CdpClient }> => {
  const app = await launchDesktopApp({ registry: harness.registry, label, ...extra });
  harness.apps.push(app);
  const cdp = await app.connect();
  harness.clients.push(cdp);
  await waitForRender(cdp);
  return { app, cdp };
};

export const cleanupAllHarnesses = async (): Promise<void> => {
  const failures: string[] = [];
  for (const harness of APP_HARNESSES.splice(0)) {
    for (const client of harness.clients) {
      await client.close().catch(() => undefined);
    }
    for (const app of harness.apps) {
      await app.kill().catch(() => undefined);
    }
    const report = await harness.registry.cleanup();
    for (const failure of report.failed) {
      failures.push(`${failure.label}: ${failure.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`harness cleanup failed: ${failures.join('; ')}`);
  }
};
