import { describe, expect, it } from 'vitest';
import { createPosixProcessProbe, verifyIdentity } from '@hdsl/runtime';
import type { ProcessIdentity, ProcessProbe } from '@hdsl/runtime';

const identityFor = (overrides: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
  pid: process.pid,
  pgid: process.pid,
  startToken: 'Sun Sep 20 19:00:00 2026',
  commandFragment: '/managed/generation/node/bin/node',
  createdAt: new Date().toISOString(),
  ...overrides,
});

const probeReturning = (value: {
  readonly pid: number;
  readonly pgid: number;
  readonly startToken: string;
  readonly command: string;
}): ProcessProbe => ({
  inspect: (pid) => (pid === value.pid ? value : undefined),
  scan: () => [],
  findIdsByCommandFragment: () => [],
});

describe('process ownership verification', () => {
  it('reports owned only when pid, start token and command fragment all match', () => {
    const identity = identityFor();
    const probe = probeReturning({
      pid: process.pid,
      pgid: process.pid,
      startToken: identity.startToken,
      command: `node ${identity.commandFragment} web`,
    });
    expect(verifyIdentity(probe, identity)).toEqual({
      owned: true,
      alive: true,
      reason: 'live-owned',
      pgidMatches: true,
    });
  });

  it('refuses a reused pid whose kernel start token differs', () => {
    const identity = identityFor();
    const probe = probeReturning({
      pid: process.pid,
      pgid: process.pid,
      startToken: 'Mon Sep 21 09:00:00 2026',
      command: `node ${identity.commandFragment} web`,
    });
    const verdict = verifyIdentity(probe, identity);
    expect(verdict.owned).toBe(false);
    expect(verdict.alive).toBe(true);
    expect(verdict.reason).toBe('pid-reused');
  });

  it('refuses a process whose command no longer matches', () => {
    const identity = identityFor();
    const probe = probeReturning({
      pid: process.pid,
      pgid: process.pid,
      startToken: identity.startToken,
      command: 'node /somewhere/else.js',
    });
    expect(verifyIdentity(probe, identity).reason).toBe('command-mismatch');
    expect(verifyIdentity(probe, identity).owned).toBe(false);
  });

  it('reports dead when the pid no longer exists', () => {
    const identity = identityFor({ pid: 2_147_483_646 });
    const probe = probeReturning({
      pid: 2_147_483_646,
      pgid: 2_147_483_646,
      startToken: identity.startToken,
      command: 'node x',
    });
    const verdict = verifyIdentity(probe, identity);
    expect(verdict.alive).toBe(false);
    expect(verdict.reason).toBe('dead');
  });

  it('reports unverifiable (and never owned) when the probe cannot read a live pid', () => {
    const identity = identityFor();
    const probe: ProcessProbe = {
      inspect: () => undefined,
      scan: () => [],
      findIdsByCommandFragment: () => [],
    };
    const verdict = verifyIdentity(probe, identity);
    expect(verdict.alive).toBe(true);
    expect(verdict.owned).toBe(false);
    expect(verdict.reason).toBe('unverifiable');
  });
});

describe('posix probe', () => {
  it('reads a real kernel start token and command for this process', () => {
    const probe = createPosixProcessProbe();
    const info = probe.inspect(process.pid);
    expect(info).toBeDefined();
    expect(info?.startToken.length).toBeGreaterThan(0);
    expect(info?.command).toContain('node');
    expect(info?.pgid).toBeGreaterThan(0);
  });

  it('returns undefined for an impossible pid', () => {
    const probe = createPosixProcessProbe();
    expect(probe.inspect(2_147_483_646)).toBeUndefined();
  });
});
