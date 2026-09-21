/**
 * Real GUI start/stop lane (production React UI, setup injection for credentials).
 *
 * Independent QA (hdsl-25). Credential setup is a **setup injection**: the
 * reference record is written through the already-reviewed core interface
 * (`EnvironmentService.writeEnvironmentCredentials`) directly into the isolated
 * dataRoot, and a self-built random keychain canary is created via the macOS
 * `security` CLI (secret through stdin, deleted in `finally`). This is **not**
 * the native menu import and does not claim that path.
 *
 * The start/stop actions themselves are real: the production entry renders the
 * real React UI and the test clicks the real `启动` / `停止` buttons with CDP
 * mouse events, then observes the real operation panel phase and the rendered
 * environment state. No credential-less native prompt is involved because the
 * reference is present.
 *
 * Opt-in with `HDSL_E2E_GUI=1`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createDesktopComposition } from '../../apps/desktop/src/main/composition.js';
import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';
import {
  buttonByText,
  clickButtonByText,
  environmentStateLabel,
  operationPanelText,
  pollContract,
} from './support/desktop-ui.js';
import { waitFor } from './support/gates.js';
import { prepareEnvironment, type PreparedEnvironment } from './support/prepared-environment.js';
import { QaResourceRegistry } from './support/resources.js';

const ENABLED = process.env['HDSL_E2E_GUI'] === '1';
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

describe.skipIf(!ENABLED)('desktop GUI start/stop (production UI, injected credential setup)', () => {
  it('E2E-GUI-START-STOP-01: real click start then stop, with progress and terminal states', async () => {
    const setupRegistry = new QaResourceRegistry();
    const service = `hdsl-qa-24-gui-${randomBytes(6).toString('hex')}`;
    const account = 't006';
    const canary = `hdsl-qa-canary-${randomBytes(12).toString('hex')}`;
    let keychainCreated = false;
    let prepared: PreparedEnvironment;
    try {
      expect(
        await runSecurity(['add-generic-password', '-a', account, '-s', service, '-w'], `${canary}\n${canary}\n`),
      ).toBe(0);
      keychainCreated = true;

      prepared = await prepareEnvironment(setupRegistry, 'gui-prep', 'qa-gui-env', COMBINATION);

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
        openWebUi: async () => ({ ok: false, code: 'WEBUI_UNAVAILABLE', message: 'not used in this lane' }),
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
              reference: { id: 'qa-gui', store: 'keychain', key: `${service}#${account}` },
            },
          ],
          expectedRevision: environment.value.revision,
        });
        expect(written.ok, `credential setup failed: ${written.ok ? 'ok' : written.code}`).toBe(true);
      } finally {
        await composition.close().catch(() => undefined);
      }

      // Real production UI on the prepared dataRoot.
      const harness = appHarness();
      try {
        const { app, cdp } = await bootApp(harness, 'gui01', { dataRoot: prepared.dataRoot });
        await pollContract(
          cdp,
          'environments.list',
          {},
          (envelope) =>
            Array.isArray(envelope.value) &&
            (envelope.value as readonly { id?: string }[]).some(
              (entry) => entry.id === prepared?.environmentId,
            ),
          { timeoutMs: 20_000, intervalMs: 250, label: 'environment listed in the real UI' },
        );
        await waitFor(async () => (await environmentStateLabel(cdp)) === '已停止', {
          timeoutMs: 20_000,
          label: 'initial stopped state rendered',
        });

        // Real click: start.
        await waitFor(
          async () => {
            const button = await buttonByText(cdp, '启动环境');
            return button !== null && !button.disabled;
          },
          { timeoutMs: 20_000, intervalMs: 250, label: 'start button enabled' },
        );
        await clickButtonByText(cdp, '启动环境');

        // Observe real progress text while starting, then the running terminal state.
        await waitFor(async () => (await operationPanelText(cdp)).includes('启动'), {
          timeoutMs: 30_000,
          intervalMs: 250,
          label: 'start operation visible in the panel',
        });
        await waitFor(async () => (await environmentStateLabel(cdp)) === '运行中', {
          timeoutMs: 3 * 60_000,
          intervalMs: 500,
          label: 'environment running in the real UI',
        });
        const runningText = await operationPanelText(cdp);
        expect(runningText.length).toBeGreaterThan(0);

        // Real click: stop.
        await waitFor(
          async () => {
            const button = await buttonByText(cdp, '停止');
            return button !== null && !button.disabled;
          },
          { timeoutMs: 20_000, intervalMs: 250, label: 'stop button enabled' },
        );
        await clickButtonByText(cdp, '停止');
        await waitFor(async () => (await environmentStateLabel(cdp)) === '已停止', {
          timeoutMs: 90_000,
          intervalMs: 500,
          label: 'environment stopped in the real UI',
        });

        const final = await pollContract(
          cdp,
          'environments.list',
          {},
          (envelope) =>
            Array.isArray(envelope.value) &&
            (envelope.value as readonly { id?: string; state?: string }[]).some(
              (entry) => entry.id === prepared?.environmentId && entry.state === 'stopped',
            ),
          { timeoutMs: 20_000, intervalMs: 250, label: 'contract confirms stopped' },
        );
        expect(final.ok).toBe(true);
        expect(app.isRunning()).toBe(true);
      } finally {
        await cleanupAllHarnesses();
      }
    } finally {
      await setupRegistry.cleanup().catch(() => undefined);
      if (keychainCreated) {
        const deleted = await runSecurity(
          ['delete-generic-password', '-s', service, '-a', account],
          '',
        ).catch(() => -1);
        expect(deleted, 'keychain canary deletion must succeed').toBe(0);
        // macOS `security` returns exactly 44 (errSecItemNotFound) when the item
        // is absent. Any other non-zero (permission/storage failure) must NOT be
        // read as "absent" (review F5).
        const stillThere = await runSecurity(
          ['find-generic-password', '-s', service, '-a', account],
          '',
        ).catch(() => -1);
        expect(stillThere, 'keychain canary must report errSecItemNotFound (44) after deletion').toBe(44);
      }
    }
  }, 20 * 60_000);
});
