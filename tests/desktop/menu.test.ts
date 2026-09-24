/**
 * Platform application-menu template tests (T006 / issue #6; issue #150).
 *
 * The menu is plain data, so the platform branches, labels, role placement and
 * the import entry's enablement/click wiring are asserted without booting
 * Electron. Verified platforms are the template branches (`darwin`, `win32`,
 * `linux`); the real native Windows menu is not exercised here.
 */
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  ABOUT_MENU_LABEL,
  APP_MENU_LABEL,
  buildApplicationMenuTemplate,
  CREDENTIAL_IMPORT_MENU_LABEL,
  DARWIN_ONLY_ROLES,
  EDIT_MENU_LABEL,
  ENVIRONMENT_MENU_LABEL,
  FILE_MENU_LABEL,
  FORCE_RELOAD_MENU_LABEL,
  HELP_MENU_LABEL,
  RELOAD_MENU_LABEL,
  VIEW_MENU_LABEL,
  WINDOW_MENU_LABEL,
} from '../../apps/desktop/src/main/menu.js';

type Platform = NodeJS.Platform;

const PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'linux'];
const NON_DARWIN: readonly Platform[] = ['win32', 'linux'];

const templateFor = (
  platform: Platform,
  enabled = true,
  action: () => void = () => undefined,
): MenuItemConstructorOptions[] =>
  buildApplicationMenuTemplate({ importCredentialReferences: action }, {
    hasSelectableEnvironment: enabled,
  }, platform);

const submenuOf = (
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] => {
  const menu = template.find((entry) => entry.label === label);
  if (menu === undefined || !Array.isArray(menu.submenu)) {
    throw new Error(`menu ${label} was not found`);
  }
  return menu.submenu;
};

const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);

const rolesIn = (items: MenuItemConstructorOptions[]): string[] =>
  flatten(items).flatMap((item) => (item.role === undefined ? [] : [item.role]));

const importItem = (platform: Platform, enabled: boolean, action: () => void): MenuItemConstructorOptions => {
  const items = flatten(templateFor(platform, enabled, action)).filter(
    (item) => item.id === 'hdsl-import-credentials',
  );
  expect(items).toHaveLength(1);
  return items[0] as MenuItemConstructorOptions;
};

describe('application menu', () => {
  it('builds the platform-appropriate top-level categories', () => {
    expect(templateFor('darwin').map((menu) => menu.label)).toEqual([
      APP_MENU_LABEL,
      EDIT_MENU_LABEL,
      VIEW_MENU_LABEL,
      WINDOW_MENU_LABEL,
      ENVIRONMENT_MENU_LABEL,
    ]);
    for (const platform of NON_DARWIN) {
      expect(templateFor(platform).map((menu) => menu.label)).toEqual([
        FILE_MENU_LABEL,
        EDIT_MENU_LABEL,
        VIEW_MENU_LABEL,
        WINDOW_MENU_LABEL,
        ENVIRONMENT_MENU_LABEL,
        HELP_MENU_LABEL,
      ]);
    }
  });

  it('keeps the macOS application menu with its hide family', () => {
    const appMenu = submenuOf(templateFor('darwin'), APP_MENU_LABEL);
    expect(appMenu.map((item) => item.role ?? 'separator')).toEqual([
      'about',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ]);
  });

  it('omits macOS-only roles from win32 and linux', () => {
    for (const platform of NON_DARWIN) {
      const roles = rolesIn(templateFor(platform));
      for (const role of DARWIN_ONLY_ROLES) {
        expect(roles, `${platform} must not expose ${role}`).not.toContain(role);
      }
    }
  });

  it('places reload and forceReload in the View menu on every platform', () => {
    for (const platform of PLATFORMS) {
      const template = templateFor(platform);
      const view = submenuOf(template, VIEW_MENU_LABEL);
      expect(view.map((item) => item.role)).toEqual(['reload', 'forceReload']);
      expect(view.map((item) => item.label)).toEqual([RELOAD_MENU_LABEL, FORCE_RELOAD_MENU_LABEL]);
      expect(submenuOf(template, ENVIRONMENT_MENU_LABEL).map((item) => item.role)).not.toContain('reload');
      expect(submenuOf(template, ENVIRONMENT_MENU_LABEL).map((item) => item.role)).not.toContain('forceReload');
    }
  });

  it('keeps exactly one credential-import item inside the environment menu', () => {
    for (const platform of PLATFORMS) {
      const template = templateFor(platform);
      const environment = submenuOf(template, ENVIRONMENT_MENU_LABEL);
      const imports = environment.filter((item) => item.id === 'hdsl-import-credentials');
      expect(imports).toHaveLength(1);
      expect(imports[0]?.label).toBe(CREDENTIAL_IMPORT_MENU_LABEL);
      expect(flatten(template).filter((item) => item.id === 'hdsl-import-credentials')).toHaveLength(1);
    }
  });

  it('keeps about and quit reachable on every platform', () => {
    expect(rolesIn(templateFor('darwin'))).toEqual(expect.arrayContaining(['about', 'quit']));
    for (const platform of NON_DARWIN) {
      expect(submenuOf(templateFor(platform), HELP_MENU_LABEL).map((item) => item.role)).toEqual(['about']);
      expect(submenuOf(templateFor(platform), FILE_MENU_LABEL).map((item) => item.role)).toEqual(['quit']);
      expect(submenuOf(templateFor(platform), HELP_MENU_LABEL)[0]?.label).toBe(ABOUT_MENU_LABEL);
    }
  });

  it('uses only cross-platform window roles outside darwin', () => {
    const windowRoles = (platform: Platform): string[] =>
      submenuOf(templateFor(platform), WINDOW_MENU_LABEL).flatMap((item) =>
        item.role === undefined ? [] : [item.role],
      );
    expect(windowRoles('win32')).toEqual(['minimize', 'close']);
    expect(windowRoles('darwin')).toEqual(['minimize', 'zoom', 'front']);
  });

  it('never emits an empty menu or an entry without a role or click handler', () => {
    for (const platform of PLATFORMS) {
      const template = templateFor(platform);
      expect(template.length).toBeGreaterThan(0);
      for (const menu of template) {
        expect(Array.isArray(menu.submenu)).toBe(true);
        const submenu = Array.isArray(menu.submenu) ? menu.submenu : [];
        expect(submenu.length).toBeGreaterThan(0);
        for (const item of submenu) {
          if (item.type === 'separator') {
            continue;
          }
          expect(
            item.role !== undefined || typeof item.click === 'function',
            `${platform}/${String(menu.label)}/${String(item.label)} must not be inert`,
          ).toBe(true);
        }
      }
    }
  });

  it('defaults to the running platform', () => {
    const action = (): void => undefined;
    const defaultTemplate = buildApplicationMenuTemplate(
      { importCredentialReferences: action },
      { hasSelectableEnvironment: true },
    );
    const explicit = templateFor(process.platform, true, action);
    expect(defaultTemplate.map((menu) => menu.label)).toEqual(explicit.map((menu) => menu.label));
    expect(rolesIn(defaultTemplate)).toEqual(rolesIn(explicit));
  });

  it('disables the import entry until an environment selection is validated', () => {
    for (const platform of PLATFORMS) {
      expect(importItem(platform, false, () => undefined).enabled).toBe(false);
      expect(importItem(platform, true, () => undefined).enabled).toBe(true);
    }
  });

  it('invokes the native import action and exposes no extra launcher command', () => {
    for (const platform of PLATFORMS) {
      const action = vi.fn();
      const item = importItem(platform, true, action);
      (item.click as () => void)();
      expect(action).toHaveBeenCalledTimes(1);
    }
  });
});
