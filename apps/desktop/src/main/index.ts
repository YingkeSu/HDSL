/**
 * Electron main entry (T006 / issue #6).
 *
 * Boots the exclusive data-root composition, opens one launcher window with the
 * sandboxed preload bridge, registers the two IPC channels and the native
 * credential menu, and releases the data-root lease on quit. It never loads the
 * managed DSH WebUI: `openWebUI` verifies the current managed process and then
 * hands only the verified loopback origin to the injected main-only opener.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} from 'electron';
import {
  API_VERSION,
  contractErrorForCode,
  contractFail,
  isPlainRecord,
  portOk,
  type ErrorCode,
  type OpenWebUIResult,
  type PortOutcome,
} from '@hdsl/contracts';
import {
  createDesktopComposition,
  type DesktopComposition,
  type VerifiedWebUiContext,
  type VerifiedWebUiOpener,
} from './composition.js';
import {
  applyCredentialFile,
  hasLaunchCredentialReference,
} from './credential-import.js';
import { resolveDataRoot } from './data-root.js';
import type { DiagnosticsPathChooser } from './exporter.js';
import {
  DesktopIpcHost,
  HDSL_CONTRACT_CHANNEL,
  HDSL_OPERATION_UPDATED_CHANNEL,
  HDSL_SELECTION_CHANNEL,
  isAuthorizedSender,
  type SenderIdentity,
} from './ipc.js';
import { buildApplicationMenuTemplate } from './menu.js';
import { applyWindowSecurity, SECURE_WINDOW_DEFAULTS } from './security.js';

export { SECURE_WINDOW_DEFAULTS } from './security.js';
export { DATA_ROOT_ENV, DATA_ROOT_FLAG, resolveDataRoot } from './data-root.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RENDERER_INDEX = join(HERE, '..', 'renderer', 'index.html');
const PRELOAD_BRIDGE = join(HERE, '..', 'preload', 'bridge.cjs');
const RENDERER_URL_PREFIX = pathToFileURL(RENDERER_INDEX).href;
const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 780;
const DATA_ROOT_LOCK_WAIT_MS = 1500;

/**
 * Operator-controlled hooks for headless/CDP runs. They replace a native
 * dialog with a fixed path and never accept a renderer-supplied path. Both are
 * inert unless the environment variable is set; they are documented as
 * development/acceptance hooks, not user features.
 */
export const ENV_EXPORT_PATH = 'HDSL_DIAGNOSTICS_EXPORT_PATH';
export const ENV_IMPORT_PATH = 'HDSL_CREDENTIAL_IMPORT_PATH';
export const ENV_IMPORT_ENVIRONMENT = 'HDSL_CREDENTIAL_IMPORT_ENVIRONMENT';

/**
 * Runtime capabilities main may use but `ManagedProcessPort` does not declare.
 * `consumeWebUIBootstrap` is owned by the runtime WebUI slice; when it is
 * absent (older runtime or an adopted process with no in-memory bootstrap) main
 * must NOT open the token-free origin, which would only 401.
 */
interface WebUiBootstrapConsumer {
  consumeWebUIBootstrap(
    environmentId: string,
    open: (bootstrapUrl: string) => void | Promise<void>,
  ): Promise<PortOutcome<void>>;
}

const consumeWebUIBootstrap = (
  context: VerifiedWebUiContext,
): WebUiBootstrapConsumer['consumeWebUIBootstrap'] | undefined => {
  const candidate = (context.processPort as { readonly consumeWebUIBootstrap?: unknown })
    .consumeWebUIBootstrap;
  if (typeof candidate !== 'function') {
    return undefined;
  }
  return (candidate as WebUiBootstrapConsumer['consumeWebUIBootstrap']).bind(context.processPort);
};

const portFailCode = (code: ErrorCode, message: string): PortOutcome<never> => ({
  ok: false,
  code,
  message,
});

/**
 * Default main-only opener. The bootstrap URL is handed only to the OS browser
 * through this callback; it is never returned, logged, persisted or placed in a
 * diagnostic. Success is reported only after `consumeWebUIBootstrap` resolves
 * with the real open result, so a failed open cannot report `opened: true`.
 */
export const openVerifiedWebUi: VerifiedWebUiOpener = async (
  context: VerifiedWebUiContext,
): Promise<PortOutcome<OpenWebUIResult>> => {
  const consume = consumeWebUIBootstrap(context);
  if (consume === undefined) {
    return portFailCode(
      'WEBUI_UNAVAILABLE',
      'authenticated WebUI bootstrap is unavailable for this managed process',
    );
  }
  let callbackFailure = false;
  const outcome = await consume(context.environmentId, async (bootstrapUrl: string) => {
    try {
      await shell.openExternal(bootstrapUrl);
    } catch (error) {
      callbackFailure = true;
      throw error;
    }
  });
  if (!outcome.ok) {
    return portFailCode(outcome.code, outcome.message);
  }
  if (callbackFailure) {
    return portFailCode('WEBUI_UNAVAILABLE', 'the authenticated WebUI could not be opened');
  }
  return portOk({ loopbackOrigin: context.loopbackOrigin });
};

const dialogPathChooser: DiagnosticsPathChooser = {
  chooseExportPath(defaultFileName: string): string | null {
    const fixed = process.env[ENV_EXPORT_PATH];
    if (fixed !== undefined && fixed.trim() !== '') {
      return fixed;
    }
    const result = dialog.showSaveDialogSync({
      title: '导出脱敏诊断',
      defaultPath: defaultFileName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return result ?? null;
  },
};

let composition: DesktopComposition | undefined;
let mainWindow: BrowserWindow | undefined;
let ipcHost: DesktopIpcHost | undefined;
let quitting = false;

const senderIdentity = (event: {
  readonly sender: { readonly id: number; readonly mainFrame?: unknown };
  readonly senderFrame?: unknown;
}): SenderIdentity => {
  const frame = event.senderFrame as { readonly url?: string } | null | undefined;
  return {
    webContentsId: event.sender.id,
    isMainFrame:
      frame !== null && frame !== undefined && frame === event.sender.mainFrame,
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

const rebuildMenu = (): void => {
  const template = buildApplicationMenuTemplate(
    { importCredentialReferences: () => { void importCredentialReferences(); } },
    { hasSelectableEnvironment: anyEnvironment() },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const importCredentialReferences = async (): Promise<void> => {
  if (composition === undefined || ipcHost === undefined) {
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
  const chosenPath = process.env[ENV_IMPORT_PATH];
  const filePath =
    chosenPath !== undefined && chosenPath.trim() !== ''
      ? chosenPath
      : (() => {
          const chosen = dialog.showOpenDialogSync({
            title: '选择凭据引用配置文件',
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }],
          });
          return chosen?.[0];
        })();
  if (filePath === undefined || filePath === '') {
    return;
  }
  const result = applyCredentialFile(composition.service, selectedId, filePath, (path) =>
    readFileSync(path, 'utf8'),
  );
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

/**
 * Headless hook: with both env vars set, import once at startup for a validated
 * environment and report only a secret-free status line on stderr. The native
 * success dialog is skipped so a CDP-driven run does not block on it.
 */
const runStartupCredentialHook = (): void => {
  if (composition === undefined) {
    return;
  }
  const filePath = process.env[ENV_IMPORT_PATH];
  const environmentId = process.env[ENV_IMPORT_ENVIRONMENT];
  if (
    filePath === undefined ||
    filePath.trim() === '' ||
    environmentId === undefined ||
    environmentId.trim() === ''
  ) {
    return;
  }
  const environment = composition.port.findEnvironment(environmentId);
  if (!environment.ok) {
    process.stderr.write('[hdsl] credential-import hook: environment not found\n');
    return;
  }
  const result = applyCredentialFile(composition.service, environmentId, filePath, (path) =>
    readFileSync(path, 'utf8'),
  );
  process.stderr.write(
    result.ok
      ? `[hdsl] credential-import hook: applied ${String(result.count)} reference(s)\n`
      : `[hdsl] credential-import hook: rejected at ${result.stage}\n`,
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
  applyWindowSecurity(window, { allowedUrlPrefixes: [RENDERER_URL_PREFIX] });
  ipcHost.openWindow({
    webContentsId: window.webContents.id,
    send: (event) => {
      if (!window.isDestroyed()) {
        window.webContents.send(HDSL_OPERATION_UPDATED_CHANNEL, event);
      }
    },
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  window.on('closed', () => {
    ipcHost?.closeWindow(window.webContents.id);
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  await window.loadFile(RENDERER_INDEX);
};

const registerIpc = (): void => {
  const host = ipcHost;
  if (host === undefined) {
    return;
  }
  ipcMain.handle(HDSL_CONTRACT_CHANNEL, async (event, payload: unknown) => {
    const identity = senderIdentity(event);
    // The host re-checks the sender and returns a controlled envelope; the
    // sender is never trusted. Native prompts and the authenticated WebUI open
    // run in the host's async pre-dispatch hook.
    return host.handle(identity, payload);
  });
  ipcMain.on(HDSL_SELECTION_CHANNEL, (event, environmentId: unknown) => {
    const identity = senderIdentity(event);
    if (!isAuthorizedSender(identity, { rendererUrlPrefix: RENDERER_URL_PREFIX })) {
      return;
    }
    host.selectEnvironment(identity.webContentsId, environmentId);
    rebuildMenu();
  });
};

const bootstrap = async (): Promise<void> => {
  const dataRoot = resolveDataRoot({
    argv: process.argv,
    env: process.env,
    userDataDirectory: app.getPath('userData'),
  });
  const created = await createDesktopComposition({
    dataRoot,
    appInfo: {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
    },
    openWebUi: openVerifiedWebUi,
    pathChooser: dialogPathChooser,
    lockWaitTimeoutMs: DATA_ROOT_LOCK_WAIT_MS,
  });
  composition = created;
  if (!created.available) {
    dialog.showErrorBox(
      '数据目录被占用',
      `另一个 HDSL 实例正在使用该数据目录，或独占锁无法获取：\n${dataRoot}\n\n请关闭另一个实例后重试。`,
    );
    app.quit();
    return;
  }
  ipcHost = new DesktopIpcHost({
    port: created.port,
    policy: { rendererUrlPrefix: RENDERER_URL_PREFIX },
    beforeDispatch: async (context) => {
      if (context.environmentId === null || composition === undefined) {
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
      if (typeof requestId === 'string' && composition.port.readIdempotency(requestId) !== undefined) {
        return undefined;
      }
      const opened = await composition.openWebUi(context.environmentId);
      if (!opened.ok) {
        return contractFail(API_VERSION, contractErrorForCode(opened.code));
      }
      return undefined;
    },
  });
  registerIpc();
  await createLauncherWindow();
  rebuildMenu();
  runStartupCredentialHook();
};

const focusMainWindow = (): void => {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
};

const main = (): void => {
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
    quitting = true;
    const target = composition;
    void target
      .close()
      .then((report) => {
        if (!report.released) {
          dialog.showErrorBox(
            '退出未完全释放',
            `受管进程或数据目录锁未能确认释放（${report.failure?.code ?? 'INTERNAL_ERROR'}）。\n为避免其他实例误用，锁会保留，下次启动会重新对账。`,
          );
        }
      })
      .finally(() => {
        app.quit();
      });
  });
  app.whenReady().then(bootstrap, (error: unknown) => {
    dialog.showErrorBox(
      'HDSL 启动失败',
      error instanceof Error ? error.message : 'unknown startup error',
    );
    app.quit();
  });
};

void main();
