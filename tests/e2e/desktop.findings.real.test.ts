/**
 * Reproducible findings on the frozen T006 candidate (`33bfd1e`, PR #68).
 *
 * Independent QA (hdsl-25). This file is **evidence**, and on the frozen head it
 * is expected to be RED:
 *
 * - `E2E-AUTH-01` (review P2-1): the sender/navigation authorization predicate
 *   is a `startsWith` prefix check, so a *different* URL that shares the
 *   renderer document's prefix is accepted. The evidence is at the pure-function
 *   authorization boundary; it does **not** claim a browser-level exploit, and
 *   no claim is made that Chromium can be driven to that exact URL.
 * - `E2E-HOOK-01` (review P2-2): the three `HDSL_*` operator hooks are read
 *   unconditionally in production, so a normal boot with the env vars set
 *   silently imports a credential reference file despite the native-menu /
 *   path-authorization design. This is a runtime reproduction; it requires
 *   control of the launcher environment (not a remote/renderer attacker).
 *
 * After the fix (production stops reading the hooks; authorization is exact) the
 * same assertions are expected to pass unchanged. Opt-in with
 * `HDSL_E2E_DESKTOP=1` so `pnpm run test` stays green while the finding is open.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { isAuthorizedSender } from '../../apps/desktop/src/main/ipc.js';
import { isTrustedDocumentUrl, createTrustedUrlPolicy } from '../../apps/desktop/src/main/trusted-url.js';
import { buildReferenceOnlyConfig } from './support/canary.js';
import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';
import { callContract, pollContract, waitForRender } from './support/desktop-ui.js';
import { sleep } from './support/gates.js';

const ENABLED = process.env['HDSL_E2E_DESKTOP'] === '1';
const RENDERER_INDEX_URL = pathToFileURL(
  fileURLToPath(new URL('../../apps/desktop/dist/renderer/index.html', import.meta.url)),
).href;

describe.skipIf(!ENABLED)('T006 candidate execution evidence (verified on 33bfd1e)', () => {
  afterEach(cleanupAllHarnesses);
  it('E2E-AUTH-01: authorization uses exact normalized document equality, not a prefix', () => {
    const policy = createTrustedUrlPolicy(RENDERER_INDEX_URL);
    const lookalike = `${RENDERER_INDEX_URL}.attacker`;
    const nested = `${RENDERER_INDEX_URL}/nested/evil.html`;
    const encoded = RENDERER_INDEX_URL.replace('/index.html', '/index%2ehtml');
    const withQuery = `${RENDERER_INDEX_URL}?x=1`;

    // The real document itself must stay authorized.
    expect(isTrustedDocumentUrl(RENDERER_INDEX_URL, policy)).toBe(true);
    expect(
      isAuthorizedSender(
        { webContentsId: 1, isMainFrame: true, frameUrl: RENDERER_INDEX_URL },
        policy,
      ),
    ).toBe(true);

    // Anything that merely shares the prefix is a different document.
    expect(isTrustedDocumentUrl(lookalike, policy)).toBe(false);
    expect(isTrustedDocumentUrl(nested, policy)).toBe(false);
    expect(isTrustedDocumentUrl(encoded, policy)).toBe(false);
    expect(isTrustedDocumentUrl(withQuery, policy)).toBe(false);
    expect(
      isAuthorizedSender(
        { webContentsId: 1, isMainFrame: true, frameUrl: lookalike },
        policy,
      ),
    ).toBe(false);
    expect(
      isAuthorizedSender(
        { webContentsId: 1, isMainFrame: true, frameUrl: nested },
        policy,
      ),
    ).toBe(false);
    // A subframe is never authorized even with the trusted URL.
    expect(
      isAuthorizedSender(
        { webContentsId: 1, isMainFrame: false, frameUrl: RENDERER_INDEX_URL },
        policy,
      ),
    ).toBe(false);
  });

  it('E2E-HOOK-01: setting the HDSL_* hooks must not silently write credential config on a normal boot', async () => {
    const harness = appHarness();
    // 1) Create a real environment without any hook set.
    const first = await bootApp(harness, 'hook01a');
    await waitForRender(first.cdp);
    const created = await callContract(first.cdp, 'environments.create', {
      requestId: 'hook01-create',
      name: 'qa-hook01',
      catalogCombinationId: 'darwin-arm64-node22_19_0-dsh0_1_5-rc_2',
    });
    expect(created.ok).toBe(true);
    const succeeded = await pollContract(
      first.cdp,
      'environments.list',
      {},
      (envelope) =>
        Array.isArray(envelope.value) &&
        (envelope.value as readonly { name?: string; state?: string }[]).some(
          (entry) => entry.name === 'qa-hook01' && entry.state === 'stopped',
        ),
      { timeoutMs: 20 * 60_000, intervalMs: 2_000, label: 'hook01 environment created' },
    );
    const environment = (
      succeeded.value as readonly { id: string; name: string; state: string }[]
    ).find((entry) => entry.name === 'qa-hook01');
    expect(environment?.state).toBe('stopped');
    if (environment === undefined) {
      return;
    }
    await first.app.kill();

    // 2) Relaunch with every operator hook set and a reference-only file.
    const configRoot = harness.registry.registerTempRoot('hook01-config');
    const configPath = join(configRoot, 'credential-references.json');
    writeFileSync(
      configPath,
      buildReferenceOnlyConfig([
        {
          name: 'HDSL_QA_CANARY_KEY',
          reference: { id: 'cred-qa-hook01', store: 'keychain', key: 'hdsl-qa-24-canary#t006' },
        },
      ]),
    );
    const exportPath = join(configRoot, 'diagnostics-export.json');
    mkdirSync(configRoot, { recursive: true });

    const second = await bootApp(harness, 'hook01b', {
      dataRoot: first.app.dataRoot,
      env: {
        HDSL_CREDENTIAL_IMPORT_PATH: configPath,
        HDSL_CREDENTIAL_IMPORT_ENVIRONMENT: environment.id,
        HDSL_DIAGNOSTICS_EXPORT_PATH: exportPath,
      },
    });
    await waitForRender(second.cdp);
    await sleep(2_000);

    const credentialsPath = join(first.app.dataRoot, 'environments', environment.id, 'credentials.json');
    // Production must ignore the revoked env hooks: no silent write, no bypass.
    expect(existsSync(credentialsPath), `credential config was written to ${credentialsPath}`).toBe(
      false,
    );
    expect(existsSync(exportPath), `diagnostics export was written to ${exportPath}`).toBe(false);
    // The hook is gone from production: no startup-import marker on stderr.
    expect(second.app.output()).not.toContain('credential-import');
  }, 25 * 60_000);
});
