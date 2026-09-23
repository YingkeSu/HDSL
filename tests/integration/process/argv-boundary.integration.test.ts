/**
 * T007 S4 — production managed-launch argument array and no-shell boundary.
 *
 * FR-003 (T007 FR mapping): the launcher MUST start the managed runtime through
 * the verified adapter with an explicit argument array, never by concatenating
 * a shell command line. The T005 lifecycle suite proves the real spawn,
 * readiness and ownership code runs, but it never asserted the *shape* of the
 * production argv, and `tests/process/support/fake-dsh.mjs` still documents the
 * older `web --no-open` form while the manager now passes `--profile web`.
 *
 * This test drives the real public `createProcessManager` from `@hdsl/runtime`
 * with the QA fixture as the managed entrypoint (synthetic process behavior,
 * real production spawn path) and reads the kernel's own view of the child
 * command line through the production POSIX probe. It is deterministic: no
 * network, no model call, no personal credential.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createPosixProcessProbe } from '@hdsl/runtime';

import {
  cleanupProcessRoots,
  createProcessHarness,
  FIXTURE_SCRIPT,
  type ProcessHarness,
} from './support/managed-process.js';

const harnesses: ProcessHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
  cleanupProcessRoots();
});

describe('production managed-launch argument boundary', () => {
  it('spawns the entrypoint with the exact argument array and no shell wrapper', async () => {
    const harness = createProcessHarness({
      env: { HDSL_QA_DSH_MODE: 'ready', HDSL_QA_NO_GRANDCHILD: '1' },
    });
    harnesses.push(harness);

    const started = await harness.manager.start(harness.request('argv-no-shell'));
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) {
      return;
    }

    const record = harness.readLaunch('argv-no-shell');
    const pid = record?.identity?.pid;
    expect(pid, 'a managed launch record with a kernel identity is required').toBeTypeOf('number');
    if (pid === undefined) {
      return;
    }

    const info = createPosixProcessProbe().inspect(pid);
    expect(info, 'the production probe must read the live child').toBeDefined();
    if (info === undefined) {
      return;
    }
    const command = info.command.trim();

    // The executable is node, invoked directly: the first token is not a shell.
    expect(command.startsWith(process.execPath), command).toBe(true);
    const argumentTokens = command.slice(process.execPath.length).trim().split(/\s+/);
    expect(argumentTokens).toEqual([
      FIXTURE_SCRIPT,
      '--profile',
      'web',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ]);

    // No shell concatenation: `spawn(exe, args)` must never be routed through
    // `sh -c` / `bash -c` (which would re-parse the arguments).
    expect(command).not.toMatch(/(^|\s)(?:sh|bash|zsh|dash)\s+-c(?:\s|$)/);
    expect(command.startsWith('/bin/sh')).toBe(false);

    // The ownership fragment recorded by production is the exact entrypoint,
    // not a shell command line.
    expect(record?.commandFragment).toBe(FIXTURE_SCRIPT);

    const stopped = await harness.manager.stop(harness.request('argv-no-shell'));
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
  }, 30_000);
});
