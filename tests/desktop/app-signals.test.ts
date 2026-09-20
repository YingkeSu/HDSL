/**
 * Data-root-unavailable attribution signal tests (T006 / issue #6, F1).
 *
 * The signal is production behavior: a single fixed stderr line with an
 * enumerated reason, written before the native error box. These tests prove the
 * line is stable and cannot leak a path, owner, PID, hostname or secret.
 */
import { describe, expect, it } from 'vitest';
import type { DataRootLockSnapshot } from '@hdsl/core';
import {
  DATA_ROOT_UNAVAILABLE_SIGNAL,
  dataRootUnavailableReason,
  formatDataRootUnavailableSignal,
} from '../../apps/desktop/src/main/app-signals.js';

const snapshot = (overrides: Partial<DataRootLockSnapshot> = {}): DataRootLockSnapshot => ({
  dataRoot: '/Users/secret-owner/private/hdsl-data',
  state: 'unknown',
  heldByThisInstance: false,
  publishedBy: 'none',
  platform: 'darwin',
  platformVerified: true,
  evidence: [],
  ...overrides,
});

describe('dataRootUnavailableReason', () => {
  it('maps a busy/another-instance lease to busy and everything else to unknown', () => {
    expect(dataRootUnavailableReason(snapshot({ state: 'busy' }))).toBe('busy');
    expect(dataRootUnavailableReason(snapshot({ publishedBy: 'another-instance' }))).toBe('busy');
    expect(dataRootUnavailableReason(snapshot({ state: 'unknown' }))).toBe('unknown');
    expect(dataRootUnavailableReason(snapshot({ state: 'free', publishedBy: 'none' }))).toBe(
      'unknown',
    );
    expect(dataRootUnavailableReason(snapshot({ state: 'free', publishedBy: 'unreadable' }))).toBe(
      'unknown',
    );
  });
});

describe('formatDataRootUnavailableSignal', () => {
  it('emits exactly the fixed prefix and enumerated reason', () => {
    expect(formatDataRootUnavailableSignal('busy')).toBe(
      '[hdsl] data-root unavailable reason=busy\n',
    );
    expect(formatDataRootUnavailableSignal('unknown')).toBe(
      '[hdsl] data-root unavailable reason=unknown\n',
    );
    expect(DATA_ROOT_UNAVAILABLE_SIGNAL).toBe('[hdsl] data-root unavailable');
  });

  it('cannot leak snapshot content because it depends only on the reason', () => {
    const adversarial = snapshot({
      state: 'busy',
      publishedBy: 'another-instance',
      publishedLease: {
        schemaVersion: '1',
        lockId: 'lock-secret-abc',
        instanceId: 'instance-secret',
        pid: 4242,
        hostname: 'owner-macbook.local',
        acquiredAt: '2026-09-20T00:00:00.000Z',
        heartbeatAt: '2026-09-20T00:00:00.000Z',
      },
      lastAttempt: {
        at: '2026-09-20T00:00:00.000Z',
        outcome: 'busy',
        reason: 'token=canary-secret /Users/secret-owner/private/hdsl-data',
        waitedMs: 1500,
        takeover: false,
      },
    });
    const line = formatDataRootUnavailableSignal(dataRootUnavailableReason(adversarial));
    expect(line).toBe('[hdsl] data-root unavailable reason=busy\n');
    for (const forbidden of [
      '/Users/secret-owner',
      'canary-secret',
      'owner-macbook.local',
      '4242',
      'instance-secret',
      'lock-secret-abc',
      'hdsl-data',
    ]) {
      expect(line).not.toContain(forbidden);
    }
  });
});
