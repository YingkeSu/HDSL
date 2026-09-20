/**
 * One real managed install, reused as an isolated clone fixture.
 *
 * The injected-path tests all need an existing stopped environment. Creating one
 * costs a real network install (Node + DSH closure), so it is performed exactly
 * once and then copied into a fresh `hdsl-e2e-*` dataRoot per test. The copy is
 * still a real dataRoot written by the candidate; only the second and later
 * installs are avoided. The install itself remains a real install, not a
 * synthetic tarball.
 */
import { cpSync } from 'node:fs';

import { launchDesktopApp } from './electron-app.js';
import type { QaResourceRegistry } from './resources.js';
import { callContract, pollContract, waitForRender } from './desktop-ui.js';

export interface PreparedEnvironment {
  readonly dataRoot: string;
  readonly environmentId: string;
}

export const prepareEnvironment = async (
  registry: QaResourceRegistry,
  label: string,
  name: string,
  combinationId: string,
): Promise<PreparedEnvironment> => {
  const app = await launchDesktopApp({ registry, label });
  try {
    const cdp = await app.connect();
    await waitForRender(cdp);
    const created = await callContract(cdp, 'environments.create', {
      requestId: `${label}-create`,
      name,
      catalogCombinationId: combinationId,
    });
    if (!created.ok) {
      throw new Error(`${label}: environments.create failed: ${JSON.stringify(created)}`);
    }
    const ready = await pollContract(
      cdp,
      'environments.list',
      {},
      (envelope) =>
        Array.isArray(envelope.value) &&
        (envelope.value as readonly { name?: string; state?: string }[]).some(
          (entry) => entry.name === name && entry.state === 'stopped',
        ),
      { timeoutMs: 20 * 60_000, intervalMs: 2_000, label: `${label} environment stopped` },
    );
    const environment = (
      ready.value as readonly { id: string; name: string; state: string }[]
    ).find((entry) => entry.name === name);
    if (environment === undefined) {
      throw new Error(`${label}: environment ${name} not found after create`);
    }
    await cdp.close();
    return { dataRoot: app.dataRoot, environmentId: environment.id };
  } finally {
    await app.kill();
  }
};

/** Copies a prepared dataRoot into a fresh registered temp root. */
export const clonePreparedDataRoot = (
  registry: QaResourceRegistry,
  prepared: PreparedEnvironment,
  label: string,
): string => {
  const root = registry.registerTempRoot(label);
  cpSync(prepared.dataRoot, root, { recursive: true });
  return root;
};
