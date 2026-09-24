/**
 * Electron desktop bootstrap (T006 / issue #6).
 *
 * This module owns the real Electron lifecycle: single-instance lock, exclusive
 * data-root composition, the launcher window with the sandboxed preload bridge,
 * the two IPC channels, the native credential menu and the quit/close
 * sequence. It reads **no** test hooks: the production entry (`index.ts`) calls
 * it with defaults (native dialogs only). A separate test entry (`qa-entry.ts`)
 * may inject explicit dependencies for headless QA — that injection never
 * changes the production path.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { API_VERSION, contractErrorForCode, contractFail, isPlainRecord, resolveHostPlatform } from '@hdsl/contracts';
import {
  createDesktopComposition,
  isBlockedByRecovery,
  type DesktopComposition,
  type VerifiedWebUiOpener,
} from './composition.js';
import { applyCredentialFile, hasLaunchCredentialReference } from './credential-import.js';
import { dataRootUnavailableReason, formatDataRootUnavailableSignal } from './app-signals.js';
import { resolveDataRoot } from './data-root.js';
import type { DiagnosticsPathChooser } from './exporter.js';
import {
  DesktopIpcHost,
  HDSL_CONTRACT_CHANNEL,
  HDSL_SELECTION_CHANNEL,
  isAuthorizedSender,
  type SenderIdentity,
} from './ipc.js';
import { buildApplicationMenuTemplate } from './menu.js';
import { aboutPanelContent, PRODUCT_NAME } from './product-identity.js';
import { applyWindowSecurity, SECURE_WINDOW_DEFAULTS } from './security.js';
import { createTrustedUrlPolicy } from './trusted-url.js';
import { formatUserDataSignal, resolveUserDataDirectory } from './user-data.js';
import { createVerifiedWebUiOpener } from './webui.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RENDERER_INDEX = join(HERE, '..', 'renderer', 'index.html');
const PRELOAD_BRIDGE = join(HERE, '..', 'preload', 'bridge.cjs');
/** The single trusted renderer document, normalized once. */
const TRUSTED_URL_POLICY = createTrustedUrlPolicy(pathToFileURL(RENDERER_INDEX).href);
const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 780;
const DATA_ROOT_LOCK_WAIT_MS = 1500;

/** Explicit dependency injection for the test entry; production uses defaults. */
export interface DesktopAppOptions {
  /** Replaces the export save dialog (test injection only). */
  readonly pathChooser?: DiagnosticsPathChooser;
  /** Returns an import file path, or null when cancelled. Default: native dialog. */
  readonly importPathProvider?: () => string | null;
  /** Test-only: import one environment once at startup, without dialogs. */
  readonly startupImport?: {
    readonly environmentId: string;
    readonly filePath: string;
  };
}

/**
 * Default main-only opener. The bootstrap URL is handed only to the OS browser
 * through this callback; it is never returned, logged, persisted or placed in a
 * diagnostic. Success is reported only after `consumeWebUIBootstrap` resolves
 * with the real open result, so a failed open cannot report `opened: true`.
 * Without the runtime capability main returns `WEBUI_UNAVAILABLE` instead of
 * opening the token-free origin that would only 401.
 */
export const openVerifiedWebUi: VerifiedWebUiOpener = createVerifiedWebUiOpener((url) =>
  shell.openExternal(url),
);

const nativePathChooser: DiagnosticsPathChooser = {
  chooseExportPath(defaultFileName: string): string | null {
    const result = dialog.showSaveDialogSync({
      title: '导出脱敏诊断',
      defaultPath: defaultFileName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return result ?? null;
  },
};

const nativeImportPathProvider = (): string | null => {
  const chosen = dialog.showOpenDialogSync({
    title: '选择凭据引用配置文件',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  return chosen?.[0] ?? null;
};

let composition: DesktopComposition | undefined;
let mainWindow: BrowserWindow | undefined;
let ipcHost: DesktopIpcHost | undefined;
let quitting = false;
let recoveryNoticeShown = false;

const senderIdentity = (event: {
  readonly sender: { readonly id: number; readonly mainFrame?: unknown };
  readonly senderFrame?: unknown;
}): SenderIdentity => {
  const frame = event.senderFrame as { readonly url?: string } | null | undefined;
  return {
    webContentsId: event.sender.id,
    isMainFrame: frame !== null && frame !== undefined && frame === event.sender.mainFrame,
    frameUrl: frame?.url ?? '',
  };
};

const anyEnvironment = (): boolean => {
  const list = composition?.port.listEnvironments();
  return list !== undefined && list.ok && list.value.length > 0;
};

const focusedSelection = (): string | null => {
  if (ipcHost === undefined) {
    return null;
  }
  const focused = BrowserWindow.getFocusedWindow();
  const candidates = [focused, mainWindow];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate.isDestroyed()) {
      continue;
    }
    const selection = ipcHost.selectionFor(candidate.webContents.id);
    if (selection !== null) {
      return selection;
    }
  }
  return null;
};

const rebuildMenu = (options: DesktopAppOptions): void => {
  const template = buildApplicationMenuTemplate(
    {
      importCredentialReferences: () => {
        void importCredentialReferences(options);
      },
    },
    { hasSelectableEnvironment: anyEnvironment() },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const importCredentialReferences = async (options: DesktopAppOptions): Promise<void> => {
  if (composition === undefined) {
    return;
  }
  const selectedId = focusedSelection();
  if (selectedId === null) {
    dialog.showMessageBoxSync({
      type: 'info',
      message: '请先在窗口中选择一个环境',
      detail: '凭据引用导入需要一个明确的目标环境；请在环境列表中选择后再使用本菜单项。',
    });
    return;
  }
  // Re-resolve now so a stale selection cannot import into a removed environment.
  const environment = composition.port.findEnvironment(selectedId);
  if (!environment.ok) {
    dialog.showMessageBoxSync({
      type: 'warning',
      message: '选中的环境已不存在',
      detail: '请重新选择环境后再导入凭据引用。',
    });
    return;
  }
  const filePath = (options.importPathProvider ?? nativeImportPathProvider)();
  if (filePath === null || filePath === '') {
    return;
  }
  const result = applyCredentialFile(composition.service, selectedId, filePath);
  if (!result.ok) {
    dialog.showErrorBox(
      result.stage === 'read' ? '读取失败' : '凭据引用导入失败',
      result.message,
    );
    return;
  }
  dialog.showMessageBoxSync({
    type: 'info',
    message: `已导入 ${String(result.count)} 条凭据引用`,
    detail:
      '仅保存变量名与 OS 凭据存储引用；不会读取或写入任何 secret 值，也不会复制原文件。',
  });
};

/** Test-entry hook: import once at startup without dialogs; secret-free stderr status only. */
const runStartupImport = (options: DesktopAppOptions): void => {
  if (composition === undefined || options.startupImport === undefined) {
    return;
  }
  const { environmentId, filePath } = options.startupImport;
  const environment = composition.port.findEnvironment(environmentId);
  if (!environment.ok) {
    process.stderr.write('[hdsl] credential-import: environment not found\n');
    return;
  }
  const result = applyCredentialFile(composition.service, environmentId, filePath);
  process.stderr.write(
    result.ok
      ? `[hdsl] credential-import: applied ${String(result.count)} reference(s)\n`
      : `[hdsl] credential-import: rejected at ${result.stage}\n`,
  );
};

const promptMissingCredentials = async (environmentId: string): Promise<void> => {
  if (composition === undefined) {
    return;
  }
  const configured = await hasLaunchCredentialReference(composition.service, environmentId);
  if (configured) {
    return;
  }
  dialog.showMessageBoxSync({
    type: 'warning',
    message: '该环境尚未配置凭据引用',
    detail: '启动将失败。请使用菜单「环境 → 导入环境凭据引用…」为目标环境导入引用后再启动。',
  });
};

const createLauncherWindow = async (): Promise<void> => {
  if (ipcHost === undefined) {
    return;
  }
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    webPreferences: { ...SECURE_WINDOW_DEFAULTS, preload: PRELOAD_BRIDGE },
  });
  mainWindow = window;
  // Capture the id while the window still owns its WebContents. The `closed`
  // handler below runs after the window is destroyed, where `window.webContents`
  // is gone and reading it throws `Object has been destroyed`; that uncaught
  // error used to abort the quit sequence into a blocking native error dialog
  // (issue #88). The id is stable for the window lifetime.
  const webContentsId = window.webContents.id;
  applyWindowSecurity(window, TRUSTED_URL_POLICY);
  ipcHost.openWindow({
    webContentsId,
    // The host passes the fixed channel explicitly, so operation progress and
    // the environment-state projection never share one hardcoded literal.
    send: (channel, event) => {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, event);
      }
    },
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  window.on('closed', () => {
    ipcHost?.closeWindow(webContentsId);
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  await window.loadFile(RENDERER_INDEX);
};

const registerIpc = (options: DesktopAppOptions): void => {
  const host = ipcHost;
  if (host === undefined) {
    return;
  }
  ipcMain.handle(HDSL_CONTRACT_CHANNEL, async (event, payload: unknown) => {
    try {
      const identity = senderIdentity(event);
      return await host.handle(identity, payload);
    } catch {
      // A dialog/core exception must never reach `invoke`; return the controlled
      // failure envelope instead.
      return contractFail(API_VERSION, contractErrorForCode('INTERNAL_ERROR'));
    }
  });
  ipcMain.on(HDSL_SELECTION_CHANNEL, (event, environmentId: unknown) => {
    try {
      const identity = senderIdentity(event);
      if (!isAuthorizedSender(identity, TRUSTED_URL_POLICY)) {
        return;
      }
      host.selectEnvironment(identity.webContentsId, environmentId);
      rebuildMenu(options);
    } catch {
      // A selection notification is best-effort; never throw out of the handler.
    }
  });
  // Keep a reference so `options` stays in the closure for future menu actions.
  void options;
};

const bootstrap = async (options: DesktopAppOptions): Promise<void> => {
  // Resolve the REAL host before any data-root/composition side effect. An
  // unknown platform (a value outside the frozen host vocabulary) is refused
  // here instead of being coerced to a verified host, so the contract gate can
  // never install artifacts for the wrong platform. A known-but-unverified host
  // (e.g. win32/x64) is passed through and refused cleanly by
  // `unsupportedCombinationReason` before any download/install.
  const host = resolveHostPlatform(process.platform, process.arch);
  if (host === undefined) {
    dialog.showErrorBox(
      '不支持的平台',
      `HDSL 无法识别当前平台 ${process.platform}/${process.arch}，已停止启动以避免下载不匹配的受管运行时产物。`,
    );
    app.quit();
    return;
  }
  const dataRoot = resolveDataRoot({
    argv: process.argv,
    env: process.env,
    userDataDirectory: app.getPath('userData'),
  });
  const created = await createDesktopComposition({
    dataRoot,
    host,
    appInfo: {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
    },
    openWebUi: openVerifiedWebUi,
    pathChooser: options.pathChooser ?? nativePathChooser,
    lockWaitTimeoutMs: DATA_ROOT_LOCK_WAIT_MS,
  });
  composition = created;
  if (!created.available) {
    // Fixed, secret-free attribution signal written BEFORE the modal box, so an
    // operator/QA can attribute the refusal without a window or a page.
    process.stderr.write(
      formatDataRootUnavailableSignal(dataRootUnavailableReason(created.lockSnapshot())),
    );
    dialog.showErrorBox(
      '数据目录被占用',
      '另一个 HDSL 实例正在使用该数据目录，或独占锁无法获取。\n请关闭另一个实例后重试。',
    );
    // Do not write evidence into an unlocked data root; only release whatever
    // this instance might still hold, then exit with a clear non-zero code.
    await created.close();
    app.exit(1);
    return;
  }
  ipcHost = new DesktopIpcHost({
    port: created.port,
    policy: TRUSTED_URL_POLICY,
    beforeDispatch: async (context) => {
      if (composition === undefined) {
        return undefined;
      }
      if (isBlockedByRecovery(context.method, composition.recoveryBlocked)) {
        if (!recoveryNoticeShown) {
          recoveryNoticeShown = true;
          dialog.showMessageBoxSync({
            type: 'warning',
            message: '存在未能确认停止的受管进程',
            detail:
              '上次退出时未能证明一个受管进程已停止。为避免覆盖归属或并发写入，新建/启动/切换版本已被禁用；请先人工确认并清理残留进程后重启。',
          });
        }
        return contractFail(API_VERSION, contractErrorForCode('ENVIRONMENT_BUSY'));
      }
      if (context.environmentId === null) {
        return undefined;
      }
      if (context.method === 'environments.start') {
        await promptMissingCredentials(context.environmentId);
        return undefined;
      }
      if (context.method !== 'environments.openWebUI') {
        return undefined;
      }
      // A replayed requestId already has a stored result: dispatch returns it
      // and the side effect must not run twice.
      const requestId = isPlainRecord(context.input) ? context.input['requestId'] : undefined;
      if (
        typeof requestId === 'string' &&
        composition.port.readIdempotency(requestId) !== undefined
      ) {
        return undefined;
      }
      const opened = await composition.openWebUi(context.environmentId);
      if (!opened.ok) {
        return contractFail(API_VERSION, contractErrorForCode(opened.code));
      }
      return undefined;
    },
  });
  // FR-005 projection: a managed process that exits on its own updates core
  // state outside any renderer-issued operation. Forward that authoritative
  // summary to every window so the UI converges without a manual refresh.
  created.onEnvironmentChanged((environment) => {
    ipcHost?.broadcastEnvironmentUpdate(environment);
  });
  registerIpc(options);
  await createLauncherWindow();
  rebuildMenu(options);
  runStartupImport(options);
};

const focusMainWindow = (): void => {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
};

/**
 * Applies the quit/close sequence. On a confirmed release the app quits
 * normally. When close cannot confirm release, main does **not** claim the lock
 * is still held: it reports the residue, exits non-zero, and relies on the next
 * instance's `recover()` plus the main-side recovery gate before any new
 * create/start.
 *
 * The failure path must never wait on a native modal: on macOS
 * `dialog.showErrorBox` runs a modal loop, so a dialog here would stall the very
 * exit it announces and leave the process lingering (issue #88). The residue is
 * reported through a fixed, secret-free stderr signal, and the lease/launch
 * records stay on disk as evidence for the next start's reconciliation.
 */
export const formatExitIncompleteSignal = (code: string): string =>
  `[hdsl] exit incomplete reason=${code}\n`;

const applyQuitSequence = (): void => {
  if (quitting || composition === undefined) {
    return;
  }
  quitting = true;
  const target = composition;
  void target
    .close()
    .then((report) => {
      if (report.released) {
        app.quit();
        return;
      }
      process.stderr.write(formatExitIncompleteSignal(report.failure?.code ?? 'INTERNAL_ERROR'));
      app.exit(1);
    })
    .catch(() => {
      process.stderr.write(formatExitIncompleteSignal('INTERNAL_ERROR'));
      app.exit(1);
    });
};

export const startDesktopApp = (options: DesktopAppOptions = {}): void => {
  // Product identity (issue #149) must be settled before anything derives a
  // path or shows a dialog from it:
  //   - `app.getName()` returns the top-level `productName` (`HDSL`) instead of
  //     the scoped npm name `@hdsl/desktop`;
  //   - the About dialog is given the full semantic version, because the
  //     Windows version resource's `ProductVersion` field cannot carry the
  //     prerelease (`0.1.0.0` vs `0.1.0-preview.1`);
  //   - a populated directory left by the old scoped name is moved to the new
  //     default `userData` path before the single-instance lock or any window
  //     uses it, so no existing preview data is silently abandoned.
  app.setName(PRODUCT_NAME);
  app.setAboutPanelOptions(aboutPanelContent(app.getVersion()));
  const userData = resolveUserDataDirectory({
    appDataDirectory: app.getPath('appData'),
    userDataDirectory: app.getPath('userData'),
  });
  if (userData.directory !== app.getPath('userData')) {
    app.setPath('userData', userData.directory);
  }
  if (userData.note !== undefined) {
    process.stderr.write(formatUserDataSignal(userData.note));
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', focusMainWindow);
  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting || composition === undefined) {
      return;
    }
    event.preventDefault();
    applyQuitSequence();
  });
  app.whenReady().then(
    () => bootstrap(options),
    (error: unknown) => {
      dialog.showErrorBox(
        'HDSL 启动失败',
        error instanceof Error ? error.message : 'unknown startup error',
      );
      app.quit();
    },
  );
};
