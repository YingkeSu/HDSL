/**
 * Adversarial `dataRoot` lock fixtures for T005a/T007b QA.
 *
 * The core lock lifecycle (observable interface to be frozen with the T005a /
 * core-lock authors) must not treat a lock file as authoritative without
 * checking owner identity. These helpers manufacture the *inputs* a hostile or
 * crashed world produces — stale heartbeats, a foreign host, a PID that is
 * alive but has been reused, and outright corrupt bytes — so a scenario can
 * assert the candidate conservatively refuses instead of archiving a live
 * owner's lock or killing an unrelated process.
 *
 * The exact lock root path, file name and record schema are **not** assumed
 * here: every record is a plain value plus a helper that writes it under a
 * caller-supplied directory. Wiring it to the real lock root waits for the
 * T005a/#20/#21 observable interface (see `docs/development/process-validation.md`).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFileGate, type FileGate } from './data-root.js';

export interface LockOwnerRecord {
  readonly ownerId: string;
  readonly host: string;
  readonly pid: number;
  /** `ps lstart` of the owning process; a reused PID will not match. */
  readonly startTime: string;
  /** ISO timestamp of the most recent heartbeat. */
  readonly heartbeatAt: string;
  /** Monotonic ownership epoch; a takeover must not reuse a lower epoch. */
  readonly epoch: number;
}

export interface LiveProcessRef {
  readonly pid: number;
  readonly startTime: string;
  readonly token: string;
}

export interface LockFixtureOptions {
  readonly directory: string;
  readonly host?: string;
  readonly now?: () => number;
  /** A heartbeat older than this is "stale" to the fixture (candidate policy may differ). */
  readonly staleAfterMs?: number;
}

export class LockFixture {
  public readonly directory: string;
  private readonly host: string;
  private readonly now: () => number;
  private readonly staleAfterMs: number;

  public constructor(options: LockFixtureOptions) {
    this.directory = options.directory;
    this.host = options.host ?? 'qa-host';
    this.now = options.now ?? (() => Date.now());
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    mkdirSync(this.directory, { recursive: true });
  }

  public ownerRecord(overrides: Partial<LockOwnerRecord> = {}): LockOwnerRecord {
    return {
      ownerId: `owner-${randomUUID()}`,
      host: this.host,
      pid: process.pid,
      startTime: 'unknown',
      heartbeatAt: new Date(this.now()).toISOString(),
      epoch: 1,
      ...overrides,
    };
  }

  /** Owner whose heartbeat is older than the fixture's staleness threshold. */
  public staleOwner(overrides: Partial<LockOwnerRecord> = {}): LockOwnerRecord {
    return this.ownerRecord({
      heartbeatAt: new Date(this.now() - this.staleAfterMs - 1_000).toISOString(),
      ...overrides,
    });
  }

  public freshOwner(overrides: Partial<LockOwnerRecord> = {}): LockOwnerRecord {
    return this.ownerRecord(overrides);
  }

  /** Owner recorded on a different host; takeover must not be automatic. */
  public foreignHostOwner(overrides: Partial<LockOwnerRecord> = {}): LockOwnerRecord {
    return this.ownerRecord({ host: `other-host-${randomUUID()}`, ...overrides });
  }

  /**
   * Owner record that names a *live* PID but claims a different start time:
   * the shape the OS produces when it reused a PID. A correct candidate must
   * refuse to trust it and must never signal that PID.
   */
  public pidReuseRecord(live: LiveProcessRef, overrides: Partial<LockOwnerRecord> = {}): LockOwnerRecord {
    return this.ownerRecord({
      pid: live.pid,
      startTime: 'Thu Jan  1 00:00:00 1970',
      ...overrides,
    });
  }

  /** Writes an owner record as JSON under `name` (caller picks the file name). */
  public writeOwner(name: string, record: LockOwnerRecord): string {
    const path = join(this.directory, name);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
  }

  /** Writes arbitrary bytes (for corrupt/truncated lock files). */
  public writeRaw(name: string, contents: string | Buffer): string {
    const path = join(this.directory, name);
    writeFileSync(path, contents);
    return path;
  }

  /** Deterministic one-shot gate so two real processes can order contention. */
  public contentionGate(id: string): FileGate {
    return createFileGate(join(this.directory, `gate-${id}.open`));
  }
}

export const CORRUPT_LOCK_BYTES = '{ not: json';

/** Shape assertions used by the harness self-check; no production semantics. */
export const isStale = (record: LockOwnerRecord, now = Date.now()): boolean =>
  now - Date.parse(record.heartbeatAt) > 30_000;

export const hasForeignHost = (record: LockOwnerRecord, localHost: string): boolean =>
  record.host !== localHost;
