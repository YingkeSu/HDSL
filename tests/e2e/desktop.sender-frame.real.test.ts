/**
 * Test-host lane: real subframe IPC rejected by the production sender guard
 * (Refs #7 / #6; T007 follow-up).
 *
 * This complements `desktop.iframe.real.test.ts` (the production-window lane,
 * where the renderer CSP and the absent subframe preload come first). Here a
 * **TEST-ONLY Electron host** (`support/sender-frame-host.mjs`) loads the
 * production main IPC handler and the actual production preload bundle, and is
 * allowed the test-host-only `nodeIntegrationInSubFrames: true` so a **real
 * subframe carries the production bridge and makes a real IPC call**. Nothing
 * is faked: the identity is derived by the production entry glue from the real
 * Electron event.
 *
 * The claim under test is narrow and exactly this: with the bridge present in a
 * subframe, the production `senderFrame`/`isMainFrame` predicate rejects every
 * call before dispatch (controlled `INTERNAL_ERROR`, no create/export/open side
 * effects, no secret or raw exception), while the main frame's normal call
 * succeeds. This host is **not** the product's first layer of defense and is
 * never part of a release build.
 *
 * Only registered temp roots/processes are used: no DSH network, no keychain,
 * no user browser profile. Opt-in with `HDSL_E2E_SENDERFRAME=1`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { API_VERSION } from '@hdsl/contracts';

import { appHarness, cleanupAllHarnesses } from './support/app-harness.js';
import { REPO_ROOT } from './support/desktop-candidate.js';
import { launchDesktopApp } from './support/electron-app.js';
import { waitFor } from './support/gates.js';

const ENABLED = process.env['HDSL_E2E_SENDERFRAME'] === '1';
const HOST_ENTRY = join(REPO_ROOT, 'tests', 'e2e', 'support', 'sender-frame-host.mjs');
const FIXTURES = join(REPO_ROOT, 'tests', 'e2e', 'support', 'fixtures');
const FIXTURE_NAMES = ['sender-frame-parent.html', 'sender-frame-child.html'] as const;
const VERSION_TOKEN = '__HDSL_API_VERSION__';

/**
 * Copies the committed fixtures into a temp root, replacing the version token
 * with the shared `API_VERSION`. The fixtures stay version-agnostic so a wire
 * bump cannot strand them on an old exact-match literal.
 */
const materializeFixtures = (destination: string): void => {
  mkdirSync(destination, { recursive: true });
  for (const name of FIXTURE_NAMES) {
    writeFileSync(
      join(destination, name),
      readFileSync(join(FIXTURES, name), 'utf8').split(VERSION_TOKEN).join(API_VERSION),
    );
  }
};

interface ChildReport {
  readonly bridgePresent: boolean;
  readonly envelopes: Record<string, { readonly ok?: boolean; readonly error?: { readonly code?: string; readonly message?: string }; readonly thrown?: string }>;
}

describe('desktop sender-frame test host', () => {
  // Always-on sanity check for the committed fixtures used by the host.
  it('E2E-SENDERFRAME-02: test-host fixtures exist, are self-contained and version-agnostic', () => {
    for (const name of FIXTURE_NAMES) {
      const content = readFileSync(join(FIXTURES, name), 'utf8');
      expect(content, `${name} uses the shared version token`).toContain(VERSION_TOKEN);
      expect(content, `${name} has no hardcoded 1.0 envelope`).not.toContain("apiVersion: '1.0'");
    }
    expect(existsSync(HOST_ENTRY)).toBe(true);
  });

  describe.skipIf(!ENABLED)('real Electron test host', () => {
    afterEach(cleanupAllHarnesses);

    it('E2E-SENDERFRAME-01: a real subframe with the production bridge is rejected before dispatch; main frame succeeds', async () => {
      const harness = appHarness();
      const fixtureRoot = harness.registry.registerTempRoot('senderframe');
      materializeFixtures(fixtureRoot);
      const parentPage = join(fixtureRoot, 'sender-frame-parent.html');

      const app = await launchDesktopApp({
        registry: harness.registry,
        label: 'senderframe',
        entry: HOST_ENTRY,
        extraArgs: ['--hdsl-test-page', parentPage],
      });
      harness.apps.push(app);
      const cdp = await app.connect();
      harness.clients.push(cdp);

      await waitFor(
        async () =>
          (await cdp.evaluate<string>('window.__childEnvelope ? "yes" : ""')) === 'yes',
        { timeoutMs: 30_000, intervalMs: 250, label: 'child envelope posted' },
      );
      expect(app.output()).toContain('[hdsl-test-host] ready');

      const mainEnvelope = JSON.parse(
        await cdp.evaluate<string>('JSON.stringify(window.__mainEnvelope)'),
      ) as { readonly ok?: boolean; readonly value?: readonly unknown[] };
      const childReport = JSON.parse(
        await cdp.evaluate<string>('JSON.stringify(window.__childEnvelope)'),
      ) as ChildReport;

      // Main frame control: the production predicate authorizes it and the real
      // catalog answers.
      expect(mainEnvelope.ok).toBe(true);
      expect(Array.isArray(mainEnvelope.value)).toBe(true);
      expect(mainEnvelope.value?.length).toBe(2);

      // The subframe really carried the production bridge (test-host-only
      // subframe preload), so the rejection is the main-side sender guard, not a
      // missing bridge.
      expect(childReport.bridgePresent).toBe(true);

      // Record the observed envelopes (no secrets involved).
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ mainOk: mainEnvelope.ok, child: childReport.envelopes }));

      // Every call from the subframe is rejected before dispatch: controlled
      // INTERNAL_ERROR, never a NOT_FOUND/UNSUPPORTED_COMBINATION from dispatch.
      for (const method of ['catalog', 'create', 'export', 'openWebUI'] as const) {
        const envelope = childReport.envelopes[method];
        expect(envelope, `missing child envelope for ${method}`).toBeDefined();
        expect(envelope?.ok, `${method} must not succeed`).toBe(false);
        expect(envelope?.error?.code, `${method} must fail with the controlled sender error`).toBe(
          'INTERNAL_ERROR',
        );
        expect(envelope?.error?.code).not.toBe('NOT_FOUND');
        expect(envelope?.error?.code).not.toBe('UNSUPPORTED_COMBINATION');
      }

      // No side effects: no environment was created and nothing was exported.
      // The composition may pre-create the empty `environments/` container, so
      // assert it holds no environment, not that the directory is absent.
      const environmentsDir = join(app.dataRoot, 'environments');
      const environments = existsSync(environmentsDir) ? readdirSync(environmentsDir) : [];
      expect(environments).toEqual([]);
      const exported = readdirSync(app.dataRoot).filter((name) => name.endsWith('.json'));
      expect(exported).toEqual([]);

      // No raw exception, stack, local path or secret crosses the boundary.
      const serialized = JSON.stringify(childReport);
      expect(serialized).not.toContain('file://');
      expect(serialized).not.toContain('Error:');
      expect(serialized).not.toMatch(/\n\s+at /);
      expect(serialized).not.toContain('token=');
    }, 180_000);
  });
});
