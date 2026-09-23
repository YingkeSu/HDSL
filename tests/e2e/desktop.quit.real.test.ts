import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

  it('exits non-zero without blocking on a modal when release cannot be confirmed', async () => {
    const harness = appHarness();
    const { app } = await bootApp(harness, 'quit-unreleased');
    const lease = join(app.dataRoot, 'locks', 'data-root.lock', 'lease.json');
    expect(existsSync(lease)).toBe(true);

    // A live pid with a mismatched kernel start token is an unverifiable managed
    // process: `close()` must refuse to report release. The quit path must then
    // exit non-zero with the fixed, secret-free signal instead of waiting on a
    // native modal (which on macOS blocks the very exit it announces).
    const launches = join(app.dataRoot, 'process', 'launches');
    mkdirSync(launches, { recursive: true });
    writeFileSync(
      join(launches, 'env-unverifiable000000.json'),
      JSON.stringify({
        schemaVersion: '1',
        environmentId: 'env-unverifiable000000',
        expectedRevision: 1,
        generationDirectory: join(
          app.dataRoot,
          'environments',
          'env-unverifiable000000',
          'generations',
          'gen-missing',
        ),
        commandFragment: 'hdsl-unverifiable-fixture',
        state: 'running',
        identity: {
          pid: process.pid,
          pgid: process.pid,
          startToken: 'Thu Jan  1 00:00:00 1970',
          commandFragment: 'hdsl-unverifiable-fixture',
          createdAt: '1970-01-01T00:00:00.000Z',
        },
        endpoint: null,
        exitCode: null,
        observedSurvivors: null,
        errorCode: null,
        errorDetail: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sequence: 1,
      }),
    );

    process.kill(app.pid, 'SIGTERM');
    const exit = await app.waitForExit(5_000).catch((error: unknown) => {
      throw new Error(`${String(error)}; lease remains=${existsSync(lease)}`);
    });
    expect(exit).toEqual({ code: 1, signal: null });
    expect(existsSync(lease)).toBe(true);
    expect(app.output()).toContain('[hdsl] exit incomplete reason=');
    expect(app.output()).not.toContain('Object has been destroyed');
  }, 45_000);
});
