/**
 * Browser entry for the React renderer (T006 / issue #6).
 *
 * Bundled by `scripts/build-renderer.mjs` into `dist/renderer/app.js`. It mounts
 * only through the injected preload bridge; a missing bridge is a fatal
 * misconfiguration, not a fallback to the developer demo.
 */
import { startProductionRenderer } from './production.js';

const renderFatal = (message: string): void => {
  const container = document.getElementById('root');
  if (container !== null) {
    container.textContent = message;
    container.setAttribute('role', 'alert');
  }
};

const start = (): void => {
  try {
    void startProductionRenderer();
  } catch (error) {
    renderFatal(
      `启动器界面无法连接主进程：${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
