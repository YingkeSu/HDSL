/**
 * Product identity for the desktop shell (issue #149).
 *
 * Electron derives `app.getName()` from the packaged `package.json`: the
 * top-level `productName` field when present, otherwise the npm `name`. The
 * desktop package is scoped (`@hdsl/desktop`), so without a `productName`
 * Electron used the scope string as the application name. That string leaked
 * into the About dialog and window title, the main-process `appInfo.name`, and —
 * because Electron derives `userData` from the application name — the on-disk
 * data root (`appData/@hdsl/desktop`).
 *
 * This module keeps the product name, the About-panel content and the legacy
 * scoped name in one place so the packaged metadata, the runtime bootstrap and
 * the tests cannot drift apart.
 */

/** Product name used for `app.getName()`, the About dialog and `appInfo.name`. */
export const PRODUCT_NAME = 'HDSL';

/** npm package name used before a `productName` existed. */
export const LEGACY_PRODUCT_NAME = '@hdsl/desktop';

export interface AboutPanelContent {
  readonly applicationName: string;
  /** Full semantic version, e.g. `0.1.0-preview.1`. */
  readonly applicationVersion: string;
}

/**
 * About-panel content for the current platform defaults.
 *
 * Windows builds the default about dialog from the executable version resource
 * (`shell/browser/browser_win.cc`), whose `ProductVersion` field must stay in
 * the numeric `x.x.x.x` Windows form, so Electron defaulted to the truncated
 * `0.1.0.0`. Passing the full `app.getVersion()` explicitly is what makes the
 * dialog agree with the installed package version (`0.1.0-preview.1`) instead
 * of the resource value; macOS reads the same option as the short version.
 */
export const aboutPanelContent = (version: string): AboutPanelContent => ({
  applicationName: PRODUCT_NAME,
  applicationVersion: version,
});
