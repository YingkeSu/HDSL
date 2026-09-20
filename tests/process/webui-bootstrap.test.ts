/**
 * T006 prerequisite: main-only WebUI bootstrap consumption.
 *
 * DSH's token-free origin answers 401; the ready-line bootstrap URL is what
 * issues the `dsh-auth` cookie (T001 R004). These tests drive the capability
 * against the controlled fake DSH (which mimics 303 + Set-Cookie / 401 / 200)
 * and assert the bootstrap secret never reaches durable records or the contract
 * result. No model call is made.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessManager } from '@hdsl/runtime';
import type { LaunchCredentialPort } from '@hdsl/runtime';
import { createHarness, type Harness } from './support/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const open = async (options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> => {
  harness = await createHarness(options);
  return harness;
};

const launchRecordFile = (h: Harness): string => {
  const path = join(h.dataRoot, 'process', 'launches', `${h.environmentId}.json`);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

const unusedCredentials: LaunchCredentialPort = {
  resolveLaunchEnvironment: () =>
    Promise.resolve({ ok: false, code: 'INTERNAL_ERROR', message: 'unused stub' }),
};

describe('main-only WebUI bootstrap', () => {
  it('hands the bootstrap URL to main and authenticates the loopback origin', async () => {
    const h = await open();
    const started = await h.manager.start(h.request());
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) {
      return;
    }
    const origin = started.value.loopbackOrigin;

    const seen: string[] = [];
    const result = await h.manager.consumeWebUIBootstrap(h.environmentId, (url) => {
      seen.push(url);
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(seen).toHaveLength(1);
    const bootstrapUrl = seen[0] as string;
    expect(bootstrapUrl.startsWith(`${origin}/`)).toBe(true);
    expect(bootstrapUrl).toContain('?token=');

    // Token URL → 303 + dsh-auth cookie; token-free origin → 401; cookie → 200.
    const tokenResponse = await fetch(bootstrapUrl, { redirect: 'manual' });
    expect(tokenResponse.status).toBe(303);
    const setCookie = tokenResponse.headers.get('set-cookie') ?? '';
    expect(setCookie.toLowerCase()).toContain('dsh-auth-');
    const cookie = setCookie.split(';')[0] as string;

    const noCookie = await fetch(origin);
    expect(noCookie.status).toBe(401);

    const authenticated = await fetch(origin, { headers: { cookie } });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toContain('managed webui');

    // The bootstrap secret never reaches the durable launch record or the
    // contract's openWebUI result.
    const recordFile = launchRecordFile(h);
    expect(recordFile).not.toContain('token=');
    expect(recordFile).not.toContain(bootstrapUrl);
    const web = h.manager.openWebUI(h.environmentId);
    expect(web.ok).toBe(true);
    expect(JSON.stringify(web)).not.toContain('token=');
  });

  it('clears the bootstrap on stop and refuses to open afterwards', async () => {
    const h = await open();
    const stopped0 = await h.manager.start(h.request());
    expect(stopped0.ok).toBe(true);
    const stopped = await h.manager.stop(h.request());
    expect(stopped.ok).toBe(true);

    let called = false;
    const result = await h.manager.consumeWebUIBootstrap(h.environmentId, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WEBUI_UNAVAILABLE');
    }
  });

  it('fails with WEBUI_UNAVAILABLE when no launch was ever started', async () => {
    const h = await open();
    let called = false;
    const result = await h.manager.consumeWebUIBootstrap(h.environmentId, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WEBUI_UNAVAILABLE');
    }
  });

  it('never relays a thrown open error message', async () => {
    const h = await open();
    await h.manager.start(h.request());
    const secret = 'canary-open-failure-token';
    const result = await h.manager.consumeWebUIBootstrap(h.environmentId, () => {
      throw new Error(`open failed ${secret}`);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INTERNAL_ERROR');
      expect(result.message).not.toContain(secret);
    }
  });

  it('does not fall back to the 401 origin for a process this instance did not spawn', async () => {
    const h = await open();
    const started = await h.manager.start(h.request());
    expect(started.ok).toBe(true);

    // A second instance on the same dataRoot has no in-memory bootstrap for the
    // running process; it must fail rather than open the token-free 401 origin.
    const other = createProcessManager({ dataRoot: h.dataRoot, credentials: unusedCredentials });
    let called = false;
    const result = await other.consumeWebUIBootstrap(h.environmentId, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('WEBUI_UNAVAILABLE');
    }
  });
});
