/**
 * T007 S5 — real managed-process fault boundaries observed through the
 * production Electron UI (opt-in, issue #7).
 *
 * Two real production boundaries live here, both starting from a real managed
 * install and the production entry (no product injection, no test-only hook):
 *
 * 1. `E2E-FAULT-EXIT-01` — kill the *real* managed DSH process (SIGKILL, no
 *    shell) after the environment reaches `运行中`, then assert:
 *      - production core converges the persisted state to `stopped`
 *        (`environments.list`), and
 *      - the real renderer converges to `已停止` without a manual refresh.
 *    The renderer half is the fix for issue #108 (`environment.updated` push,
 *    ADR 0008). Before that fix the label stayed `运行中` until refresh; this
 *    lane now asserts convergence through the real production push channel, not
 *    a harness substitute.
 *
 * 2. `E2E-APP-CRASH-RESTART-01` — crash the *launcher* (SIGKILL the Electron
 *    main process) while a managed DSH is running, then relaunch the production
 *    app against the same dataRoot. The detached DSH survives; the new instance
 *    must take over the stale dataRoot lease, adopt the still-live process via
 *    `recover()` (ownership re-verified by pid + start token), project the
 *    adopted state to the real UI as `运行中`, and then stop it through the real
 *    stop button. This exercises FR-008 at the application boundary; the
 *    manager-level adoption is separately covered in
 *    `tests/integration/process/two-environments.real.test.ts`.
 *
 * Credential setup is the same setup injection as the GUI lane: a self-built
 * random keychain canary through the macOS `security` CLI (secret via stdin,
 * deleted in `finally`) written as reference-only config through the reviewed
 * core interface. It is **not** the native menu path and makes **no** model call.
 *
 * `PORT_UNAVAILABLE` / `START_TIMEOUT` are intentionally *not* driven here: the
 * production UI only ever starts the managed DSH with `--port 0` (OS-assigned)
 * and a fixed internal readiness budget, so neither terminal code is reachable
 * through a product entry. Issue #123 decided to exclude both from first-slice
 * real-UI acceptance (no test-only product hook); the acceptance surface is the
 * deterministic D-layer/contract coverage plus the renderer's controlled-code
 * rendering. This lane must not fake them.
 *
 * Opt-in with `HDSL_E2E_FAULTS=1`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isProcessAlive } from '@hdsl/runtime';

import { createDesktopComposition } from '../../apps/desktop/src/main/composition.js';
import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';
import {
  buttonByText,
  clickButtonByText,
  environmentStateLabel,
  pollContract,
} from './support/desktop-ui.js';
import { waitFor } from './support/gates.js';
import { prepareEnvironment, type PreparedEnvironment } from './support/prepared-environment.js';
import { QaResourceRegistry } from './support/resources.js';

const ENABLED = process.env['HDSL_E2E_FAULTS'] === '1';
const SECURITY = '/usr/bin/security';
const COMBINATION = 'darwin-arm64-node22_19_0-dsh0_1_5-rc_2';
const RESTART_DETACH_WAIT_MS = 3_000;

const runSecurity = async (args: readonly string[], input: string): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const child = spawn(SECURITY, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('security CLI did not answer'));
    }, 10_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.stdin.write(input);
    child.stdin.end();
  });

const readManagedPid = (dataRoot: string, environmentId: string): number | undefined => {
  try {
    const record = JSON.parse(
      readFileSync(join(dataRoot, 'process', 'launches', `${environmentId}.json`), 'utf8'),
    ) as { readonly identity?: { readonly pid?: number } | null };
    return record.identity?.pid;
  } catch {
    return undefined;
  }
};

/**
 * Writes the reference-only credential config through the reviewed core
 * interface (not the native menu) into a prepared dataRoot.
 */
const writeSetupCredentials = async (
  prepared: PreparedEnvironment,
  service: string,
  account: string,
): Promise<void> => {
  const composition = await createDesktopComposition({
    dataRoot: prepared.dataRoot,
    appInfo: {
      name: 'HDSL',
      version: '0.0.0',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: 'n/a',
    },
    openWebUi: async () => ({
      ok: false,
      code: 'WEBUI_UNAVAILABLE',
      message: 'not used in this lane',
    }),
    lockWaitTimeoutMs: 5_000,
  });
  try {
    expect(composition.available).toBe(true);
    const environment = composition.port.findEnvironment(prepared.environmentId);
    expect(environment.ok).toBe(true);
    if (!environment.ok) {
      return;
    }
    const written = composition.service.writeEnvironmentCredentials({
      environmentId: environment.value.id,
      bindings: [
        {
          name: 'DEEPSEEK_API_KEY',
          reference: { id: 'qa-faults', store: 'keychain', key: `${service}#${account}` },
        },
      ],
      expectedRevision: environment.value.revision,
    });
    expect(written.ok, `credential setup failed: ${written.ok ? 'ok' : written.code}`).toBe(true);
  } finally {
    await composition.close().catch(() => undefined);
  }
};

describe.skipIf(!ENABLED)('desktop real managed-process fault boundaries', () => {
  const setupRegistry = new QaResourceRegistry();
  const service = `hdsl-qa-24-faults-${randomBytes(6).toString('hex')}`;
  const account = 't007';
  const canary = `hdsl-qa-canary-${randomBytes(12).toString('hex')}`;

  let preparedExit: PreparedEnvironment;
  let preparedRestart: PreparedEnvironment;

  beforeAll(async () => {
    // One real install each; the two lanes kill different actors, so each gets
    // its own dataRoot and no lane can leak state into the other.
    preparedExit = await prepareEnvironment(
      setupRegistry,
      'faults-prep',
      'qa-faults-env',
      COMBINATION,
    );
    preparedRestart = await prepareEnvironment(
      setupRegistry,
      'restart-prep',
      'qa-restart-env',
      COMBINATION,
    );
    expect(
      await runSecurity(
        ['add-generic-password', '-a', account, '-s', service, '-w'],
        `${canary}\n${canary}\n`,
      ),
    ).toBe(0);
    await writeSetupCredentials(preparedExit, service, account);
    await writeSetupCredentials(preparedRestart, service, account);
  }, 40 * 60_000);

  afterAll(async () => {
    // Secret hygiene first: remove the keychain canary and prove it is gone
    // before the (potentially slow) removal of the two real install trees.
    const deleted = await runSecurity(
      ['delete-generic-password', '-s', service, '-a', account],
      '',
    ).catch(() => -1);
    expect(deleted, 'keychain canary deletion must succeed').toBe(0);
    const stillThere = await runSecurity(
      ['find-generic-password', '-s', service, '-a', account],
      '',
    ).catch(() => -1);
    expect(stillThere, 'keychain canary must report errSecItemNotFound (44) after deletion').toBe(
      44,
    );
    const report = await setupRegistry.cleanup();
    expect(report.failed, JSON.stringify(report.failed)).toEqual([]);
  }, 10 * 60_000);

  afterEach(cleanupAllHarnesses);

  it('E2E-FAULT-EXIT-01: killing the managed process converges the real UI to stopped', async () => {
    const harness = appHarness();
    const { cdp } = await bootApp(harness, 'faults01', { dataRoot: preparedExit.dataRoot });
    try {
      await pollContract(
        cdp,
        'environments.list',
        {},
        (envelope) =>
          Array.isArray(envelope.value) &&
          (envelope.value as readonly { id?: string }[]).some(
            (entry) => entry.id === preparedExit.environmentId,
          ),
        { timeoutMs: 20_000, intervalMs: 250, label: 'environment listed in the real UI' },
      );

      await waitFor(
        async () => {
          const button = await buttonByText(cdp, '启动环境');
          return button !== null && !button.disabled;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'start button enabled' },
      );
      await clickButtonByText(cdp, '启动环境');
      await waitFor(async () => (await environmentStateLabel(cdp)) === '运行中', {
        timeoutMs: 3 * 60_000,
        intervalMs: 500,
        label: 'environment running in the real UI',
      });

      const pid = readManagedPid(preparedExit.dataRoot, preparedExit.environmentId);
      expect(pid, 'the production launch record must carry the managed pid').toBeTypeOf('number');
      if (pid === undefined) {
        return;
      }
      expect(isProcessAlive(pid)).toBe(true);

      // Real unexpected exit: SIGKILL the managed leader directly (no shell).
      process.kill(pid, 'SIGKILL');
      await waitFor(() => !isProcessAlive(pid), { timeoutMs: 10_000, label: 'managed pid gone' });

      // FR-005 real boundary: production core must converge the persisted
      // environment state to `stopped` after the managed process dies.
      const final = await pollContract(
        cdp,
        'environments.list',
        {},
        (envelope) =>
          Array.isArray(envelope.value) &&
          (envelope.value as readonly { id?: string; state?: string }[]).some(
            (entry) => entry.id === preparedExit.environmentId && entry.state === 'stopped',
          ),
        { timeoutMs: 60_000, intervalMs: 500, label: 'contract confirms stopped after the exit' },
      );
      expect(final.ok).toBe(true);
      expect(isProcessAlive(pid)).toBe(false);

      // FR-005/FR-006 renderer half (#108 / ADR 0008): the production
      // `environment.updated` push must converge the label without a refresh.
      // This is the real UI assertion, not a harness observation.
      await waitFor(async () => (await environmentStateLabel(cdp)) === '已停止', {
        timeoutMs: 30_000,
        intervalMs: 250,
        label: 'real renderer converges to stopped after the unexpected exit',
      });
      const uiLabel = await environmentStateLabel(cdp);
      expect(uiLabel).toBe('已停止');

      // eslint-disable-next-line no-console
      console.log(
        `HDSL_T007_FAULT_EXIT_EVIDENCE ${JSON.stringify(
          { managedPid: pid, contractState: 'stopped', rendererLabelAfterExit: uiLabel },
          null,
          2,
        )}`,
      );
    } finally {
      await cleanupAllHarnesses();
    }
  }, 20 * 60_000);

  it('E2E-APP-CRASH-RESTART-01: relaunch adopts the surviving managed process and stops it', async () => {
    const harness = appHarness();
    const first = await bootApp(harness, 'restart01a', { dataRoot: preparedRestart.dataRoot });
    try {
      await pollContract(
        first.cdp,
        'environments.list',
        {},
        (envelope) =>
          Array.isArray(envelope.value) &&
          (envelope.value as readonly { id?: string }[]).some(
            (entry) => entry.id === preparedRestart.environmentId,
          ),
        { timeoutMs: 20_000, intervalMs: 250, label: 'environment listed before the crash' },
      );
      await waitFor(
        async () => {
          const button = await buttonByText(first.cdp, '启动环境');
          return button !== null && !button.disabled;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'start button enabled' },
      );
      await clickButtonByText(first.cdp, '启动环境');
      await waitFor(async () => (await environmentStateLabel(first.cdp)) === '运行中', {
        timeoutMs: 3 * 60_000,
        intervalMs: 500,
        label: 'environment running before the crash',
      });

      const pid = readManagedPid(preparedRestart.dataRoot, preparedRestart.environmentId);
      expect(pid, 'the production launch record must carry the managed pid').toBeTypeOf('number');
      if (pid === undefined) {
        return;
      }
      expect(isProcessAlive(pid)).toBe(true);

      // Crash the launcher, not the managed process: the detached DSH survives
      // and its launch record/endpoint stay on disk for the next instance.
      await first.app.kill('SIGKILL');
      expect(first.app.isRunning()).toBe(false);
      // The stale dataRoot lease is only reclaimable after `staleAfterMs`
      // (2s) since its last heartbeat; wait past it before the relaunch.
      await new Promise((resolve) => {
        setTimeout(resolve, RESTART_DETACH_WAIT_MS);
      });
      expect(isProcessAlive(pid), 'the detached managed process must survive the launcher crash').toBe(
        true,
      );

      // Relaunch the real production app against the same dataRoot.
      const second = await bootApp(harness, 'restart01b', { dataRoot: preparedRestart.dataRoot });

      // FR-008: the new instance takes over the lease, re-verifies ownership and
      // adopts the still-live process (state `running`, same pid, no respawn).
      await pollContract(
        second.cdp,
        'environments.list',
        {},
        (envelope) =>
          Array.isArray(envelope.value) &&
          (envelope.value as readonly { id?: string; state?: string }[]).some(
            (entry) => entry.id === preparedRestart.environmentId && entry.state === 'running',
          ),
        { timeoutMs: 3 * 60_000, intervalMs: 500, label: 'restarted app adopts the running process' },
      );
      await waitFor(async () => (await environmentStateLabel(second.cdp)) === '运行中', {
        timeoutMs: 30_000,
        intervalMs: 250,
        label: 'adopted state rendered in the relaunched UI',
      });
      const adoptedPid = readManagedPid(preparedRestart.dataRoot, preparedRestart.environmentId);
      expect(adoptedPid, 'adoption must keep the same managed pid (no respawn)').toBe(pid);
      expect(isProcessAlive(pid)).toBe(true);

      // The relaunched instance now owns the process and can stop it for real.
      await waitFor(
        async () => {
          const button = await buttonByText(second.cdp, '停止');
          return button !== null && !button.disabled;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'stop button enabled after adoption' },
      );
      await clickButtonByText(second.cdp, '停止');
      await waitFor(async () => (await environmentStateLabel(second.cdp)) === '已停止', {
        timeoutMs: 90_000,
        intervalMs: 500,
        label: 'environment stopped through the relaunched UI',
      });
      await waitFor(() => !isProcessAlive(pid), {
        timeoutMs: 20_000,
        label: 'adopted managed process gone after the real stop',
      });

      // eslint-disable-next-line no-console
      console.log(
        `HDSL_T007_RESTART_EVIDENCE ${JSON.stringify(
          {
            managedPid: pid,
            resolution: 'adopted-after-launcher-crash',
            rendererLabelAfterRestart: '运行中',
            finalState: 'stopped',
          },
          null,
          2,
        )}`,
      );
    } finally {
      await cleanupAllHarnesses();
    }
  }, 40 * 60_000);
});
