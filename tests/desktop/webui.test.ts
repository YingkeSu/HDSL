/**
 * Main-only WebUI opener tests (T006 / issue #6).
 *
 * Proves the success/failure binding required by the orchestration: the opener
 * awaits the runtime `consumeWebUIBootstrap` (which awaits the open callback),
 * never reports success after an async failure, and never returns or logs the
 * token-bearing bootstrap URL.
 */
import { describe, expect, it, vi } from 'vitest';
import { portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import type { ManagedProcessPort } from '@hdsl/core';
import type {
  VerifiedWebUiContext,
  WebUiBootstrapCapability,
} from '../../apps/desktop/src/main/composition.js';
import { createVerifiedWebUiOpener } from '../../apps/desktop/src/main/webui.js';

const BASE_URL = 'http://127.0.0.1:53123/?token=canary-bootstrap';

const context = (
  bootstrap?: WebUiBootstrapCapability,
): VerifiedWebUiContext => ({
  environmentId: 'env-abc12345',
  loopbackOrigin: 'http://127.0.0.1:53123',
  processPort: {} as ManagedProcessPort,
  ...(bootstrap === undefined ? {} : { webUiBootstrap: bootstrap }),
});

const capability = (
  consume: (
    environmentId: string,
    open: (url: string) => void | Promise<void>,
  ) => Promise<PortOutcome<void>>,
): WebUiBootstrapCapability => ({ consumeWebUIBootstrap: consume });

describe('createVerifiedWebUiOpener', () => {
  it('fails with WEBUI_UNAVAILABLE when the runtime bootstrap capability is absent', async () => {
    const openExternal = vi.fn(async () => undefined);
    const outcome = await createVerifiedWebUiOpener(openExternal)(context());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('WEBUI_UNAVAILABLE');
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('awaits the bootstrap and returns only the loopback origin', async () => {
    const openExternal = vi.fn(async () => undefined);
    const bootstrap = capability(async (_environmentId, open) => {
      await open(BASE_URL);
      return portOk(undefined);
    });
    const outcome = await createVerifiedWebUiOpener(openExternal)(context(bootstrap));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual({ loopbackOrigin: 'http://127.0.0.1:53123' });
      expect(JSON.stringify(outcome)).not.toContain('canary-bootstrap');
    }
    expect(openExternal).toHaveBeenCalledWith(BASE_URL);
  });

  it('maps a bootstrap failure to its controlled code', async () => {
    const bootstrap = capability(async () => portFail('WEBUI_UNAVAILABLE', 'no bootstrap'));
    const outcome = await createVerifiedWebUiOpener(async () => undefined)(context(bootstrap));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('WEBUI_UNAVAILABLE');
    }
  });

  it('never reports success when the open callback failed', async () => {
    const bootstrap = capability(async (_environmentId, open) => {
      // Swallow the callback error and claim success: the opener must still
      // refuse to report opened=true.
      try {
        await open(BASE_URL);
      } catch {
        // ignored on purpose
      }
      return portOk(undefined);
    });
    const outcome = await createVerifiedWebUiOpener(async () => {
      throw new Error('openExternal failed');
    })(context(bootstrap));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('WEBUI_UNAVAILABLE');
    }
  });
});
