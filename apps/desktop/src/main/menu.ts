/**
 * Application menu (T006 / issue #6).
 *
 * The credential configuration entry is a **native application-menu** action:
 * main owns the file chooser, reads the document, validates it and calls the
 * trusted core API. No renderer-supplied path is involved and the menu entry is
 * disabled until an environment selection has been validated.
 *
 * The template is plain data returned by a pure function so it can be asserted
 * without booting Electron; only `electron` types are referenced.
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

export const CREDENTIAL_IMPORT_MENU_LABEL = '导入环境凭据引用…';
export const ENVIRONMENT_MENU_LABEL = '环境';

export const buildApplicationMenuTemplate = (
  actions: CredentialMenuActions,
  state: CredentialMenuState,
): MenuItemConstructorOptions[] => [
  {
    label: 'HDSL',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  },
  {
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
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
    ],
  },
];
