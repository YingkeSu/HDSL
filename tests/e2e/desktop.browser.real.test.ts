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
 * domain is never enabled and cookies are never dumped. After navigation the
 * test asserts the final document is the canonical loopback origin with no
 * query string and that the authenticated page rendered real content.
 *
 * Prerequisites (verified in this session): `/Applications/Google Chrome.app`
 * and the macOS `security` CLI for a self-built, randomly named keychain canary
 * item that is created before use and deleted in `finally`. No personal keychain
 * item, no model call, no user browser profile, no user DSH instance.
 *
 * Opt-in with `HDSL_E2E_BROWSER=1`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { createVerifiedWebUiOpener } from '../../apps/desktop/src/main/webui.js';
import { createDesktopComposition } from '../../apps/desktop/src/main/composition.js';
import { applyCredentialFile } from '../../apps/desktop/src/main/credential-import.js';
import { connectCdp, type CdpClient } from './support/cdp.js';
import { appHarness } from './support/app-harness.js';
import { waitFor } from './support/gates.js';

const ENABLED = process.env['HDSL_E2E_BROWSER'] === '1';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SECURITY = '/usr/bin/security';
const START_TIMEOUT_MS = 3 * 60_000;

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

const freePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const fetchJsonTarget = async (port: number): Promise<{ readonly webSocketDebuggerUrl?: string } | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json`, {
      signal: AbortSignal.timeout(2_000),
    });
    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) {
      return null;
    }
    const page = (parsed as { readonly type?: string; readonly webSocketDebuggerUrl?: string }[]).find(
      (entry) => entry.type === 'page',
    );
    return page ?? null;
  } catch {
    return null;
  }
};

describe.skipIf(!ENABLED)('desktop isolated real-browser lane (opener injection)', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
  });

  it('E2E-BROWSER-01: injected opener authenticates through the real browser and lands on a usable page', async () => {
    expect(existsSync(CHROME), `Chrome binary missing at ${CHROME}`).toBe(true);

    const harness = appHarness();
    const dataRoot = harness.registry.registerTempRoot('browser-data');
    const profile = harness.registry.registerTempRoot('browser-profile');
    const port = await freePort();

    const chrome = spawn(
      CHROME,
      [
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${String(port)}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(chrome);
    let chromeOutput = '';
    chrome.stdout?.on('data', (chunk: Buffer) => {
      chromeOutput += chunk.toString();
    });
    chrome.stderr?.on('data', (chunk: Buffer) => {
      chromeOutput += chunk.toString();
    });

    await waitFor(
      async () => (await fetchJsonTarget(port)) !== null,
      { timeoutMs: 30_000, intervalMs: 250, label: 'chrome CDP page target' },
    );
    const target = await fetchJsonTarget(port);
    const wsUrl = target?.webSocketDebuggerUrl;
    expect(typeof wsUrl).toBe('string');
    if (wsUrl === undefined) {
      return;
    }
    const browser: CdpClient = await connectCdp(wsUrl);
    await browser.send('Page.enable');

    // Self-built keychain canary; secret is written through stdin, never argv.
    const service = `hdsl-qa-24-browser-${randomBytes(6).toString('hex')}`;
    const account = 't006';
    const canary = `hdsl-qa-canary-${randomBytes(12).toString('hex')}`;
    let keychainCreated = false;
    let composition: Awaited<ReturnType<typeof createDesktopComposition>> | undefined;
    try {
      expect(await runSecurity(['add-generic-password', '-a', account, '-s', service, '-w'], `${canary}\n${canary}\n`)).toBe(0);
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

      const handed: string[] = [];
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
        openWebUi: createVerifiedWebUiOpener(async (url: string) => {
          handed.push(url);
          await browser.send('Page.navigate', { url });
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
      const createdSnapshot = await composition.service.waitForOperation(created.value.operationId, {
        timeoutMs: 20 * 60_000,
      });
      expect(createdSnapshot.status).toBe('succeeded');
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
          return snapshot !== undefined && snapshot.ok && ['succeeded', 'failed', 'cancelled'].includes(snapshot.value.status);
        },
        { timeoutMs: START_TIMEOUT_MS, intervalMs: 250, label: 'start operation terminal' },
      );
      const finalStart = composition.port.findOperation(started.value.operationId);
      expect(finalStart.ok && finalStart.value.status).toBe('succeeded');

      const opened = await composition.openWebUi(environment.id);
      expect(opened.ok).toBe(true);
      expect(handed).toHaveLength(1);
      // The bootstrap URL is only ever handed to the opener.
      expect(handed[0]).toContain('token=');
      if (!opened.ok) {
        return;
      }
      const loopbackOrigin = opened.value.loopbackOrigin;
      expect(JSON.stringify(opened)).not.toContain('token=');

      // The browser follows the bootstrap redirect; assert the final document is
      // the canonical origin without the token query and renders real content.
      await waitFor(
        async () => {
          const href = await browser.evaluate<string>('location.href');
          return href === `${loopbackOrigin}/` || href === loopbackOrigin;
        },
        { timeoutMs: 20_000, intervalMs: 250, label: 'authenticated canonical origin' },
      );
      const finalHref = await browser.evaluate<string>('location.href');
      expect(finalHref).not.toContain('token=');
      expect(finalHref.startsWith(loopbackOrigin)).toBe(true);
      expect(new URL(finalHref).search).toBe('');

      const dom = await browser.evaluate<string>(
        "(document.body?.textContent ?? '').trim().slice(0, 200)",
      );
      expect(dom.length, `authenticated DOM was empty; chrome output: ${chromeOutput.slice(0, 400)}`).toBeGreaterThan(50);
      const html = await browser.evaluate<string>('document.documentElement.outerHTML.length');
      expect(html).toBeGreaterThan(1_000);
      // No launcher bridge on this page.
      expect(await browser.evaluate<boolean>("typeof window.hdsl === 'undefined'")).toBe(true);

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
      await browser.close().catch(() => undefined);
      chrome.kill('SIGKILL');
      if (composition !== undefined) {
        await composition.close().catch(() => undefined);
      }
      if (keychainCreated) {
        await runSecurity(['delete-generic-password', '-s', service, '-a', account], '').catch(
          () => undefined,
        );
      }
      await sleep(150);
      const report = await harness.registry.cleanup();
      expect(report.failed, JSON.stringify(report.failed)).toEqual([]);
    }
  }, 25 * 60_000);
});
