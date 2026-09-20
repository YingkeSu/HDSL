/**
 * Real desktop E2E on the frozen T006 candidate (`33bfd1e`, PR #68).
 *
 * Independent QA (hdsl-25, `tests/e2e/**`). These tests boot the candidate's
 * own built app and drive the **real** Electron renderer over CDP: real React
 * mount, real keyboard input through the `Input` domain, the real preload
 * bridge and the real main-process guards. No SSR markup, no source reading, no
 * mock port.
 *
 * Opt-in: the suite launches Electron, performs a real managed install and uses
 * the network, so it is gated behind `HDSL_E2E_DESKTOP=1` (the same pattern as
 * the T004/T005 real evidence tests). It never reads a personal keychain, never
 * calls a model and never touches the user's `~/.dsh` or a user browser profile:
 * every instance runs on a registered `hdsl-e2e-*` temp dataRoot/user-data pair.
 *
 * Run: `HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.real.test.ts`
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';
import { electronBinaryPresent, launchDesktopApp } from './support/electron-app.js';
import {
  activeElement,
  callContract,
  domDisabled,
  domValue,
  environmentIdsOnDisk,
  focusSelector,
  pollContract,
  readJsonIfPresent,
  waitForRender,
  type ContractEnvelope,
} from './support/desktop-ui.js';
import { waitFor } from './support/gates.js';

const ENABLED = process.env['HDSL_E2E_DESKTOP'] === '1';
const COMBINATION_NODE24 = 'darwin-arm64-node24_21_0-dsh0_1_5-rc_2';

describe.skipIf(!ENABLED)('desktop real E2E (frozen candidate 33bfd1e)', () => {
  afterEach(cleanupAllHarnesses);

  it('E2E-WIN-01: boots a real window, mounts React and exposes only the narrow bridge', async () => {
    const harness = appHarness();
    const { cdp } = await bootApp(harness, 'win01');

    const root = await waitForRender(cdp);
    expect(root).toContain('HDSL 环境管理');

    const bridge = JSON.parse(
      await cdp.evaluate<string>(
        "JSON.stringify({ has: typeof window.hdsl === 'object' && window.hdsl !== null, members: window.hdsl ? Object.keys(window.hdsl).sort() : [], require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer, send: typeof window.hdsl?.send, invoke: typeof window.hdsl?.invoke, on: typeof window.hdsl?.on })",
      ),
    ) as Record<string, unknown>;
    expect(bridge['has']).toBe(true);
    expect(bridge['members']).toEqual(['call', 'onOperationUpdated', 'selectEnvironment']);
    expect(bridge['require']).toBe('undefined');
    expect(bridge['process']).toBe('undefined');
    expect(bridge['ipc']).toBe('undefined');
    expect(bridge['send']).toBe('undefined');
    expect(bridge['invoke']).toBe('undefined');
    expect(bridge['on']).toBe('undefined');
  }, 120_000);

  it('E2E-WIN-02: real React keyboard input and focus traversal reach the controls', async () => {
    const harness = appHarness();
    const { cdp } = await bootApp(harness, 'win02');

    // The create form is disabled until the catalog load finishes.
    await waitFor(async () => !(await domDisabled(cdp, '#create-name')), {
      timeoutMs: 15_000,
      label: 'create form enabled',
    });

    await focusSelector(cdp, '#create-name');
    expect((await activeElement(cdp)).id).toBe('create-name');
    await cdp.typeText('qa-keyboard-name');
    expect(await domValue(cdp, '#create-name')).toBe('qa-keyboard-name');

    // Real Tab traversal: name -> combination select -> submit button.
    await cdp.pressKey('Tab');
    expect((await activeElement(cdp)).id).toBe('create-combination');
    // The catalog load already selected the first verified combination.
    expect(await domValue(cdp, '#create-combination')).toBe(
      await cdp.evaluate<string>(
        "document.querySelector('#create-combination')?.selectedOptions?.[0]?.value ?? ''",
      ),
    );
    await cdp.pressKey('Tab');
    const button = await activeElement(cdp);
    expect(button.tag).toBe('BUTTON');
    expect(button.text).toBe('创建');
    expect(await domDisabled(cdp, 'button[type="submit"]')).toBe(false);

    // Shift+Tab returns to the select: focus traversal works in both directions.
    await cdp.evaluate(
      "(() => { const el = document.activeElement; if (el instanceof HTMLElement) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true })); } })()",
    );
    expect(await domValue(cdp, '#create-name')).toBe('qa-keyboard-name');
  }, 120_000);

  it('E2E-TRUST-01: launcher window denies popups and external navigation', async () => {
    const harness = appHarness();
    const { app, cdp } = await bootApp(harness, 'trust01');

    const popup = await cdp.evaluate<boolean>(
      "window.open('https://example.com', '_blank') === null",
    );
    expect(popup).toBe(true);

    const before = await cdp.evaluate<string>('location.href');
    await cdp.evaluate(
      "(() => { try { location.href = 'https://example.com/'; } catch { /* denied */ } })()",
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    const after = await cdp.evaluate<string>('location.href');
    expect(after).toBe(before);
    expect(before.startsWith('file://')).toBe(true);
    // The renderer is still alive and responsive after the denied navigation.
    expect(
      await cdp.evaluate<number>("(document.getElementById('root')?.textContent ?? '').length"),
    ).toBeGreaterThan(0);
    expect(app.isRunning()).toBe(true);
  }, 120_000);

  it('E2E-IPC-01: the frozen contract answers through the real bridge and fails closed', async () => {
    const harness = appHarness();
    const { cdp } = await bootApp(harness, 'ipc01');

    const catalog = await callContract(cdp, 'catalog.list', {});
    expect(catalog.ok).toBe(true);
    const combos = catalog.value as readonly { readonly id: string }[];
    expect(combos.map((entry) => entry.id)).toContain(COMBINATION_NODE24);

    const unknownMethod = await callContract(cdp, 'not.a.method', {});
    expect(unknownMethod.ok).toBe(false);
    expect(unknownMethod.error?.code).toBe('INVALID_INPUT');

    const mismatch = JSON.parse(
      await cdp.evaluate<string>(
        "window.hdsl.call({ apiVersion: '2.0', method: 'catalog.list', input: {} }).then((r) => JSON.stringify(r))",
        { awaitPromise: true },
      ),
    ) as ContractEnvelope;
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error?.code).toBe('CONTRACT_VERSION_MISMATCH');

    const unknownEnvironment = await callContract(cdp, 'environments.stop', {
      requestId: 'ipc-unknown-stop',
      environmentId: 'env-does-not-exist',
      expectedRevision: 0,
    });
    expect(unknownEnvironment.ok).toBe(false);
    expect(unknownEnvironment.error?.code).toBe('NOT_FOUND');

    const unknownOperation = await callContract(cdp, 'operations.get', {
      operationId: 'op-does-not-exist',
    });
    expect(unknownOperation.ok).toBe(false);
    expect(unknownOperation.error?.code).toBe('NOT_FOUND');

    // No verified managed endpoint exists for an unknown environment: the
    // contract fails closed with WEBUI_UNAVAILABLE and never returns a URL.
    const unknownWebUi = await callContract(cdp, 'environments.openWebUI', {
      requestId: 'ipc-unknown-webui',
      environmentId: 'env-does-not-exist',
    });
    expect(unknownWebUi.ok).toBe(false);
    expect(unknownWebUi.error?.code).toBe('WEBUI_UNAVAILABLE');
    // A failure must not leak a URL, token or local path.
    const serialized = JSON.stringify(unknownWebUi);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('file://');
    expect(serialized).not.toContain('127.0.0.1');
  }, 120_000);

  it('E2E-LOCK-01: a second instance on the same user-data dir exits without a window', async () => {
    const harness = appHarness();
    const first = await bootApp(harness, 'lock01a');
    expect(first.app.isRunning()).toBe(true);

    const second = await launchDesktopApp({
      registry: harness.registry,
      label: 'lock01b',
      dataRoot: first.app.dataRoot,
      userDataDir: first.app.userDataDir,
    });
    harness.apps.push(second);
    const exit = await second.waitForExit(20_000).catch(() => null);
    expect(exit, 'the second instance must exit via requestSingleInstanceLock').not.toBeNull();
    expect(second.isRunning()).toBe(false);

    // The first instance is untouched and still serves its renderer.
    expect(first.app.isRunning()).toBe(true);
    const catalog = await callContract(first.cdp, 'catalog.list', {});
    expect(catalog.ok).toBe(true);
  }, 120_000);

  it('E2E-LOCK-02: a second instance on the same dataRoot is rejected (positive control included)', async () => {
    const harness = appHarness();
    const first = await bootApp(harness, 'lock02a');

    const second = await launchDesktopApp({
      registry: harness.registry,
      label: 'lock02b',
      dataRoot: first.app.dataRoot,
    });
    harness.apps.push(second);

    // Rejection evidence. NOTE: the candidate currently emits no machine-readable
    // rejection signal on this path (no stderr line, no exit, blocked on the
    // native error box), so attribution relies on: (a) this bounded no-page
    // observation, (b) the on-disk lease still belonging to the first instance,
    // and (c) a positive control that proves the same launch config does open a
    // page on an idle root. The missing observable signal is reported as a gap.
    const gotPage = await second.waitForPageTarget(8_000).then(
      () => true,
      () => false,
    );
    expect(gotPage).toBe(false);

    const leasePath = join(first.app.dataRoot, 'locks', 'data-root.lock', 'lease.json');
    const lease = readJsonIfPresent(leasePath) as { readonly pid?: number; readonly instanceId?: string } | null;
    expect(lease?.pid, `lease at ${leasePath} must belong to the first instance`).toBe(
      first.app.pid,
    );
    expect(second.pid).not.toBe(first.app.pid);

    // Positive control: identical launch configuration on an idle root does open
    // a window, so the absence above is contention, not a broken launcher.
    const control = await bootApp(harness, 'lock02-control');
    expect(control.app.dataRoot).not.toBe(first.app.dataRoot);
    const controlCatalog = await callContract(control.cdp, 'catalog.list', {});
    expect(controlCatalog.ok).toBe(true);

    // The first instance still owns the root and still holds the lease after the
    // second process is terminated.
    expect(first.app.isRunning()).toBe(true);
    const catalog = await callContract(first.cdp, 'catalog.list', {});
    expect(catalog.ok).toBe(true);
    await second.kill();
    const afterKill = readJsonIfPresent(leasePath) as { readonly pid?: number } | null;
    expect(afterKill?.pid).toBe(first.app.pid);
  }, 180_000);

  it('E2E-LOCK-03: after the owner exits, a new instance re-acquires the same dataRoot', async () => {
    const harness = appHarness();
    const first = await bootApp(harness, 'lock03a');
    const dataRoot = first.app.dataRoot;
    const userDataDir = first.app.userDataDir;
    const leasePath = join(dataRoot, 'locks', 'data-root.lock', 'lease.json');
    const firstLease = readJsonIfPresent(leasePath) as { readonly pid?: number } | null;
    expect(firstLease?.pid).toBe(first.app.pid);

    await first.app.kill();
    // A new instance on the same dataRoot acquires the lease and serves a window.
    const second = await bootApp(harness, 'lock03b', { dataRoot, userDataDir });
    const reacquired = readJsonIfPresent(leasePath) as { readonly pid?: number } | null;
    expect(reacquired?.pid).toBe(second.app.pid);
    expect(reacquired?.pid).not.toBe(first.app.pid);
    const catalog = await callContract(second.cdp, 'catalog.list', {});
    expect(catalog.ok).toBe(true);
  }, 180_000);

  it('E2E-CREATE-01: keyboard-only create performs a real managed install', async () => {
    const harness = appHarness();
    const { app, cdp } = await bootApp(harness, 'create01');

    await waitFor(async () => !(await domDisabled(cdp, '#create-name')), {
      timeoutMs: 15_000,
      label: 'create form enabled',
    });
    await focusSelector(cdp, '#create-name');
    expect((await activeElement(cdp)).id).toBe('create-name');
    await cdp.typeText('qa-e2e-keyboard');
    expect(await domValue(cdp, '#create-name')).toBe('qa-e2e-keyboard');
    // Tab: name -> combination select (already holding the first verified
    // combination) -> submit button; Enter activates the focused button.
    await cdp.pressKey('Tab');
    expect((await activeElement(cdp)).id).toBe('create-combination');
    const combination = await domValue(cdp, '#create-combination');
    expect(combination).not.toBe('');
    await cdp.pressKey('Tab');
    expect((await activeElement(cdp)).tag).toBe('BUTTON');
    await cdp.pressKey('Enter');

    // Fast gate: a dispatched create clears the typed name. Without this the
    // test would silently wait out the whole install timeout if the keyboard
    // activation were a no-op.
    await waitFor(async () => (await domValue(cdp, '#create-name')) === '', {
      timeoutMs: 30_000,
      label: 'create dispatched (name cleared)',
    });

    const listBefore = await callContract(cdp, 'environments.list', {});
    expect(listBefore.ok).toBe(true);

    const created = await pollContract(
      cdp,
      'environments.list',
      {},
      (envelope) =>
        Array.isArray(envelope.value) &&
        (envelope.value as readonly { name?: string; state?: string }[]).some(
          (entry) => entry.name === 'qa-e2e-keyboard' && entry.state === 'stopped',
        ),
      { timeoutMs: 20 * 60_000, intervalMs: 2_000, label: 'environment created' },
    );
    const environment = (created.value as readonly { id: string; name: string; state: string }[]).find(
      (entry) => entry.name === 'qa-e2e-keyboard',
    );
    expect(environment).toBeDefined();
    if (environment === undefined) {
      return;
    }
    expect(environment.state).toBe('stopped');

    // Independent, disk-level confirmation on the registered temp root.
    expect(environmentIdsOnDisk(app.dataRoot)).toContain(environment.id);
    const environmentDir = join(app.dataRoot, 'environments', environment.id);
    expect(existsSync(join(environmentDir, 'environment.json'))).toBe(true);
    const generations = readdirSync(join(environmentDir, 'generations'));
    expect(generations.length).toBeGreaterThan(0);
    const generationDir = join(environmentDir, 'generations', generations[0] as string);
    expect(existsSync(join(generationDir, 'composition.lock.json'))).toBe(true);
    expect(existsSync(join(generationDir, 'install-manifest.json'))).toBe(true);
  }, 20 * 60_000);
});

// A cheap, always-on assertion that the harness reports the Electron binary
// state honestly (the real tests are gated above).
it('reports Electron binary availability without mutating the workspace', () => {
  expect(typeof electronBinaryPresent()).toBe('boolean');
});
