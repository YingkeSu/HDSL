/**
 * Isolated real-browser lane: authenticated WebUI bootstrap DOM (bounded).
 *
 * Independent QA (hdsl-25). This lane uses the candidate's **existing explicit
 * DI** (`createDesktopComposition({ openWebUi })`) with an injected opener that
 * drives an installed Chrome instance on a registered temporary profile over
 * CDP. It is separate from the real `shell.openExternal` path and neither
 * replaces the other.
 *
 * Token handling: the bootstrap URL is handed only to `Page.navigate`; it is
 * never printed, logged, persisted or added to a screenshot. The `Network`
 * domain is never enabled and cookies are never dumped.
 *
 * Authentication is not inferred from page size (review F2): the positive case
 * asserts the rc2 application identity (`DeepSeek Harness` title and the
 * `[data-slot="root"]` app shell with its session chrome), and a negative
 * control opens the loopback origin in a second, cookie-less profile and
 * asserts the authenticated shell is absent.
 *
 * Opt-in with `HDSL_E2E_BROWSER=1`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createVerifiedWebUiOpener } from '../../apps/desktop/src/main/webui.js';
import { createDesktopComposition } from '../../apps/desktop/src/main/composition.js';
import { applyCredentialFile } from '../../apps/desktop/src/main/credential-import.js';
import { appHarness } from './support/app-harness.js';
import { launchChrome, sanitizeForReport } from './support/chrome.js';
import { waitFor } from './support/gates.js';

const ENABLED = process.env['HDSL_E2E_BROWSER'] === '1';
const SECURITY = '/usr/bin/security';
const START_TIMEOUT_MS = 3 * 60_000;

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

const AUTHENTICATED_TITLE = 'DeepSeek Harness';

/** Bootstrap URLs handed to the injected opener; asserted, never printed. */
const handed: string[] = [];

describe.skipIf(!ENABLED)('desktop isolated real-browser lane (opener injection)', () => {
  it('E2E-BROWSER-01: injected opener authenticates through the real browser; a cookie-less profile does not', async () => {
    const harness = appHarness();
    const dataRoot = harness.registry.registerTempRoot('browser-data');
    const service = `hdsl-qa-24-browser-${randomBytes(6).toString('hex')}`;
    const account = 't006';
    const canary = `hdsl-qa-canary-${randomBytes(12).toString('hex')}`;
    let keychainCreated = false;
    let composition: Awaited<ReturnType<typeof createDesktopComposition>> | undefined;
    const secrets = [canary];
    try {
      expect(
        await runSecurity(['add-generic-password', '-a', account, '-s', service, '-w'], `${canary}\n${canary}\n`),
      ).toBe(0);
      keychainCreated = true;

      const importFile = join(dataRoot, 'credential-import.json');
      mkdirSync(dataRoot, { recursive: true });
      writeFileSync(
        importFile,
        `${JSON.stringify(
          {
            schemaVersion: '1',
            bindings: [
              {
                name: 'DEEPSEEK_API_KEY',
                reference: { id: 'qa-browser', store: 'keychain', key: `${service}#${account}` },
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      const browser = await launchChrome(harness.registry, 'browser01');
      composition = await createDesktopComposition({
        dataRoot,
        appInfo: {
          name: 'HDSL',
          version: '0.0.0',
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          electron: 'n/a',
        },
        openWebUi: createVerifiedWebUiOpener(async (url) => {
          handed.push(url);
          await browser.cdp.send('Page.navigate', { url });
        }),
        lockWaitTimeoutMs: 5_000,
      });
      expect(composition.available).toBe(true);

      const catalog = composition.port.listCatalog();
      expect(catalog.ok).toBe(true);
      const combination = catalog.ok ? catalog.value[0] : undefined;
      expect(combination).toBeDefined();
      if (combination === undefined) {
        return;
      }
      const created = composition.port.createEnvironment({
        requestId: `qa-browser-create-${Date.now()}`,
        name: 'qa-browser-env',
        combination,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      // The contract create is asynchronous: poll for the operation record to
      // appear and reach a terminal status instead of assuming it exists the
      // instant create returns.
      await waitFor(
        () => {
          const snapshot = composition?.port.findOperation(created.value.operationId);
          return snapshot !== undefined && snapshot.ok && ['succeeded', 'failed', 'cancelled'].includes(snapshot.value.status);
        },
        { timeoutMs: 20 * 60_000, intervalMs: 500, label: 'create operation terminal' },
      );
      const createdSnapshot = composition.port.findOperation(created.value.operationId);
      expect(createdSnapshot.ok && createdSnapshot.value.status).toBe('succeeded');
      const listed = composition.port.listEnvironments();
      expect(listed.ok).toBe(true);
      const environment = listed.ok ? listed.value[0] : undefined;
      expect(environment).toBeDefined();
      if (environment === undefined) {
        return;
      }

      const imported = applyCredentialFile(composition.service, environment.id, importFile);
      expect(imported.ok).toBe(true);
      const refreshed = composition.port.findEnvironment(environment.id);
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) {
        return;
      }
      const started = composition.port.startEnvironment({
        requestId: `qa-browser-start-${Date.now()}`,
        environmentId: environment.id,
        expectedRevision: refreshed.value.revision,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) {
        return;
      }
      await waitFor(
        () => {
          const snapshot = composition?.port.findOperation(started.value.operationId);
          return (
            snapshot !== undefined &&
            snapshot.ok &&
            ['succeeded', 'failed', 'cancelled'].includes(snapshot.value.status)
          );
        },
        { timeoutMs: START_TIMEOUT_MS, intervalMs: 250, label: 'start operation terminal' },
      );
      const finalStart = composition.port.findOperation(started.value.operationId);
      expect(finalStart.ok && finalStart.value.status).toBe('succeeded');

      const opened = await composition.openWebUi(environment.id);
      expect(opened.ok).toBe(true);
      expect(handed).toHaveLength(1);
      if (!opened.ok) {
        return;
      }
      const loopbackOrigin = opened.value.loopbackOrigin;
      expect(JSON.stringify(opened)).not.toContain('token=');

      // Positive: rc2 application identity on the authenticated page.
      await waitFor(
        async () => {
          const href = await browser.cdp.evaluate<string>('location.href');
          const title = await browser.cdp.evaluate<string>('document.title');
          const shell = await browser.cdp.evaluate<boolean>(
            "document.querySelector('#root [data-slot=\\\"root\\\"]') !== null",
          );
          return (
            (href === `${loopbackOrigin}/` || href === loopbackOrigin) &&
            title === AUTHENTICATED_TITLE &&
            shell
          );
        },
        { timeoutMs: 30_000, intervalMs: 250, label: 'authenticated DSH shell rendered' },
      );
      const finalHref = await browser.cdp.evaluate<string>('location.href');
      expect(finalHref).not.toContain('token=');
      expect(new URL(finalHref).search).toBe('');
      const title = await browser.cdp.evaluate<string>('document.title');
      expect(title).toBe(AUTHENTICATED_TITLE);
      const authenticatedText = await browser.cdp.evaluate<string>(
        "(document.body?.innerText ?? '').slice(0, 400)",
      );
      expect(authenticatedText).toContain('新会话');
      // The app-shell identity: title plus the DSH root slot, not page size.
      expect(
        await browser.cdp.evaluate<boolean>(
          "document.querySelector('#root [data-slot=\"root\"]') !== null",
        ),
      ).toBe(true);
      // The launcher bridge is absent on the DSH page.
      expect(await browser.cdp.evaluate<boolean>("typeof window.hdsl === 'undefined'")).toBe(true);

      // Negative control: a second, cookie-less profile cannot see the app shell.
      const coldBrowser = await launchChrome(harness.registry, 'browser02');
      await coldBrowser.cdp.send('Page.enable');
      await coldBrowser.cdp.send('Page.navigate', { url: loopbackOrigin });
      await waitFor(
        async () => {
          const href = await coldBrowser.cdp.evaluate<string>('location.href');
          return href !== 'about:blank';
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'cold profile navigation settled' },
      );
      const coldShell = await coldBrowser.cdp.evaluate<boolean>(
        "document.querySelector('#root [data-slot=\\\"root\\\"]') !== null",
      );
      const coldTitle = await coldBrowser.cdp.evaluate<string>('document.title');
      expect(coldShell, `cold profile unexpectedly rendered the app shell (${sanitizeForReport(coldBrowser.output(), secrets)})`).toBe(false);
      expect(coldTitle).not.toBe(AUTHENTICATED_TITLE);

      const currentRevision = composition.port.findEnvironment(environment.id);
      const stopped = composition.port.stopEnvironment({
        requestId: `qa-browser-stop-${Date.now()}`,
        environmentId: environment.id,
        expectedRevision: currentRevision.ok ? currentRevision.value.revision : refreshed.value.revision,
      });
      if (stopped.ok) {
        await composition.service.waitForOperation(stopped.value.operationId, { timeoutMs: 60_000 });
      }
    } finally {
      if (composition !== undefined) {
        await composition.close().catch(() => undefined);
      }
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
      const report = await harness.registry.cleanup();
      expect(report.failed, JSON.stringify(report.failed)).toEqual([]);
    }
  }, 25 * 60_000);
});
