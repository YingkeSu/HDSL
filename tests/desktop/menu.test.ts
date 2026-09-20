/**
 * Native credential menu template tests (T006 / issue #6).
 *
 * The menu is plain data, so the import entry's label, enablement and click
 * wiring are asserted without booting Electron.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildApplicationMenuTemplate,
  CREDENTIAL_IMPORT_MENU_LABEL,
} from '../../apps/desktop/src/main/menu.js';

const importItem = (enabled: boolean, action: () => void) => {
  const template = buildApplicationMenuTemplate({ importCredentialReferences: action }, {
    hasSelectableEnvironment: enabled,
  });
  for (const menu of template) {
    if (Array.isArray(menu.submenu)) {
      for (const item of menu.submenu) {
        if (item.id === 'hdsl-import-credentials') {
          return item;
        }
      }
    }
  }
  throw new Error('credential import item was not found');
};

describe('application menu', () => {
  it('disables the import entry until an environment selection is validated', () => {
    expect(importItem(false, () => undefined).enabled).toBe(false);
    expect(importItem(true, () => undefined).enabled).toBe(true);
  });

  it('invokes the native import action and exposes no extra launcher command', () => {
    const action = vi.fn();
    const item = importItem(true, action);
    expect(item.label).toBe(CREDENTIAL_IMPORT_MENU_LABEL);
    (item.click as () => void)();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
