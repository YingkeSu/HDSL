import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';

const ENABLED = process.env['HDSL_E2E_DESKTOP'] === '1';

describe.skipIf(!ENABLED)('production desktop shutdown (#88)', () => {
  afterEach(cleanupAllHarnesses);

  for (const trigger of ['SIGTERM', 'window-close'] as const) {
    it(`releases its lease and exits after ${trigger}`, async () => {
      const harness = appHarness();
      const { app, cdp } = await bootApp(harness, `quit-${trigger}`);
      const lease = join(app.dataRoot, 'locks', 'data-root.lock', 'lease.json');
      expect(existsSync(lease)).toBe(true);

      if (trigger === 'SIGTERM') {
        process.kill(app.pid, 'SIGTERM');
      } else {
        // Dispatch after the CDP response so connection closure is not the verdict.
        await cdp.evaluate('setTimeout(() => window.close(), 50)');
      }

      const exit = await app.waitForExit(10_000).catch((error: unknown) => {
        throw new Error(`${String(error)}; lease remains=${existsSync(lease)}`);
      });
      expect(exit).toEqual({ code: 0, signal: null });
      expect(existsSync(lease)).toBe(false);
      expect(app.output()).not.toContain('Object has been destroyed');
    }, 45_000);
  }
});
