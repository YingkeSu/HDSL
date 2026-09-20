/**
 * Electron main-process entry point.
 *
 * T002 scope: establish the compiled entry and the secure window defaults
 * documented in docs/architecture/tdd.md (context isolation on, Node
 * integration off, sandbox on). Creating windows, registering the narrow IPC
 * whitelist and wiring environment lifecycle belong to T003/T006, so no window
 * is opened and no product behavior is implemented here.
 */
import type { BrowserWindowConstructorOptions } from 'electron';

/** Web preferences every HDSL window must use; the renderer is never trusted. */
export const SECURE_WINDOW_DEFAULTS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} satisfies BrowserWindowConstructorOptions['webPreferences'];

/**
 * Placeholder for the real application bootstrap.
 *
 * It is deliberately not invoked at module load: running Electron today exits
 * without a window instead of presenting a fake launcher. T006 replaces this
 * with the real lifecycle and main-side use-case wiring.
 */
export function bootstrapDesktop(): never {
  throw new Error(
    'HDSL desktop shell is not implemented yet; see specs/001-environment-lifecycle/tasks.md T006.',
  );
}
