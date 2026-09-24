/**
 * T007 — real-UI main flow: create -> start -> stop (opt-in, issue #7).
 *
 * Gap this closes (from the T007 acceptance audit):
 * - the existing lanes cover the first-slice journey only piecewise:
 *   `E2E-CREATE-01` creates through the real UI and stops at `stopped`, while
 *   `E2E-GUI-START-STOP-01` starts/stops a *prepared* environment whose
 *   credentials were injected before boot. No single lane drives
 *   create -> start -> stop on one real dataRoot, which is the coverage-matrix
 *   "用户主流程" row and the planned `E2E-UI-01` journey.
 *
 * What runs here (real, bounded, no model call):
 * - the production Electron entry on a registered `hdsl-e2e-*` temp dataRoot;
 * - a keyboard-only create (real dialog, real focus/Tab/Enter) that performs a
 *   real managed `npm ci` install;
 * - a credential reference is added only after the create, because the create
 *   lock is exclusive: the app is stopped, the reference is written through the
 *   reviewed core interface, and the production app is relaunched on the same
 *   dataRoot (setup injection, **not** the native menu — see below);
 * - real mouse clicks on `启动环境` / `停止` with the rendered operation panel
 *   and the rendered `运行中` / `已停止` terminal labels, plus the frozen
 *   contract state as the independent check.
 *
 * Credential setup is the same setup injection as the GUI/fault lanes: a
 * self-built random keychain canary through the macOS `security` CLI (secret
 * via stdin, deleted in `finally`) written as reference-only config through the
 * reviewed core interface. It is **not** the native menu import and makes **no**
 * model call.
 *
 * Opt-in with `HDSL_E2E_MAIN_FLOW=1`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createDesktopComposition } from '../../apps/desktop/src/main/composition.js';
import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';
import {
  activeElement,
  buttonByText,
  clickButtonByText,
  domDisabled,
  domExists,
  domValue,
  environmentStateLabel,
  focusSelector,
  openCreateForm,
  operationPanelText,
  pollContract,
} from './support/desktop-ui.js';
import { waitFor } from './support/gates.js';
import type { PreparedEnvironment } from './support/prepared-environment.js';
import { QaResourceRegistry } from './support/resources.js';

const ENABLED = process.env['HDSL_E2E_MAIN_FLOW'] === '1';
const SECURITY = '/usr/bin/security';
const ENVIRONMENT_NAME = 'qa-main-flow-env';

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

/**
 * Writes the reference-only credential config through the reviewed core
 * interface (not the native menu) into the created dataRoot.
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
          reference: { id: 'qa-main-flow', store: 'keychain', key: `${service}#${account}` },
        },
      ],
      expectedRevision: environment.value.revision,
    });
    expect(written.ok, `credential setup failed: ${written.ok ? 'ok' : written.code}`).toBe(true);
  } finally {
    await composition.close().catch(() => undefined);
  }
};

describe.skipIf(!ENABLED)('desktop real-UI main flow (create -> start -> stop)', () => {
  const setupRegistry = new QaResourceRegistry();
  const service = `hdsl-qa-t007-main-${randomBytes(6).toString('hex')}`;
  const account = 't007';
  const canary = `hdsl-qa-canary-${randomBytes(12).toString('hex')}`;

  it('E2E-MAIN-FLOW-01: creates through the UI, then starts and stops the same environment', async () => {
    const harness = appHarness();
    let keychainCreated = false;
    try {
      expect(
        await runSecurity(
          ['add-generic-password', '-a', account, '-s', service, '-w'],
          `${canary}\n${canary}\n`,
        ),
      ).toBe(0);
      keychainCreated = true;

      // 1) Create through the real production UI (keyboard only).
      const { app, cdp } = await bootApp(harness, 'mainflow01a');
      let environmentId: string;
      try {
        await openCreateForm(cdp);
        await waitFor(async () => !(await domDisabled(cdp, '#create-name')), {
          timeoutMs: 15_000,
          label: 'create form enabled',
        });
        await focusSelector(cdp, '#create-name');
        expect((await activeElement(cdp)).id).toBe('create-name');
        await cdp.typeText(ENVIRONMENT_NAME);
        expect(await domValue(cdp, '#create-name')).toBe(ENVIRONMENT_NAME);
        // Tab: name -> combination select (already holding the first verified
        // combination) -> submit button; Enter activates the focused button.
        await cdp.pressKey('Tab');
        expect((await activeElement(cdp)).id).toBe('create-combination');
        const combinationId = await domValue(cdp, '#create-combination');
        expect(combinationId).not.toBe('');
        await cdp.pressKey('Tab');
        expect((await activeElement(cdp)).tag).toBe('BUTTON');
        await cdp.pressKey('Enter');

        // Fast gate: an accepted create closes the dialog, so a keyboard
        // no-op cannot silently wait out the whole install timeout.
        await waitFor(async () => !(await domExists(cdp, 'dialog[open]')), {
          timeoutMs: 30_000,
          label: 'create accepted (dialog closed)',
        });

        const created = await pollContract(
          cdp,
          'environments.list',
          {},
          (envelope) =>
            Array.isArray(envelope.value) &&
            (envelope.value as readonly { name?: string; state?: string }[]).some(
              (entry) => entry.name === ENVIRONMENT_NAME && entry.state === 'stopped',
            ),
          { timeoutMs: 20 * 60_000, intervalMs: 2_000, label: 'environment created' },
        );
        const environment = (
          created.value as readonly { id: string; name: string; state: string }[]
        ).find((entry) => entry.name === ENVIRONMENT_NAME);
        expect(environment, 'the UI create must yield a stopped environment').toBeDefined();
        if (environment === undefined) {
          return;
        }
        environmentId = environment.id;
      } finally {
        // Release the exclusive dataRoot lock before the setup injection.
        await app.kill().catch(() => undefined);
      }

      // 2) Credential setup injection (not the native menu) on the same root.
      await writeSetupCredentials(
        { dataRoot: app.dataRoot, environmentId },
        service,
        account,
      );

      // 3) Relaunch the production app on the same dataRoot and drive the real
      // start/stop. The environment must be selected in the detail panel before
      // the state label/buttons are observable.
      const { cdp: flowCdp } = await bootApp(harness, 'mainflow01b', {
        dataRoot: app.dataRoot,
      });
      await pollContract(
        flowCdp,
        'environments.list',
        {},
        (envelope) =>
          Array.isArray(envelope.value) &&
          (envelope.value as readonly { id?: string }[]).some(
            (entry) => entry.id === environmentId,
          ),
        { timeoutMs: 20_000, intervalMs: 250, label: 'created environment listed after relaunch' },
      );
      await waitFor(async () => (await environmentStateLabel(flowCdp)) === '已停止', {
        timeoutMs: 20_000,
        intervalMs: 250,
        label: 'initial stopped state rendered',
      });

      await waitFor(
        async () => {
          const button = await buttonByText(flowCdp, '启动环境');
          return button !== null && !button.disabled;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'start button enabled' },
      );
      await clickButtonByText(flowCdp, '启动环境');
      await waitFor(async () => (await operationPanelText(flowCdp)).includes('启动'), {
        timeoutMs: 30_000,
        intervalMs: 250,
        label: 'start operation visible in the panel',
      });
      await waitFor(async () => (await environmentStateLabel(flowCdp)) === '运行中', {
        timeoutMs: 3 * 60_000,
        intervalMs: 500,
        label: 'environment running in the real UI',
      });
      expect((await operationPanelText(flowCdp)).length).toBeGreaterThan(0);

      await waitFor(
        async () => {
          const button = await buttonByText(flowCdp, '停止');
          return button !== null && !button.disabled;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'stop button enabled' },
      );
      await clickButtonByText(flowCdp, '停止');
      await waitFor(async () => (await environmentStateLabel(flowCdp)) === '已停止', {
        timeoutMs: 90_000,
        intervalMs: 500,
        label: 'environment stopped in the real UI',
      });

      // Independent check through the frozen contract (not the rendered label).
      const final = await pollContract(
        flowCdp,
        'environments.list',
        {},
        (envelope) =>
          Array.isArray(envelope.value) &&
          (envelope.value as readonly { id?: string; state?: string }[]).some(
            (entry) => entry.id === environmentId && entry.state === 'stopped',
          ),
        { timeoutMs: 20_000, intervalMs: 250, label: 'contract confirms stopped' },
      );
      expect(final.ok).toBe(true);

      // eslint-disable-next-line no-console
      console.log(
        `HDSL_T007_MAIN_FLOW_EVIDENCE ${JSON.stringify(
          {
            environmentId,
            createdState: 'stopped',
            credentialSetup: 'setup-injection (not native menu)',
            appRestartForCredentialSetup: true,
            runningLabel: '运行中',
            stoppedLabel: '已停止',
            finalContractState: 'stopped',
          },
          null,
          2,
        )}`,
      );
    } finally {
      await cleanupAllHarnesses();
      if (keychainCreated) {
        const deleted = await runSecurity(
          ['delete-generic-password', '-s', service, '-a', account],
          '',
        ).catch(() => -1);
        expect(deleted, 'keychain canary deletion must succeed').toBe(0);
        // macOS `security` returns exactly 44 (errSecItemNotFound) when absent;
        // any other non-zero must not be read as "absent".
        const stillThere = await runSecurity(
          ['find-generic-password', '-s', service, '-a', account],
          '',
        ).catch(() => -1);
        expect(
          stillThere,
          'keychain canary must report errSecItemNotFound (44) after deletion',
        ).toBe(44);
      }
      await setupRegistry.cleanup().catch(() => undefined);
    }
  }, 40 * 60_000);
});
