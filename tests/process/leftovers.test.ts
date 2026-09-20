/**
 * T005 review P2-B: descendant cleanup must prove each member of the recorded
 * process group before signalling anything, and never blind-kill a group.
 *
 * These are deterministic unit tests over a controlled probe; the real-process
 * behaviour is covered by `lifecycle.test.ts` and QA's fixtures.
 */
import { describe, expect, it } from 'vitest';
import { cleanupLostLeaderTree } from '@hdsl/runtime';
import type { ProcessInfo, ProcessProbe } from '@hdsl/runtime';

const PGID = 900_001;
const START = 'Sun Sep 20 19:00:00 2026';

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

describe('descendant cleanup ownership proof', () => {
  it('kills a member proven by the launch command fragment', async () => {
    const probe = probeSequenced([
      [member('node /gen/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web', START)],
      [],
    ]);
    const result = await cleanupLostLeaderTree({
      probe,
      pgid: PGID,
      leaderReason: 'dead',
      commandFragment: '/gen/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      generationDirectory: '/gen',
      exitedAt: null,
      confirmMs: 200,
    });
    expect(result).toEqual({ ok: true, killed: 1 });
  });

  it('kills a member that already existed at the recorded leader exit even without a command match', async () => {
    const exitedAt = new Date(Date.parse(START) + 5_000).toISOString();
    const probe = probeSequenced([[member('node -e setInterval(() => {}, 1 << 30)', START)], []]);
    const result = await cleanupLostLeaderTree({
      probe,
      pgid: PGID,
      leaderReason: 'dead',
      commandFragment: '/gen/dsh/lib/bin.js',
      generationDirectory: '/gen',
      exitedAt,
      confirmMs: 200,
    });
    expect(result).toEqual({ ok: true, killed: 1 });
  });

  it('never signals a member that started after the leader exit and has no command evidence', async () => {
    const exitedAt = new Date(Date.parse(START)).toISOString();
    const probe = probeSequenced([
      [member('node -e setInterval(() => {}, 1 << 30)', 'Sun Sep 20 19:10:00 2026')],
    ]);
    const result = await cleanupLostLeaderTree({
      probe,
      pgid: PGID,
      leaderReason: 'pid-reused',
      commandFragment: '/gen/dsh/lib/bin.js',
      generationDirectory: '/gen',
      exitedAt,
      confirmMs: 200,
    });
    expect(result).toEqual({ ok: false, reason: 'unverifiable-leftovers' });
  });

  it('reports a failed scan instead of an empty cleanup', async () => {
    const probe = probeSequenced([undefined]);
    const result = await cleanupLostLeaderTree({
      probe,
      pgid: PGID,
      leaderReason: 'dead',
      commandFragment: 'x',
      generationDirectory: 'y',
      exitedAt: null,
      confirmMs: 200,
    });
    expect(result).toEqual({ ok: false, reason: 'scan-failed' });
  });

  it('treats a verified empty group as nothing to resolve', async () => {
    const probe = probeSequenced([[]]);
    const result = await cleanupLostLeaderTree({
      probe,
      pgid: PGID,
      leaderReason: 'dead',
      commandFragment: 'x',
      generationDirectory: 'y',
      exitedAt: null,
      confirmMs: 200,
    });
    expect(result).toEqual({ ok: true, killed: 0 });
  });
});
