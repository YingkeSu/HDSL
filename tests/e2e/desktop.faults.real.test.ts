/**
 * T007 S5 — real managed-process unexpected exit observed through the
 * production Electron UI (opt-in, issue #7).
 *
 * Gap this closes (T007 phase-1 audit): FR-005/FR-006 "operation phase, terminal
 * result and retryable state" was only proven on the real UI for the happy
 * start/stop path (`E2E-GUI-START-STOP-01`); the real failure boundary
 * (`PROCESS_EXITED`) existed only in unit-level `createProcessManager` tests.
 *
 * This lane kills the *real* managed DSH process (SIGKILL, no shell) after the
 * environment reaches `运行中` in the production UI, then asserts the persisted
 * environment state converges to `stopped` within a bounded time.
 *
 * Known product gap (registered as #108, not fixed here): the
 * production renderer only polls while an operation is in flight, so the
 * unexpected exit is *not* pushed to the UI and the label can stay `运行中` until
 * the user refreshes. The lane records the observed renderer label as evidence
 * but does not assert it.
 *
 * Credential setup is the same setup injection as the GUI lane: a self-built
 * random keychain canary through the macOS `security` CLI (secret via stdin,
 * deleted in `finally`) written as reference-only config through the reviewed
 * core interface. It is **not** the native menu path and makes **no** model call.
 *
 * `PORT_UNAVAILABLE` / `START_TIMEOUT` are intentionally *not* driven here: the
 * production UI does not expose an injectable pinned port or readiness timeout,
 * and this lane must not add a product backdoor to force them. Those remain
 * recorded as untested for the real UI in the FR mapping.
 *
 * Opt-in with `HDSL_E2E_FAULTS=1`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
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

describe.skipIf(!ENABLED)('desktop real managed-process exit lane', () => {
  const setupRegistry = new QaResourceRegistry();
  const service = `hdsl-qa-24-faults-${randomBytes(6).toString('hex')}`;
  const account = 't007';
  const canary = `hdsl-qa-canary-${randomBytes(12).toString('hex')}`;
  let keychainCreated = false;

  afterAll(async () => {
    await setupRegistry.cleanup().catch(() => undefined);
    if (keychainCreated) {
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
    }
  });

  afterEach(cleanupAllHarnesses);

  it('E2E-FAULT-EXIT-01: killing the managed process converges the persisted state to stopped', async () => {
    expect(
      await runSecurity(
        ['add-generic-password', '-a', account, '-s', service, '-w'],
        `${canary}\n${canary}\n`,
      ),
    ).toBe(0);
    keychainCreated = true;

    const prepared: PreparedEnvironment = await prepareEnvironment(
      setupRegistry,
      'faults-prep',
      'qa-faults-env',
      COMBINATION,
    );

    // Setup injection through the reviewed core interface (not the native menu).
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

    const harness = appHarness();
    const { cdp } = await bootApp(harness, 'faults01', { dataRoot: prepared.dataRoot });
    try {
      await pollContract(
        cdp,
        'environments.list',
        {},
        (envelope) =>
          Array.isArray(envelope.value) &&
          (envelope.value as readonly { id?: string }[]).some(
            (entry) => entry.id === prepared.environmentId,
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

      const pid = readManagedPid(prepared.dataRoot, prepared.environmentId);
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
            (entry) => entry.id === prepared.environmentId && entry.state === 'stopped',
          ),
        { timeoutMs: 60_000, intervalMs: 500, label: 'contract confirms stopped after the exit' },
      );
      expect(final.ok).toBe(true);
      expect(isProcessAlive(pid)).toBe(false);

      // Observability only: the renderer only polls while an operation is in
      // flight, so an exit with no operation is not pushed to the UI. This is
      // tracked as an independent product defect (see issue referenced in
      // docs/development/testing.md); the lane must not fail on it here.
      const uiLabel = await environmentStateLabel(cdp);
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
});
