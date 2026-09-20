/**
 * T005 restart reconciliation: leftovers from a crashed instance are resolved
 * with the same kernel-identity proof used by the live lifecycle, and a process
 * whose ownership cannot be proven is never signalled.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessManager, isProcessAlive } from '@hdsl/runtime';
import type { LaunchCredentialPort } from '@hdsl/runtime';
import { portFail } from '@hdsl/contracts';
import {
  createHarness,
  launchFixture,
  spawnDetachedProcess,
  waitFor,
  writeLaunchRecord,
  type Harness,
} from './support/harness.js';

let harness: Harness | undefined;
const extraProcesses: Array<{ kill(): void }> = [];

afterEach(async () => {
  for (const process of extraProcesses.splice(0)) {
    process.kill();
  }
  await harness?.cleanup();
  harness = undefined;
});

const open = async (options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> => {
  harness = await createHarness(options);
  return harness;
};

const failingCredentials: LaunchCredentialPort = {
  resolveLaunchEnvironment: () => Promise.resolve(portFail('INTERNAL_ERROR', 'test stub')),
};

const freshManager = (dataRoot: string, permitted?: () => boolean) =>
  createProcessManager({
    dataRoot,
    credentials: failingCredentials,
    readinessTimeoutMs: 2_000,
    stopGraceMs: 300,
    confirmMs: 3_000,
    ...(permitted === undefined ? {} : { isRecoveryPermitted: permitted }),
  });

describe('restart reconciliation', () => {
  it('reports no-process for a recorded pid that is already gone', async () => {
    const h = await open();
    const sleeper = await spawnDetachedProcess();
    const identity = sleeper.identity;
    sleeper.kill();
    await waitFor(() => !sleeper.isAlive());
    writeLaunchRecord(h.dataRoot, launchFixture(h.dataRoot, h.environmentId, { identity }));

    const manager = freshManager(h.dataRoot);
    const report = await manager.recover();
    expect(report.entries).toEqual([
      { environmentId: h.environmentId, resolution: 'no-process' },
    ]);
    await manager.close();
  });

  it('adopts a still-owned, still-reachable process after a restart', async () => {
    const h = await open();
    const started = await h.manager.start(h.request());
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const manager = freshManager(h.dataRoot);
    const report = await manager.recover();
    expect(report.entries).toEqual([
      {
        environmentId: h.environmentId,
        resolution: 'adopted',
        loopbackOrigin: started.value.loopbackOrigin,
      },
    ]);

    // The adopted process is still reachable and still owned.
    const record = manager.readLaunchRecord(h.environmentId);
    expect(record?.state).toBe('running');
    const closed = await manager.close();
    expect(closed.ok).toBe(true);
    await waitFor(() => !isProcessAlive(started.value.pid));
  });

  it('stops an owned process that was recorded before it was ready', async () => {
    const h = await open();
    const sleeper = await spawnDetachedProcess();
    extraProcesses.push(sleeper);
    writeLaunchRecord(
      h.dataRoot,
      launchFixture(h.dataRoot, h.environmentId, {
        state: 'spawning',
        identity: sleeper.identity,
        endpoint: null,
      }),
    );

    const manager = freshManager(h.dataRoot);
    const report = await manager.recover();
    expect(report.entries[0]?.resolution).toBe('stopped');
    expect(report.entries[0]?.environmentId).toBe(h.environmentId);
    await waitFor(() => !sleeper.isAlive());
    await manager.close();
  });

  it('reports no-process when the recorded pid was reused by an unrelated process', async () => {
    const h = await open();
    const sleeper = await spawnDetachedProcess();
    extraProcesses.push(sleeper);
    writeLaunchRecord(
      h.dataRoot,
      launchFixture(h.dataRoot, h.environmentId, {
        state: 'running',
        identity: { ...sleeper.identity, startToken: 'Thu Jan  1 00:00:00 1970' },
      }),
    );

    const manager = freshManager(h.dataRoot);
    const report = await manager.recover();
    expect(report.entries).toEqual([
      { environmentId: h.environmentId, resolution: 'no-process' },
    ]);
    expect(sleeper.isAlive()).toBe(true);
    await manager.close();
  });

  it('never signals a live pid whose ownership cannot be read', async () => {
    const h = await open();
    const sleeper = await spawnDetachedProcess();
    extraProcesses.push(sleeper);
    writeLaunchRecord(
      h.dataRoot,
      launchFixture(h.dataRoot, h.environmentId, {
        state: 'running',
        identity: sleeper.identity,
      }),
    );

    const manager = createProcessManager({
      dataRoot: h.dataRoot,
      credentials: failingCredentials,
      probe: {
        inspect: () => undefined,
        scan: () => [],
        findIdsByCommandFragment: () => [],
      },
    });
    const report = await manager.recover();
    expect(report.entries).toEqual([
      {
        environmentId: h.environmentId,
        resolution: 'unverifiable',
        detail: 'the recorded process identity no longer matches; it was not signalled',
      },
    ]);
    expect(sleeper.isAlive()).toBe(true);
    await manager.close();
  });

  it('touches nothing when the data root is not ours', async () => {
    const h = await open();
    const sleeper = await spawnDetachedProcess();
    extraProcesses.push(sleeper);
    writeLaunchRecord(
      h.dataRoot,
      launchFixture(h.dataRoot, h.environmentId, { identity: sleeper.identity }),
    );

    const manager = freshManager(h.dataRoot, () => false);
    const report = await manager.recover();
    expect(report.entries).toEqual([]);
    expect(sleeper.isAlive()).toBe(true);
  });

  it('cleans up a journalled install child left by a crash', async () => {
    const h = await open();
    const sleeper = await spawnDetachedProcess();
    extraProcesses.push(sleeper);
    const journalDirectory = join(h.generationDirectory, '.hdsl-process-children');
    mkdirSync(journalDirectory, { recursive: true });
    writeFileSync(
      join(journalDirectory, 'install-child.json'),
      `${JSON.stringify(
        {
          schemaVersion: '1',
          token: 'install-child',
          pid: sleeper.identity.pid,
          pgid: sleeper.identity.pgid,
          startToken: sleeper.identity.startToken,
          commandFragment: process.execPath,
          createdAt: sleeper.identity.createdAt,
          updatedAt: sleeper.identity.createdAt,
        },
        null,
        2,
      )}\n`,
    );

    const manager = freshManager(h.dataRoot);
    await manager.recover();
    await waitFor(() => !sleeper.isAlive());
    await manager.close();
  });
});
