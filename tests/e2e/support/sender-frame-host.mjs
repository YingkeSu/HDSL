/**
 * TEST-ONLY Electron sender-frame host (Refs #7 / #6; T007 follow-up).
 *
 * This is **not** the product entry and is never part of a release build. It
 * exists so QA can drive a **real subframe IPC call** against the production
 * main-side sender guard:
 *
 * - it loads the production main IPC handler (`DesktopIpcHost`,
 *   `isAuthorizedSender`) and the **actual production preload bundle**
 *   (`apps/desktop/dist/preload/bridge.cjs`);
 * - the only test-host-only privilege is `nodeIntegrationInSubFrames: true` and
 *   a test page without the product renderer's CSP, so a subframe can load and
 *   carry the production bridge at all. That makes this host a
 *   defense-in-depth probe, **not** the product's first layer of defense: in the
 *   real product the renderer CSP and the missing subframe preload come first
 *   (see `desktop.iframe.real.test.ts`).
 *
 * It never modifies production sources, production window options or the
 * production CSP, and it adds no production back door. The trusted-document
 * policy points at this host's own test page (documented test-host policy), so
 * the main-frame control uses the same exact-URL + `isMainFrame` production
 * predicate as production.
 *
 * Usage (after `pnpm run build:desktop`):
 *   electron tests/e2e/support/sender-frame-host.mjs \
 *     --hdsl-test-page <parent.html> --hdsl-data-root <dir> \
 *     --user-data-dir <dir> --remote-debugging-port <port>
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolved by relative path: this test host lives outside the workspace
// package graph, so the bare specifier would not resolve from tests/e2e.
import {
  API_VERSION,
  contractErrorForCode,
  contractFail,
} from '../../../packages/contracts/dist/index.js';
import { createDesktopComposition } from '../../../apps/desktop/dist/main/composition.js';
import {
  DesktopIpcHost,
  HDSL_CONTRACT_CHANNEL,
} from '../../../apps/desktop/dist/main/ipc.js';
import { SECURE_WINDOW_DEFAULTS } from '../../../apps/desktop/dist/main/security.js';
import { createTrustedUrlPolicy } from '../../../apps/desktop/dist/main/trusted-url.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PRELOAD_BRIDGE = join(REPO_ROOT, 'apps', 'desktop', 'dist', 'preload', 'bridge.cjs');

const flagValue = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  return value === undefined || value === '' ? undefined : value;
};

const testPage = flagValue('--hdsl-test-page');
const dataRoot = flagValue('--hdsl-data-root');
if (testPage === undefined || dataRoot === undefined) {
  process.stderr.write('[hdsl-test-host] missing --hdsl-test-page/--hdsl-data-root\n');
  app.exit(2);
}

/** Copied verbatim from the production entry glue (`app.ts`). */
const senderIdentity = (event) => {
  const frame = event.senderFrame;
  return {
    webContentsId: event.sender.id,
    isMainFrame: frame !== null && frame !== undefined && frame === event.sender.mainFrame,
    frameUrl: frame?.url ?? '',
  };
};

const start = async () => {
  const composition = await createDesktopComposition({
    dataRoot,
    appInfo: {
      name: 'HDSL sender-frame test host',
      version: '0.0.0',
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
    },
    openWebUi: async () => ({
      ok: false,
      code: 'WEBUI_UNAVAILABLE',
      message: 'test host does not open a WebUI',
    }),
    lockWaitTimeoutMs: 5_000,
  });
  if (!composition.available) {
    process.stderr.write('[hdsl-test-host] data-root lease unavailable\n');
    app.exit(3);
  }

  // Test-host trusted document = this host's own page (documented).
  const policy = createTrustedUrlPolicy(pathToFileURL(testPage).href);
  const host = new DesktopIpcHost({ port: composition.port, policy });
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      ...SECURE_WINDOW_DEFAULTS,
      preload: PRELOAD_BRIDGE,
      // TEST-HOST-ONLY: lets the production preload run in a subframe so a real
      // subframe IPC call can be attempted. Never used by the product entry.
      nodeIntegrationInSubFrames: true,
    },
  });
  host.openWindow({
    webContentsId: window.webContents.id,
    send: (event) => {
      if (!window.isDestroyed()) {
        window.webContents.send('operation.updated', event);
      }
    },
  });
  ipcMain.handle(HDSL_CONTRACT_CHANNEL, async (event, payload) => {
    try {
      return await host.handle(senderIdentity(event), payload);
    } catch {
      return contractFail(API_VERSION, contractErrorForCode('INTERNAL_ERROR'));
    }
  });
  await window.loadFile(testPage);
  process.stderr.write('[hdsl-test-host] ready\n');
};

app.whenReady().then(start, (error) => {
  process.stderr.write(`[hdsl-test-host] startup failed: ${String(error)}\n`);
  app.exit(1);
});
app.on('window-all-closed', () => {
  app.quit();
});
