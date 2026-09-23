/**
 * Managed-process exit projection (issue #108 / FR-005).
 *
 * Unit tests for the main-side seam that turns a real `handleProcessExit` into a
 * renderer-visible environment summary. This is the source half of the fix: core
 * already converges the persisted state to `stopped`, and the renderer is only
 * notified when the state actually changed, so a duplicate exit cannot spam the
 * bridge and a renderer-issued stop stays authoritative.
 */
import { portFail, portOk, type EnvironmentSummary } from '@hdsl/contracts';
import type { ManagedProcessExit } from '@hdsl/core';
import { describe, expect, it, vi } from 'vitest';
import { projectProcessExit } from '../../apps/desktop/src/main/composition.js';

const summary = (overrides: Partial<EnvironmentSummary> = {}): EnvironmentSummary => ({
  id: 'env-1',
  name: 'Env 1',
  revision: 1,
  stateVersion: 1,
  state: 'stopped',
  activeGenerationId: 'gen-1',
  compositionDigest: 'a'.repeat(64),
  ...overrides,
});

const exit = (): ManagedProcessExit => ({ environmentId: 'env-1', pid: 4242, exitCode: null, signal: 'SIGKILL' });

describe('projectProcessExit', () => {
  it('runs the core transition and projects the changed summary', () => {
    const before = summary({ state: 'running', stateVersion: 3 });
    const after = summary({ state: 'stopped', stateVersion: 4 });
    const findEnvironment = vi
      .fn()
      .mockReturnValueOnce(portOk(before))
      .mockReturnValueOnce(portOk(after));
    const handleProcessExit = vi.fn();
    const changed: EnvironmentSummary[] = [];

    projectProcessExit({ findEnvironment, handleProcessExit }, (environment) => {
      changed.push(environment);
    })(exit());

    // The core transition must run before the summary is read.
    expect(handleProcessExit).toHaveBeenCalledWith(exit());
    expect(findEnvironment).toHaveBeenCalledTimes(2);
    expect(changed).toEqual([after]);
  });

  it('does not project when the exit did not change the environment state', () => {
    const unchanged = summary({ state: 'stopped', stateVersion: 5 });
    const findEnvironment = vi.fn(() => portOk(unchanged));
    const handleProcessExit = vi.fn();
    const changed: EnvironmentSummary[] = [];

    projectProcessExit({ findEnvironment, handleProcessExit }, (environment) => {
      changed.push(environment);
    })(exit());

    expect(handleProcessExit).toHaveBeenCalledTimes(1);
    expect(changed).toEqual([]);
  });

  it('does not project for an environment that no longer exists', () => {
    const findEnvironment = vi.fn(() => portFail('NOT_FOUND', 'environment was not found'));
    const handleProcessExit = vi.fn();
    const changed: EnvironmentSummary[] = [];

    projectProcessExit({ findEnvironment, handleProcessExit }, (environment) => {
      changed.push(environment);
    })(exit());

    expect(handleProcessExit).toHaveBeenCalledTimes(1);
    expect(changed).toEqual([]);
  });

  it('still runs the core transition when no projection listener is registered', () => {
    const findEnvironment = vi.fn(() => portOk(summary()));
    const handleProcessExit = vi.fn();
    projectProcessExit({ findEnvironment, handleProcessExit })(exit());
    expect(handleProcessExit).toHaveBeenCalledTimes(1);
  });
});
