/**
 * Application menu (T006 / issue #6; platform split for issue #150).
 *
 * The credential configuration entry is a **native application-menu** action:
 * main owns the file chooser, reads the document, validates it and calls the
 * trusted core API. No renderer-supplied path is involved and the menu entry is
 * disabled until an environment selection has been validated.
 *
 * The template is plain data returned by a pure function so it can be asserted
 * without booting Electron; only `electron` types are referenced. The platform
 * is an explicit parameter with the running platform as default, so callers do
 * not have to change and every platform branch stays testable.
 *
 * Windows and Linux get the conventional File/Edit/View/Window/Help categories
 * plus the domain "环境" menu; macOS keeps its application menu
 * (`about`/`hide`/`hideOthers`/`unhide`/`quit`) and uses a native Window menu.
 * Roles documented as macOS-only (`hide`, `hideOthers`, `unhide`, `zoom`,
 * `front`) are never emitted on other platforms: they stay focusable but do
 * nothing there, which is the dead-item defect from issue #150. No menu is
 * emitted without at least one working entry.
 */
import type { MenuItemConstructorOptions } from 'electron';

export interface CredentialMenuActions {
  /** Opens the native reference-file chooser for the validated selection. */
  importCredentialReferences(): void;
}

export interface CredentialMenuState {
  /** True when the focused window has a validated environment selection. */
  readonly hasSelectableEnvironment: boolean;
}

export const APP_MENU_LABEL = 'HDSL';
export const FILE_MENU_LABEL = '文件';
export const EDIT_MENU_LABEL = '编辑';
export const VIEW_MENU_LABEL = '视图';
export const WINDOW_MENU_LABEL = '窗口';
export const HELP_MENU_LABEL = '帮助';
export const ENVIRONMENT_MENU_LABEL = '环境';

export const CREDENTIAL_IMPORT_MENU_LABEL = '导入环境凭据引用…';
export const ABOUT_MENU_LABEL = '关于 HDSL';
export const QUIT_MENU_LABEL = '退出';
export const RELOAD_MENU_LABEL = '重新加载';
export const FORCE_RELOAD_MENU_LABEL = '强制重新加载';
export const MINIMIZE_MENU_LABEL = '最小化';
export const CLOSE_WINDOW_MENU_LABEL = '关闭窗口';
export const ZOOM_MENU_LABEL = '缩放';
export const BRING_ALL_TO_FRONT_MENU_LABEL = '全部置于顶层';

/**
 * Roles Electron documents as macOS-only. Emitting them elsewhere produces
 * focusable but inert menu items (the Windows `hide`/`hideOthers`/`unhide`
 * defect), so they are confined to the darwin template.
 */
export const DARWIN_ONLY_ROLES = ['hide', 'hideOthers', 'unhide', 'zoom', 'front'] as const;

const editMenu = (): MenuItemConstructorOptions => ({
  label: EDIT_MENU_LABEL,
  submenu: [
    { label: '撤销', role: 'undo' },
    { label: '重做', role: 'redo' },
    { type: 'separator' },
    { label: '剪切', role: 'cut' },
    { label: '复制', role: 'copy' },
    { label: '粘贴', role: 'paste' },
    { type: 'separator' },
    { label: '全选', role: 'selectAll' },
  ],
});

/** Reload belongs to "视图" on every platform (issue #150). */
const viewMenu = (): MenuItemConstructorOptions => ({
  label: VIEW_MENU_LABEL,
  submenu: [
    { label: RELOAD_MENU_LABEL, role: 'reload' },
    { label: FORCE_RELOAD_MENU_LABEL, role: 'forceReload' },
  ],
});

const environmentMenu = (
  actions: CredentialMenuActions,
  state: CredentialMenuState,
): MenuItemConstructorOptions => ({
  label: ENVIRONMENT_MENU_LABEL,
  submenu: [
    {
      id: 'hdsl-import-credentials',
      label: CREDENTIAL_IMPORT_MENU_LABEL,
      enabled: state.hasSelectableEnvironment,
      click: () => {
        actions.importCredentialReferences();
      },
    },
  ],
});

/** macOS application menu: product name, about, hide family and quit. */
const darwinAppMenu = (): MenuItemConstructorOptions => ({
  label: APP_MENU_LABEL,
  submenu: [
    { label: ABOUT_MENU_LABEL, role: 'about' },
    { type: 'separator' },
    { label: '隐藏 HDSL', role: 'hide' },
    { label: '隐藏其他', role: 'hideOthers' },
    { label: '全部显示', role: 'unhide' },
    { type: 'separator' },
    { label: QUIT_MENU_LABEL, role: 'quit' },
  ],
});

const darwinWindowMenu = (): MenuItemConstructorOptions => ({
  label: WINDOW_MENU_LABEL,
  submenu: [
    { label: MINIMIZE_MENU_LABEL, role: 'minimize' },
    { label: ZOOM_MENU_LABEL, role: 'zoom' },
    { type: 'separator' },
    { label: BRING_ALL_TO_FRONT_MENU_LABEL, role: 'front' },
  ],
});

/** Windows/Linux File menu; `about` lives in "帮助" there, not here. */
const nonDarwinFileMenu = (): MenuItemConstructorOptions => ({
  label: FILE_MENU_LABEL,
  submenu: [{ label: QUIT_MENU_LABEL, role: 'quit' }],
});

/** Windows/Linux Window menu uses only cross-platform roles. */
const nonDarwinWindowMenu = (): MenuItemConstructorOptions => ({
  label: WINDOW_MENU_LABEL,
  submenu: [
    { label: MINIMIZE_MENU_LABEL, role: 'minimize' },
    { label: CLOSE_WINDOW_MENU_LABEL, role: 'close' },
  ],
});

/** Keeps the About entry reachable without the macOS application menu. */
const nonDarwinHelpMenu = (): MenuItemConstructorOptions => ({
  label: HELP_MENU_LABEL,
  submenu: [{ label: ABOUT_MENU_LABEL, role: 'about' }],
});

export const buildApplicationMenuTemplate = (
  actions: CredentialMenuActions,
  state: CredentialMenuState,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] =>
  platform === 'darwin'
    ? [darwinAppMenu(), editMenu(), viewMenu(), darwinWindowMenu(), environmentMenu(actions, state)]
    : [
        nonDarwinFileMenu(),
        editMenu(),
        viewMenu(),
        nonDarwinWindowMenu(),
        environmentMenu(actions, state),
        nonDarwinHelpMenu(),
      ];
