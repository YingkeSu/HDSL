/**
 * T005 managed DSH lifecycle against a controlled child.
 *
 * The real Node binary spawns a fake DSH that reproduces the upstream
 * observable contract (ready line, EADDRINUSE, SIGTERM, a grandchild). This
 * exercises the real manager code paths; the real CLI is covered separately by
 * the opt-in evidence test.
 */
import { createServer, type Server } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPosixProcessProbe, isProcessAlive } from '@hdsl/runtime';
import type { ProcessExitEvent, ProcessProbe } from '@hdsl/runtime';
import {
  createHarness,
  FAKE_DSH_PATH,
  launchFixture,
  spawnDetachedProcess,
  waitFor,
  writeLaunchRecord,
  type Harness,
} from './support/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const open = async (options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> => {
  harness = await createHarness(options);
  return harness;
};

const listenOnRandomPort = async (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        resolve({ server, port: address.port });
      }
    });
  });

describe('managed DSH start', () => {
  it('becomes ready, records a kernel identity and exposes only a token-free loopback origin', async () => {
    const h = await open();
    const outcome = await h.manager.start(h.request());
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.loopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(outcome.value.loopbackOrigin).not.toContain('token');

    const record = h.manager.readLaunchRecord(h.environmentId);
    expect(record?.state).toBe('running');
    expect(record?.identity?.pid).toBe(outcome.value.pid);
    expect(record?.identity?.startToken.length).toBeGreaterThan(0);
    expect(record?.endpoint?.origin).toBe(outcome.value.loopbackOrigin);

    const web = h.manager.openWebUI(h.environmentId);
    expect(web.ok).toBe(true);
    if (web.ok) {
      expect(web.value.loopbackOrigin).toBe(outcome.value.loopbackOrigin);
    }

    // The credential handle is disposed exactly once, after the synchronous
    // spawn copy, and neither the secret nor the WebUI token is persisted.
    expect(h.credentialDisposals()).toBe(1);
    const serialized = JSON.stringify(h.manager.readLaunchRecord(h.environmentId));
    expect(serialized).not.toContain('canary-model-key');
    expect(serialized).not.toContain('token');
  });

  it('rejects a concurrent start for the same environment without spawning twice', async () => {
    const h = await open({ mode: 'never-ready', readinessTimeoutMs: 2_000 });
    const controller = new AbortController();
    const first = h.manager.start(h.request({ signal: controller.signal }));
    const second = await h.manager.start(h.request());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('ENVIRONMENT_BUSY');
    }
    controller.abort();
    await first;
  });

  it('disposes the credential handle when the executable cannot be spawned', async () => {
    const h = await open();
    const outcome = await h.manager.start(
      h.request({ nodeExecutable: join(h.dataRoot, 'missing', 'node') }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
    }
    expect(h.credentialDisposals()).toBe(1);
  });

  it('is idempotent against a running environment: no second process is spawned', async () => {
    const h = await open();
    const first = await h.manager.start(h.request());
    expect(first.ok).toBe(true);
    const info = await h.waitForInfo();

    const second = await h.manager.start(h.request());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('ENVIRONMENT_BUSY');
    }
    expect(h.readInfo()?.['pid']).toBe(info['pid']);
    expect(h.manager.listLaunchRecords()).toHaveLength(1);
  });

  it('fails with PORT_UNAVAILABLE when a fixed port is already taken', async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const h = await open();
      const outcome = await h.manager.start(h.request({ port }));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('PORT_UNAVAILABLE');
      }
      const record = h.manager.readLaunchRecord(h.environmentId);
      expect(record?.state).toBe('failed');
      expect(h.manager.openWebUI(h.environmentId).ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it('terminates the whole tree and reports START_TIMEOUT when readiness never arrives', async () => {
    const h = await open({ mode: 'never-ready', readinessTimeoutMs: 2_000 });
    const start = h.manager.start(h.request());
    const info = await h.waitForInfo();
    const outcome = await start;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('START_TIMEOUT');
    }
    await waitFor(() => !isProcessAlive(Number(info['pid'])));
    await waitFor(() => !isProcessAlive(Number(info['grandchildPid'])));
  });

  it('fails without leaking a value when no managed credential reference exists', async () => {
    const h = await open({ credential: false });
    const outcome = await h.manager.start(h.request());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
      expect(outcome.message).not.toContain('canary');
    }
    const record = h.manager.readLaunchRecord(h.environmentId);
    expect(record?.state).toBe('failed');
    expect(record?.identity).toBeNull();
    expect(h.readInfo()).toBeUndefined();
  });

  it('injects credentials through the explicit environment and never the host environment', async () => {
    process.env['__HDSL_HOST_LEAK__'] = 'host-secret';
    try {
      const h = await open({ credential: 'canary-model-key' });
      const outcome = await h.manager.start(h.request());
      expect(outcome.ok).toBe(true);
      const info = await h.waitForInfo();
      expect(info['hasCredential']).toBe(true);
      expect(info['home']).toBe(h.homeDirectory);
      expect(info['dshHome']).toBe(h.homeDirectory);
      expect(info['hostLeak']).toBeNull();
    } finally {
      delete process.env['__HDSL_HOST_LEAK__'];
    }
  });

  it('refuses to start a generation that is not a complete managed install', async () => {
    const h = await open();
    const outcome = await h.manager.start(h.request({ installMode: 'artifacts-only' }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
    }
  });

  it('replaces a record whose pid was reused by an unrelated process without signalling it', async () => {
    const h = await open();
    const sleeper = await spawnDetachedProcess();
    try {
      writeLaunchRecord(
        h.dataRoot,
        launchFixture(h.dataRoot, h.environmentId, {
          state: 'running',
          identity: { ...sleeper.identity, startToken: 'Thu Jan  1 00:00:00 1970' },
        }),
      );
      const outcome = await h.manager.start(h.request());
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(sleeper.isAlive()).toBe(true);
    } finally {
      sleeper.kill();
    }
  });

  it('refuses to start while a live pid cannot be verified at all', async () => {
    const h = await open({
      probe: {
        inspect: () => undefined,
        scan: () => [],
        findIdsByCommandFragment: () => [],
        tryFindIdsByCommandFragment: () => [],
        listProcessGroup: () => [],
      },
    });
    const sleeper = await spawnDetachedProcess();
    try {
      writeLaunchRecord(
        h.dataRoot,
        launchFixture(h.dataRoot, h.environmentId, {
          state: 'running',
          identity: sleeper.identity,
        }),
      );
      const outcome = await h.manager.start(h.request());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('INTERNAL_ERROR');
      }
      expect(sleeper.isAlive()).toBe(true);
    } finally {
      sleeper.kill();
    }
  });
});

describe('managed DSH stop', () => {
  it('terminates the owned tree (parent and grandchild) and clears readiness', async () => {
    const h = await open();
    const started = await h.manager.start(h.request());
    expect(started.ok).toBe(true);
    const info = await h.waitForInfo();

    const stopped = await h.manager.stop(h.request());
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
    if (stopped.ok) {
      expect(stopped.value.wasRunning).toBe(true);
      expect(stopped.value.pid).toBe(Number(info['pid']));
    }
    await waitFor(() => !isProcessAlive(Number(info['pid'])));
    await waitFor(() => !isProcessAlive(Number(info['grandchildPid'])));
    expect(h.manager.openWebUI(h.environmentId).ok).toBe(false);
    expect(h.manager.readLaunchRecord(h.environmentId)?.state).toBe('stopped');
  });

  it('cancels an in-flight start through the caller signal and cleans the tree', async () => {
    const h = await open({ mode: 'never-ready', readinessTimeoutMs: 30_000 });
    const controller = new AbortController();
    const start = h.manager.start(h.request({ signal: controller.signal }));
    const info = await h.waitForInfo();
    controller.abort();
    const outcome = await start;
    expect(outcome.ok).toBe(false);
    expect(h.credentialDisposals()).toBe(1);
    await waitFor(() => !isProcessAlive(Number(info['pid'])));
    await waitFor(() => !isProcessAlive(Number(info['grandchildPid'])));
  });

  it('does not signal an unrelated process while stopping its own tree', async () => {
    const h = await open();
    const bystander = await spawnDetachedProcess();
    try {
      const started = await h.manager.start(h.request());
      expect(started.ok).toBe(true);
      const info = await h.waitForInfo();
      const stopped = await h.manager.stop(h.request());
      expect(stopped.ok).toBe(true);
      await waitFor(() => !isProcessAlive(Number(info['pid'])));
      expect(bystander.isAlive()).toBe(true);
    } finally {
      bystander.kill();
    }
  });

  it('fails with INTERNAL_ERROR when no managed process is recorded', async () => {
    const h = await open();
    const outcome = await h.manager.stop(h.request());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('INTERNAL_ERROR');
    }
  });

  it('never kills a process that only shares the command fragment but not the generation directory', async () => {
    const h = await open();
    // A live process whose command line contains the shared fixture path but
    // not this environment's generation directory.
    const shared = spawn(
      process.execPath,
      [FAKE_DSH_PATH, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
      {
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', FAKE_DSH_MODE: 'never-ready' },
        detached: true,
        stdio: 'ignore',
      },
    );
    const sharedPid = shared.pid;
    shared.unref();
    if (sharedPid === undefined) {
      throw new Error('failed to spawn the shared fixture');
    }
    const probe = createPosixProcessProbe();
    await waitFor(() => probe.inspect(sharedPid) !== undefined);
    try {
      // An identity-free record for a different generation directory.
      writeLaunchRecord(
        h.dataRoot,
        launchFixture(h.dataRoot, h.environmentId, {
          state: 'spawning',
          identity: null,
          commandFragment: FAKE_DSH_PATH,
          generationDirectory: h.generationDirectory,
        }),
      );
      const closed = await h.manager.close();
      expect(closed.ok).toBe(true);
      expect(isProcessAlive(sharedPid)).toBe(true);
    } finally {
      try {
        process.kill(sharedPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
});

describe('unexpected exit and close', () => {
  it('reports an unexpected exit and records PROCESS_EXITED', async () => {
    const events: ProcessExitEvent[] = [];
    const h = await open({ exitAfterReadyMs: 200, onProcessExit: (event) => events.push(event) });
    const outcome = await h.manager.start(h.request());
    expect(outcome.ok).toBe(true);
    await waitFor(() => events.length > 0);
    expect(events[0]?.environmentId).toBe(h.environmentId);
    await waitFor(() => h.manager.readLaunchRecord(h.environmentId)?.state === 'stopped');
    expect(h.manager.readLaunchRecord(h.environmentId)?.errorCode).toBe('PROCESS_EXITED');
    expect(h.manager.openWebUI(h.environmentId).ok).toBe(false);
  });

  it('close stops every owned tree, awaits exit and then refuses new operations', async () => {
    const h = await open();
    const started = await h.manager.start(h.request());
    expect(started.ok).toBe(true);
    const info = await h.waitForInfo();

    const closed = await h.manager.close();
    expect(closed.ok, JSON.stringify(closed)).toBe(true);
    await waitFor(() => !isProcessAlive(Number(info['pid'])));
    await waitFor(() => !isProcessAlive(Number(info['grandchildPid'])));

    const after = await h.manager.start(h.request());
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.code).toBe('INTERNAL_ERROR');
    }
  });

  it('close refuses to report success while a live pid cannot be verified', async () => {
    const h = await open({
      probe: {
        inspect: () => undefined,
        scan: () => [],
        findIdsByCommandFragment: () => [],
        tryFindIdsByCommandFragment: () => [],
        listProcessGroup: () => [],
      },
    });
    const sleeper = await spawnDetachedProcess();
    try {
      writeLaunchRecord(
        h.dataRoot,
        launchFixture(h.dataRoot, h.environmentId, {
          state: 'running',
          identity: sleeper.identity,
        }),
      );
      const closed = await h.manager.close();
      expect(closed.ok).toBe(false);
      if (!closed.ok) {
        expect(closed.code).toBe('INTERNAL_ERROR');
      }
      expect(sleeper.isAlive()).toBe(true);
    } finally {
      sleeper.kill();
    }
  });

  it('cleans up a crashed parent\'s descendants before reporting close success', async () => {
    const h = await open();
    const started = await h.manager.start(h.request());
    expect(started.ok).toBe(true);
    const info = await h.waitForInfo();
    const parentPid = Number(info['pid']);
    const grandchildPid = Number(info['grandchildPid']);
    expect(isProcessAlive(grandchildPid)).toBe(true);

    // Simulate a crash of the group leader; the grandchild is orphaned in the
    // recorded process group and survives until close/reconcile resolves it.
    process.kill(parentPid, 'SIGKILL');
    await waitFor(() => !isProcessAlive(parentPid));
    expect(isProcessAlive(grandchildPid)).toBe(true);

    const closed = await h.manager.close();
    expect(closed.ok).toBe(true);
    expect(isProcessAlive(grandchildPid)).toBe(false);
  });

  it('close fails when the recorded process group cannot be scanned', async () => {
    const h = await open({
      probe: {
        inspect: () => undefined,
        scan: () => [],
        findIdsByCommandFragment: () => [],
        tryFindIdsByCommandFragment: () => undefined,
        listProcessGroup: () => undefined,
      },
    });
    const sleeper = await spawnDetachedProcess();
    const identity = sleeper.identity;
    sleeper.kill();
    await waitFor(() => !sleeper.isAlive());
    writeLaunchRecord(
      h.dataRoot,
      launchFixture(h.dataRoot, h.environmentId, { state: 'running', identity }),
    );
    const closed = await h.manager.close();
    expect(closed.ok).toBe(false);
  });
});

describe('scan availability (review P2-1 / issue #55)', () => {
  it('fails stop and close when the process scan is unavailable', async () => {
    const h = await open({ probe: createPosixProcessProbe({ psPath: '/nonexistent/ps-hdsl' }) });
    writeLaunchRecord(
      h.dataRoot,
      launchFixture(h.dataRoot, h.environmentId, {
        state: 'running',
        identity: null,
        commandFragment: '/nonexistent/shared-dsh.js',
        generationDirectory: h.generationDirectory,
      }),
    );
    const stopped = await h.manager.stop(h.request());
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) {
      expect(stopped.code).toBe('INTERNAL_ERROR');
    }
    expect(h.manager.readLaunchRecord(h.environmentId)?.state).not.toBe('stopped');
    const closed = await h.manager.close();
    expect(closed.ok).toBe(false);
  });

  it('treats a verified-empty scan as a legitimate successful stop', async () => {
    const h = await open();
    writeLaunchRecord(
      h.dataRoot,
      launchFixture(h.dataRoot, h.environmentId, {
        state: 'running',
        identity: null,
        commandFragment: join(h.dataRoot, 'no-such-entry.js'),
        generationDirectory: h.generationDirectory,
      }),
    );
    const stopped = await h.manager.stop(h.request());
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.value.wasRunning).toBe(false);
    }
  });
});

describe('injected boundary hardening (review P3)', () => {
  it('rejects a malformed credential result with a controlled error', async () => {
    for (const credentialRaw of [{ nonsense: true }, { ok: false }]) {
      const h = await open({ credentialRaw });
      const outcome = await h.manager.start(h.request());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('INTERNAL_ERROR');
        expect(outcome.message.length).toBeGreaterThan(0);
      }
      await h.manager.close();
    }
  });

  it('retries identity capture while the pid is alive but transiently unreadable', async () => {
    const real = createPosixProcessProbe();
    let calls = 0;
    const flaky: ProcessProbe = {
      inspect: (pid) => {
        calls += 1;
        return calls <= 3 ? undefined : real.inspect(pid);
      },
      scan: () => real.scan(),
      findIdsByCommandFragment: (fragment) => real.findIdsByCommandFragment(fragment),
      tryFindIdsByCommandFragment: (fragment) => real.findIdsByCommandFragment(fragment),
      listProcessGroup: (pgid) => real.listProcessGroup(pgid),
    };
    const h = await open({ probe: flaky });
    const outcome = await h.manager.start(h.request());
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    await h.manager.stop(h.request());
  });

  it('rejects a launch env that tries to override the managed HOME', async () => {
    const h = await open({ envOverrides: { HOME: '/tmp/hdsl-evil-home' } });
    const outcome = await h.manager.start(h.request());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain('HOME');
    }
  });

  it('keeps the managed PATH authoritative over the launch env', async () => {
    const h = await open({ envOverrides: { PATH: '/evil/bin' } });
    const outcome = await h.manager.start(h.request());
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const info = await h.waitForInfo();
    expect(String(info['path'])).not.toContain('/evil/bin');
    expect(String(info['path'])).toContain(join(process.execPath, '..'));
    await h.manager.stop(h.request());
  });
});
