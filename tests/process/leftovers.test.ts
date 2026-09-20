/**
 * T005 review P2-B: descendant cleanup must prove each member of the recorded
 * process group before signalling anything, and a member's start time is never
 * sufficient evidence on its own.
 *
 * Deterministic unit tests over a controlled probe; the real-process behaviour
 * is covered by `lifecycle.test.ts` and QA's fixtures.
 */
import { describe, expect, it } from 'vitest';
import { cleanupLostLeaderTree } from '@hdsl/runtime';
import type { ProcessIdentity, ProcessInfo, ProcessProbe } from '@hdsl/runtime';

const PGID = 900_001;
const LEADER_START = 'Sun Sep 20 19:00:00 2026';

const leaderIdentity = (overrides: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
  pid: PGID,
  pgid: PGID,
  startToken: LEADER_START,
  commandFragment: '/gen/dsh/lib/bin.js',
  createdAt: '2026-09-20T11:00:00.000Z',
  ...overrides,
});

const member = (command: string, startToken: string, pid = 900_100): ProcessInfo => ({
  pid,
  pgid: PGID,
  startToken,
  command,
});

const probeSequenced = (
  responses: ReadonlyArray<readonly ProcessInfo[] | undefined>,
): ProcessProbe => {
  let index = 0;
  return {
    inspect: () => undefined,
    scan: () => [],
    findIdsByCommandFragment: () => [],
    tryFindIdsByCommandFragment: () => [],
    listProcessGroup: () => {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
  };
};

const cleanup = (
  probe: ProcessProbe,
  overrides: Partial<Parameters<typeof cleanupLostLeaderTree>[0]> = {},
) =>
  cleanupLostLeaderTree({
    probe,
    pgid: PGID,
    leaderReason: 'dead',
    leaderIdentity: leaderIdentity(),
    commandFragment: '/gen/dsh/lib/bin.js',
    generationDirectory: '/gen',
    capturedSurvivors: null,
    confirmMs: 200,
    ...overrides,
  });

describe('descendant cleanup ownership proof', () => {
  it('kills a member captured at the recorded leader exit', async () => {
    const survivor = member('node -e setInterval(() => {}, 1 << 30)', LEADER_START);
    const probe = probeSequenced([[survivor], []]);
    const result = await cleanup(probe, {
      capturedSurvivors: [
        {
          pid: survivor.pid,
          pgid: survivor.pgid,
          startToken: survivor.startToken,
          commandFragment: 'x',
          createdAt: '2026-09-20T11:00:05.000Z',
        },
      ],
    });
    expect(result).toEqual({ ok: true, killed: 1 });
  });

  it('kills a member proven by the launch command fragment', async () => {
    const probe = probeSequenced([
      [member('node /gen/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web', LEADER_START)],
      [],
    ]);
    const result = await cleanup(probe);
    expect(result).toEqual({ ok: true, killed: 1 });
  });

  it('never treats an old start token as sufficient evidence on its own', async () => {
    const probe = probeSequenced([
      [member('node -e daemon-from-2001', 'Thu Jan  1 00:00:00 1970')],
    ]);
    const result = await cleanup(probe);
    expect(result).toEqual({ ok: false, reason: 'unverifiable-leftovers' });
  });

  it('never treats a member in the same second as the leader exit as sufficient', async () => {
    const probe = probeSequenced([[member('node -e unrelated', LEADER_START)]]);
    const result = await cleanup(probe);
    expect(result).toEqual({ ok: false, reason: 'unverifiable-leftovers' });
  });

  it('never signals an unrelated decoy in the group without captured or command evidence', async () => {
    const probe = probeSequenced([[member('node -e decoy', 'Sun Sep 20 19:05:00 2026')]]);
    const result = await cleanup(probe);
    expect(result).toEqual({ ok: false, reason: 'unverifiable-leftovers' });
  });

  it('fails closed when the leader identity is not a detached group leader', async () => {
    const probe = probeSequenced([
      [member('node /gen/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web', LEADER_START)],
    ]);
    const result = await cleanup(probe, {
      leaderIdentity: leaderIdentity({ pgid: PGID + 1 }),
    });
    expect(result).toEqual({ ok: false, reason: 'unverifiable-leftovers' });
  });

  it('reports a failed scan instead of an empty cleanup', async () => {
    const probe = probeSequenced([undefined]);
    const result = await cleanup(probe);
    expect(result).toEqual({ ok: false, reason: 'scan-failed' });
  });

  it('treats a verified empty group as nothing to resolve', async () => {
    const probe = probeSequenced([[]]);
    const result = await cleanup(probe);
    expect(result).toEqual({ ok: true, killed: 0 });
  });
});
