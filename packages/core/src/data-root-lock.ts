/**
 * Cross-instance / cross-process exclusive lock for one `dataRoot` (issue #43).
 *
 * ## Linearity
 *
 * The lock is a *directory* `<locks>/data-root.lock/` that always contains a
 * complete `lease.json` for a live holder. Acquisition is one atomic directory
 * publish:
 *
 * 1. write the full lease into a private `<locks>/tmp-<uuid>/lease.json` and
 *    fsync both the file and the directory;
 * 2. `rename(tmpDir, lockDir)` — POSIX renames a directory only when the target
 *    is absent (or an empty directory), so exactly one contender wins.
 *
 * The canonical directory therefore never has a half-written lease, and
 * "mkdir the canonical path, then write the lease" is explicitly *not* used.
 *
 * ## Stale takeover and release
 *
 * Only the *removal* of a stale/released lock and the following publish happen
 * inside an OS-atomic **recovery guard**: a loopback TCP listener
 * (`node:net`). A bound port cannot be shared and the OS frees it when the
 * holder dies, so there is no guard file to repair. A contender that found a
 * stale lease outside the guard must re-read and re-decide *inside* the guard;
 * a live holder is never taken over (stale requires an old heartbeat **and** a
 * provably dead pid), so the canonical lease is never replaced while its owner
 * lives.
 *
 * ## Known boundaries (documented, not claimed as solved)
 *
 * - `assertHeld()` and the following write are not one atomic operation; safety
 *   rests on the takeover rule "a live owner is never taken over", and
 *   `assertHeld` is defence in depth.
 * - Single host only: a different hostname is always `unknown`/busy. Shared
 *   volumes, containers and cross-host data roots are unsupported.
 * - `win32` is unverified (T008): only the guarded stale *takeover* is
 *   explicitly refused there. The normal acquire (atomic publish), release and
 *   heartbeat paths are implemented and reachable but unverified, so no
 *   Windows cross-process exclusivity is claimed. This is neither "all Windows
 *   lock operations fail closed" nor a Windows support claim;
 *   {@link DataRootLockSnapshot.platformVerified} exposes the scope.
 * - A guard port held by a non-HDSL process fails closed; ports are never
 *   silently changed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { ensureDirectory, pathExists, readTextFile, tryReadJsonFile } from './fsx.js';

export interface DataRootLease {
  readonly schemaVersion: '1';
  readonly lockId: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

export type ProcessLiveness = 'alive' | 'dead' | 'unknown';
export type ProcessLivenessProbe = (pid: number) => ProcessLiveness;

export interface DataRootLockOptions {
  readonly dataRoot: string;
  readonly clock?: () => Date;
  readonly hostname?: string;
  readonly pid?: number;
  readonly instanceId?: string;
  /** How often the holder refreshes `heartbeatAt`. Default 500 ms. */
  readonly heartbeatIntervalMs?: number;
  /** A lease without a fresh heartbeat and a live pid can be taken over. Default 2 000 ms. */
  readonly staleAfterMs?: number;
  /** Test seam for liveness; defaults to `process.kill(pid, 0)`. */
  readonly probeProcess?: ProcessLivenessProbe;
  /** Bounded wait to obtain the recovery guard. Default 2 000 ms. */
  readonly guardWaitMs?: number;
  /** Bounded wait for the guard listener to actually close. Default 1 000 ms. */
  readonly guardCloseTimeoutMs?: number;
  /** Test seam: force a fixed guard port (all contenders must agree). */
  readonly guardPort?: number;
  /** Test seam: force platform semantics. */
  readonly platform?: NodeJS.Platform;
}

export interface DataRootLockAcquireOptions {
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface DataRootLockEvidence {
  readonly schemaVersion: '1';
  readonly kind: 'takeover' | 'lost' | 'restored';
  readonly at: string;
  readonly lockId: string;
  readonly instanceId: string;
  readonly detail: string;
  readonly quarantinePath?: string;
  readonly staleLease?: DataRootLease;
}

/**
 * Queryable lock observation for integration QA (issue #43). Core internal,
 * deliberately not part of the frozen `@hdsl/contracts` DTOs. `lockId` is a
 * fresh ABA credential per acquisition.
 */
export interface DataRootLockAttempt {
  readonly at: string;
  readonly outcome: 'held' | 'busy' | 'unknown';
  readonly reason: string;
  readonly waitedMs: number;
  readonly takeover: boolean;
  readonly observedLockId?: string;
}

export interface DataRootLockReleaseResult {
  readonly at: string;
  readonly released: boolean;
  readonly reason: string;
  readonly removedLockId?: string;
}

export type DataRootLockPublishedBy =
  | 'this-instance'
  | 'another-instance'
  | 'none'
  | 'unreadable';

export interface DataRootLockSnapshot {
  readonly dataRoot: string;
  readonly state: 'held' | 'free' | 'busy' | 'unknown';
  readonly heldByThisInstance: boolean;
  readonly publishedBy: DataRootLockPublishedBy;
  readonly platform: NodeJS.Platform;
  /** False on an unverified platform: no cross-process exclusivity is claimed. */
  readonly platformVerified: boolean;
  readonly publishedLease?: DataRootLease;
  readonly lastAttempt?: DataRootLockAttempt;
  readonly lastRelease?: DataRootLockReleaseResult;
  readonly evidence: readonly DataRootLockEvidence[];
}

const LEASE_SCHEMA_VERSION = '1' as const;
const LEASE_FILE = 'lease.json';

export const isDataRootLease = (value: unknown): value is DataRootLease => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record['schemaVersion'] === LEASE_SCHEMA_VERSION &&
    typeof record['lockId'] === 'string' &&
    record['lockId'].length > 0 &&
    typeof record['instanceId'] === 'string' &&
    record['instanceId'].length > 0 &&
    typeof record['pid'] === 'number' &&
    Number.isInteger(record['pid']) &&
    record['pid'] > 0 &&
    typeof record['hostname'] === 'string' &&
    record['hostname'].length > 0 &&
    typeof record['acquiredAt'] === 'string' &&
    Number.isFinite(Date.parse(record['acquiredAt'])) &&
    typeof record['heartbeatAt'] === 'string' &&
    Number.isFinite(Date.parse(record['heartbeatAt']))
  );
};

const defaultProbeProcess: ProcessLivenessProbe = (pid) => {
  if (pid === process.pid) {
    return 'alive';
  }
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((settle) => {
    setTimeout(settle, milliseconds);
  });

/**
 * Platforms where cross-process exclusivity has actually been verified. Other
 * platforms keep the same implementation but make no exclusivity claim; only
 * the guarded stale-takeover is explicitly refused there, so the normal
 * acquire/release/heartbeat paths are not silently disabled.
 */
export const VERIFIED_LOCK_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux'];

export const isLockPlatformVerified = (platform: NodeJS.Platform): boolean =>
  VERIFIED_LOCK_PLATFORMS.includes(platform);

/** Raised when the data root cannot be canonicalized; the lock fails closed. */
export class DataRootLockCanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataRootLockCanonicalizationError';
  }
}

/**
 * Canonical filesystem identity of a data root. `realpathSync.native` resolves
 * symlinks (`/tmp` -> `/private/tmp`) and returns the on-disk casing, so two
 * spellings of the same directory derive the same lock and guard port. A
 * failure to canonicalize is fatal for the lock (fail closed) instead of
 * falling back to a path that could derive a different guard port.
 */
export const canonicalizeDataRoot = (dataRoot: string): string => {
  const resolved = resolve(dataRoot);
  mkdirSync(resolved, { recursive: true });
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    throw new DataRootLockCanonicalizationError(
      `the data root could not be canonicalized: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
};

/** Deterministic loopback guard port for a canonical data root. */
export const guardPortFor = (canonicalDataRoot: string): number => {
  const digest = createHash('sha256').update(canonicalDataRoot, 'utf8').digest();
  return 20_000 + (digest.readUInt16BE(0) % 25_000);
};

const GUARD_GREETING = 'HDSL-LOCK-GUARD';

type LeaseRead =
  | { readonly kind: 'valid'; readonly lease: DataRootLease }
  | { readonly kind: 'missing' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'corrupt' };

/** Raised when a critical section starts without owning the current lease. */
export class DataRootLockLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataRootLockLostError';
  }
}

/** Raised when the recovery guard cannot be obtained safely. */
export class DataRootGuardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataRootGuardUnavailableError';
  }
}

type AcquireAttempt = 'held' | 'busy' | 'unknown';
type SyncAttempt = 'held' | 'busy' | 'stale' | 'unknown';
type LeaseDecision = 'live' | 'stale' | 'unknown';

export class DataRootLock {
  readonly #dataRoot: string;
  readonly #locksDirectory: string;
  readonly #lockDirectory: string;
  readonly #leasePath: string;
  readonly #quarantineDirectory: string;
  readonly #evidenceDirectory: string;
  readonly #clock: () => Date;
  readonly #hostname: string;
  readonly #pid: number;
  readonly #instanceId: string;
  readonly #heartbeatIntervalMs: number;
  readonly #staleAfterMs: number;
  readonly #probeProcess: ProcessLivenessProbe;
  readonly #guardPort: number;
  readonly #guardWaitMs: number;
  readonly #guardCloseTimeoutMs: number;
  readonly #platform: NodeJS.Platform;
  readonly #platformVerified: boolean;

  #lease: DataRootLease | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #lostReason: string | undefined;
  #lastAttempt: DataRootLockAttempt | undefined;
  #lastRelease: DataRootLockReleaseResult | undefined;
  readonly #evidence: DataRootLockEvidence[] = [];
  #attemptTakeover = false;
  #attemptReason = 'not attempted';
  #attemptObservedLockId: string | undefined;

  constructor(options: DataRootLockOptions) {
    this.#dataRoot = canonicalizeDataRoot(options.dataRoot);
    this.#locksDirectory = join(this.#dataRoot, 'locks');
    this.#lockDirectory = join(this.#locksDirectory, 'data-root.lock');
    this.#leasePath = join(this.#lockDirectory, LEASE_FILE);
    this.#quarantineDirectory = join(this.#locksDirectory, 'quarantine');
    this.#evidenceDirectory = join(this.#locksDirectory, 'evidence');
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#hostname = options.hostname ?? osHostname();
    this.#pid = options.pid ?? process.pid;
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 500;
    this.#staleAfterMs = options.staleAfterMs ?? 2_000;
    this.#probeProcess = options.probeProcess ?? defaultProbeProcess;
    this.#guardPort = options.guardPort ?? guardPortFor(this.#dataRoot);
    this.#guardWaitMs = options.guardWaitMs ?? 2_000;
    this.#guardCloseTimeoutMs = options.guardCloseTimeoutMs ?? 1_000;
    this.#platform = options.platform ?? process.platform;
    this.#platformVerified = isLockPlatformVerified(this.#platform);
  }

  get dataRoot(): string {
    return this.#dataRoot;
  }

  get held(): boolean {
    return this.#lease !== undefined;
  }

  get lease(): DataRootLease | undefined {
    return this.#lease;
  }

  /** ABA credential for the lease this instance currently owns, if any. */
  get lockId(): string | undefined {
    return this.#lease?.lockId;
  }

  get instanceId(): string {
    return this.#instanceId;
  }

  get guardPort(): number {
    return this.#guardPort;
  }

  get lastAttempt(): DataRootLockAttempt | undefined {
    return this.#lastAttempt;
  }

  get lastRelease(): DataRootLockReleaseResult | undefined {
    return this.#lastRelease;
  }

  /**
   * Non-blocking fast path. A stale lock is never taken over here (takeover
   * needs the recovery guard); `open()`/`acquire()` perform that asynchronously.
   */
  tryAcquire(): boolean {
    if (this.held) {
      this.#recordAttempt('held', 0);
      return true;
    }
    let attempt: SyncAttempt = 'unknown';
    try {
      attempt = this.#attemptAcquireSync();
    } catch {
      attempt = 'unknown';
    }
    if (attempt === 'held') {
      this.#recordAttempt('held', 0);
      return true;
    }
    this.#recordAttempt(attempt === 'stale' ? 'busy' : attempt, 0);
    return false;
  }

  /** Bounded acquisition: resolves `true` when held, `false` after the wait. */
  async acquire(options: DataRootLockAcquireOptions = {}): Promise<boolean> {
    if (this.held) {
      this.#recordAttempt('held', 0);
      return true;
    }
    const waitTimeoutMs = options.waitTimeoutMs ?? 0;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const startedAt = Date.now();
    const deadline = startedAt + waitTimeoutMs;
    for (;;) {
      let attempt: AcquireAttempt;
      try {
        const sync = this.#attemptAcquireSync();
        attempt = sync === 'stale' ? await this.#takeoverGuarded() : sync;
      } catch {
        attempt = 'unknown';
      }
      if (attempt === 'held') {
        this.#recordAttempt('held', Date.now() - startedAt);
        return true;
      }
      if (Date.now() >= deadline) {
        this.#recordAttempt(attempt, Date.now() - startedAt);
        return false;
      }
      await delay(Math.max(1, Math.min(pollIntervalMs, deadline - Date.now())));
      if (this.held) {
        this.#recordAttempt('held', Date.now() - startedAt);
        return true;
      }
    }
  }

  /**
   * Re-verifies that the lease at the canonical path is still ours. Every
   * mutating critical section calls this before writing. It is defence in
   * depth, not a compare-and-swap: safety rests on a live owner never being
   * taken over.
   */
  assertHeld(): void {
    const lease = this.#lease;
    if (lease === undefined) {
      throw new DataRootLockLostError(this.#lostReason ?? 'the data root lock is not held');
    }
    const current = this.#readLease();
    if (current.kind !== 'valid' || current.lease.lockId !== lease.lockId) {
      this.#markLost('the data root lease is no longer owned by this instance', lease);
      throw new DataRootLockLostError('the data root lease is no longer owned by this instance');
    }
  }

  /** Releases the lock under the recovery guard; only a lease this instance still owns is removed. */
  async release(): Promise<DataRootLockReleaseResult> {
    this.#stopHeartbeat();
    const lease = this.#lease;
    this.#lease = undefined;
    if (lease === undefined) {
      this.#lastRelease = { at: this.#now(), released: true, reason: 'no lease was held' };
      return this.#lastRelease;
    }
    let result: DataRootLockReleaseResult;
    try {
      result = await this.#withGuard(() => this.#releaseUnderGuard(lease));
    } catch (error) {
      result = {
        at: this.#now(),
        released: false,
        reason:
          error instanceof DataRootGuardUnavailableError
            ? `the recovery guard is unavailable: ${error.message}`
            : 'the recovery guard failed while releasing',
      };
    }
    this.#lastRelease = result;
    return result;
  }

  /** The lease currently published at the canonical path, if readable. */
  readPublishedLease(): DataRootLease | undefined {
    const current = this.#readLease();
    return current.kind === 'valid' ? current.lease : undefined;
  }

  /**
   * True when a *different* instance currently owns this data root. An empty or
   * corrupted canonical directory is conservatively reported as owned.
   */
  isDataRootOwnedByAnother(): boolean {
    const current = this.#readLease();
    if (current.kind === 'missing') {
      return false;
    }
    if (current.kind !== 'valid') {
      return true;
    }
    if (this.#lease !== undefined && current.lease.lockId === this.#lease.lockId) {
      return false;
    }
    return this.#evaluate(current.lease) !== 'stale';
  }

  /** Full, queryable lock state for integration QA and diagnostics. */
  snapshot(): DataRootLockSnapshot {
    const current = this.#readLease();
    const published = current.kind === 'valid' ? current.lease : undefined;
    const publishedBy: DataRootLockPublishedBy =
      current.kind === 'missing'
        ? 'none'
        : current.kind === 'valid'
          ? this.#lease !== undefined && published?.lockId === this.#lease.lockId
            ? 'this-instance'
            : 'another-instance'
          : 'unreadable';
    const state: DataRootLockSnapshot['state'] =
      publishedBy === 'this-instance'
        ? 'held'
        : publishedBy === 'none'
          ? 'free'
          : publishedBy === 'another-instance'
            ? 'busy'
            : 'unknown';
    return {
      dataRoot: this.#dataRoot,
      state,
      heldByThisInstance: this.#lease !== undefined,
      publishedBy,
      platform: this.#platform,
      platformVerified: this.#platformVerified,
      ...(published === undefined ? {} : { publishedLease: published }),
      ...(this.#lastAttempt === undefined ? {} : { lastAttempt: this.#lastAttempt }),
      ...(this.#lastRelease === undefined ? {} : { lastRelease: this.#lastRelease }),
      evidence: [...this.#evidence],
    };
  }

  // --- acquisition ---------------------------------------------------------

  #attemptAcquireSync(): SyncAttempt {
    this.#attemptTakeover = false;
    this.#attemptObservedLockId = undefined;
    this.#attemptReason = 'no lease was present; published a fresh lease atomically';
    ensureDirectory(this.#locksDirectory);
    // Fast path: when a canonical lock already exists, read it instead of
    // staging a temp directory that would immediately lose the publish race.
    if (!pathExists(this.#lockDirectory)) {
      const candidate = this.#newLease();
      try {
        this.#publishLeaseAtomic(candidate);
        this.#adopt(candidate);
        return 'held';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') {
          this.#attemptReason = 'the lease could not be published (filesystem error)';
          return 'unknown';
        }
      }
    }
    const current = this.#readLease();
    if (current.kind === 'missing') {
      this.#attemptReason = 'the canonical lock disappeared; retrying';
      return 'stale';
    }
    if (current.kind === 'empty') {
      this.#attemptReason = 'an empty canonical lock directory is crash residue and requires a guarded reclaim';
      return 'stale';
    }
    if (current.kind === 'corrupt') {
      this.#attemptReason = 'the canonical lease is unreadable; refusing to guess';
      return 'unknown';
    }
    this.#attemptObservedLockId = current.lease.lockId;
    const decision = this.#evaluate(current.lease);
    if (decision === 'live') {
      this.#attemptReason = 'another live instance holds the data root lock';
      return 'busy';
    }
    if (decision === 'unknown') {
      this.#attemptReason = 'the lease owner cannot be proven dead (foreign host or unknown liveness)';
      return 'unknown';
    }
    this.#attemptReason = 'a stale lease requires a guarded takeover';
    return 'stale';
  }

  async #takeoverGuarded(): Promise<AcquireAttempt> {
    if (this.#platform === 'win32') {
      // Only the guarded stale-takeover is refused here; the normal acquire and
      // release paths have no win32 branch and remain unverified (T008).
      this.#attemptReason =
        'guarded takeover is disabled on win32 until directory-rename exclusivity is verified (T008)';
      return 'unknown';
    }
    try {
      return await this.#withGuard(() => this.#takeoverUnderGuard());
    } catch {
      this.#attemptReason = 'the recovery guard was unavailable; refusing an unguarded takeover';
      return 'unknown';
    }
  }

  #takeoverUnderGuard(): AcquireAttempt {
    const current = this.#readLease();
    if (current.kind === 'corrupt') {
      this.#attemptReason = 'a corrupt lease exists; refusing to delete it';
      return 'unknown';
    }
    if (current.kind === 'missing') {
      const candidate = this.#newLease();
      try {
        this.#publishLeaseAtomic(candidate);
      } catch {
        this.#attemptReason = 'another contender won the publish race';
        return 'busy';
      }
      this.#adopt(candidate);
      this.#attemptTakeover = true;
      this.#attemptReason = 'published a fresh lease after a stale lock had been removed';
      return 'held';
    }
    if (current.kind === 'empty') {
      const reclaimed = this.#quarantineCanonical();
      if (!reclaimed) {
        this.#attemptReason = 'an empty canonical lock could not be reclaimed';
        return 'busy';
      }
      const candidate = this.#newLease();
      try {
        this.#publishLeaseAtomic(candidate);
      } catch {
        this.#attemptReason = 'another contender won the publish race';
        return 'busy';
      }
      this.#adopt(candidate);
      this.#attemptTakeover = true;
      this.#attemptReason = 'reclaimed an empty canonical lock directory';
      return 'held';
    }
    const decision = this.#evaluate(current.lease);
    if (decision === 'live') {
      this.#attemptReason = 'under the guard the holder is live; not taking over';
      return 'busy';
    }
    if (decision === 'unknown') {
      this.#attemptReason = 'under the guard the owner still cannot be proven dead';
      return 'unknown';
    }
    this.#attemptTakeover = true;
    const quarantine = this.#quarantineCanonical();
    if (!quarantine.ok) {
      this.#attemptReason = 'the stale lock could not be quarantined';
      return 'busy';
    }
    const moved = quarantine.lease;
    if (moved === undefined || moved.lockId !== current.lease.lockId) {
      // Only reachable if an external actor replaced the directory; restore, never delete.
      this.#restoreQuarantinedLock(quarantine.path);
      this.#recordEvidence({
        kind: 'restored',
        lockId: current.lease.lockId,
        instanceId: current.lease.instanceId,
        detail: 'guarded takeover read back a different lease; restored without deleting',
        quarantinePath: quarantine.path,
      });
      this.#attemptReason = 'guarded takeover read back a different lease; restored and failed closed';
      return 'unknown';
    }
    this.#recordEvidence({
      kind: 'takeover',
      lockId: moved.lockId,
      instanceId: moved.instanceId,
      detail: `took over a stale lease from pid ${String(moved.pid)}`,
      quarantinePath: quarantine.path,
      staleLease: moved,
    });
    const candidate = this.#newLease();
    try {
      this.#publishLeaseAtomic(candidate);
    } catch {
      this.#attemptReason = 'another contender won the publish race after the stale lock was removed';
      return 'busy';
    }
    this.#adopt(candidate);
    this.#attemptReason = `took over a stale lease from pid ${String(moved.pid)}`;
    return 'held';
  }

  #releaseUnderGuard(lease: DataRootLease): DataRootLockReleaseResult {
    const current = this.#readLease();
    if (current.kind === 'missing') {
      return { at: this.#now(), released: true, reason: 'the lease was already absent' };
    }
    if (current.kind !== 'valid') {
      return {
        at: this.#now(),
        released: false,
        reason: 'the canonical lock is empty or corrupt; refusing to delete it',
      };
    }
    if (current.lease.lockId !== lease.lockId || current.lease.instanceId !== lease.instanceId) {
      return {
        at: this.#now(),
        released: false,
        reason: 'the published lease identity did not match this instance; nothing was deleted',
      };
    }
    const quarantine = this.#quarantineCanonical();
    if (!quarantine.ok) {
      return { at: this.#now(), released: false, reason: 'the lease could not be moved aside for release' };
    }
    const moved = quarantine.lease;
    if (moved !== undefined && moved.lockId === lease.lockId && moved.instanceId === lease.instanceId) {
      rmSync(quarantine.path, { recursive: true, force: true });
      return {
        at: this.#now(),
        released: true,
        reason: 'removed the exact lease this instance created',
        removedLockId: lease.lockId,
      };
    }
    this.#restoreQuarantinedLock(quarantine.path);
    return {
      at: this.#now(),
      released: false,
      reason: 'release observed a lease it did not own; restored without deleting',
    };
  }

  // --- recovery guard ------------------------------------------------------

  async #withGuard<T>(work: () => T): Promise<T> {
    const deadline = Date.now() + this.#guardWaitMs;
    for (;;) {
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => {
          sockets.delete(socket);
        });
        socket.end(`${GUARD_GREETING}\n`);
      });
      // Sockets are created CLOEXEC by Node, so managed children cannot inherit
      // the guard listener.
      const bound = await this.#tryBind(server);
      if (bound) {
        try {
          return work();
        } finally {
          await this.#closeServerBounded(server, sockets);
        }
      }
      const guardAlive = await this.#probeGuard();
      if (!guardAlive) {
        throw new DataRootGuardUnavailableError(
          'the guard port is held by a process that is not an HDSL recovery guard',
        );
      }
      if (Date.now() >= deadline) {
        throw new DataRootGuardUnavailableError('timed out waiting for the recovery guard');
      }
      await delay(20);
    }
  }

  #tryBind(server: Server): Promise<boolean> {
    return new Promise<boolean>((settle) => {
      const onError = (): void => {
        server.removeListener('listening', onListening);
        settle(false);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        settle(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port: this.#guardPort, host: '127.0.0.1', exclusive: true });
    });
  }

  /**
   * Closes the guard listener with a bounded wait. If the platform refuses to
   * finish in time, the tracked sockets are destroyed so the port cannot leak
   * and block the next acquisition; the next attempt then fails closed.
   */
  async #closeServerBounded(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
    await new Promise<void>((settle) => {
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          settle();
        }
      };
      const timer = setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
        finish();
      }, this.#guardCloseTimeoutMs);
      timer.unref();
      server.close(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  #probeGuard(): Promise<boolean> {
    return new Promise<boolean>((settle) => {
      let answered = false;
      const socket = connect({ port: this.#guardPort, host: '127.0.0.1' });
      socket.setTimeout(500);
      socket.once('data', (chunk: Buffer) => {
        answered = chunk.toString('utf8').startsWith(GUARD_GREETING);
      });
      socket.once('timeout', () => {
        socket.destroy();
        settle(false);
      });
      socket.once('error', () => {
        settle(false);
      });
      socket.once('close', () => {
        settle(answered);
      });
    });
  }

  // --- lease lifecycle -----------------------------------------------------

  #newLease(): DataRootLease {
    return {
      schemaVersion: LEASE_SCHEMA_VERSION,
      lockId: randomUUID(),
      instanceId: this.#instanceId,
      pid: this.#pid,
      hostname: this.#hostname,
      acquiredAt: this.#now(),
      heartbeatAt: this.#now(),
    };
  }

  #adopt(lease: DataRootLease): void {
    this.#lostReason = undefined;
    this.#lease = lease;
    this.#startHeartbeat();
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    const handle = setInterval(() => {
      try {
        this.#beat();
      } catch {
        // Retried on the next tick; assertHeld() gates every write.
      }
    }, this.#heartbeatIntervalMs);
    handle.unref();
    this.#heartbeat = handle;
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }

  #beat(): void {
    const lease = this.#lease;
    if (lease === undefined) {
      return;
    }
    const current = this.#readLease();
    if (current.kind === 'missing' || current.kind === 'empty') {
      const candidate: DataRootLease = { ...lease, heartbeatAt: this.#now() };
      try {
        this.#publishLeaseAtomic(candidate);
        this.#lease = candidate;
      } catch {
        const after = this.#readLease();
        if (after.kind === 'valid' && after.lease.lockId !== lease.lockId) {
          this.#markLost('another instance published a different lease', lease);
        }
      }
      return;
    }
    if (current.kind === 'corrupt' || current.lease.lockId !== lease.lockId) {
      this.#markLost('another instance published a different lease', lease);
      return;
    }
    const next: DataRootLease = { ...lease, heartbeatAt: this.#now() };
    try {
      this.#writeLeaseAtomic(next);
    } catch {
      return;
    }
    const verify = this.#readLease();
    if (verify.kind !== 'valid' || verify.lease.lockId !== next.lockId) {
      this.#markLost('the lease was replaced while refreshing the heartbeat', lease);
      return;
    }
    this.#lease = next;
  }

  #markLost(reason: string, lease: DataRootLease): void {
    this.#stopHeartbeat();
    this.#lease = undefined;
    this.#lostReason = reason;
    this.#recordEvidence({
      kind: 'lost',
      lockId: lease.lockId,
      instanceId: lease.instanceId,
      detail: reason,
    });
  }

  #evaluate(existing: DataRootLease): LeaseDecision {
    if (existing.hostname !== this.#hostname) {
      return 'unknown';
    }
    const heartbeat = Date.parse(existing.heartbeatAt);
    if (!Number.isFinite(heartbeat)) {
      return 'unknown';
    }
    if (this.#clock().getTime() - heartbeat < this.#staleAfterMs) {
      return 'live';
    }
    const liveness = this.#probeProcess(existing.pid);
    if (liveness === 'alive') {
      // A stale heartbeat with a live pid (possibly re-used) is never stolen.
      return 'live';
    }
    return liveness === 'dead' ? 'stale' : 'unknown';
  }

  // --- filesystem primitives -----------------------------------------------

  /** Writes `lease.json` in a private directory and atomically renames the directory. */
  #publishLeaseAtomic(lease: DataRootLease): void {
    ensureDirectory(this.#locksDirectory);
    const temporary = join(this.#locksDirectory, `tmp-${this.#pid}-${randomUUID()}`);
    mkdirSync(temporary);
    try {
      const descriptor = openSync(join(temporary, LEASE_FILE), 'wx');
      try {
        writeSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      fsyncDirectory(temporary);
      renameSync(temporary, this.#lockDirectory);
      fsyncDirectory(this.#locksDirectory);
    } catch (error) {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of our own temp directory.
      }
      throw error;
    }
  }

  /** Atomic heartbeat replacement (temp file + rename over `lease.json`). */
  #writeLeaseAtomic(lease: DataRootLease): void {
    ensureDirectory(this.#locksDirectory);
    const temporary = join(this.#lockDirectory, `.lease-${this.#pid}-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, 'wx');
    try {
      writeSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.#leasePath);
  }

  #readLease(): LeaseRead {
    if (!pathExists(this.#lockDirectory)) {
      return { kind: 'missing' };
    }
    if (!pathExists(this.#leasePath)) {
      return { kind: 'empty' };
    }
    const raw = readTextFile(this.#leasePath);
    if (raw === undefined) {
      return { kind: 'empty' };
    }
    try {
      const value: unknown = JSON.parse(raw);
      return isDataRootLease(value) ? { kind: 'valid', lease: value } : { kind: 'corrupt' };
    } catch {
      return { kind: 'corrupt' };
    }
  }

  /** Moves the canonical lock directory to a fresh quarantine path (guard-held). */
  #quarantineCanonical(): { readonly ok: true; readonly path: string; readonly lease: DataRootLease | undefined } | { readonly ok: false } {
    ensureDirectory(this.#quarantineDirectory);
    const observed = this.#readLease();
    const name = observed.kind === 'valid' ? observed.lease.lockId : 'empty';
    const path = join(this.#quarantineDirectory, `${name}-${randomUUID()}`);
    try {
      renameSync(this.#lockDirectory, path);
    } catch {
      return { ok: false };
    }
    const movedLease = tryReadJsonFile<unknown>(join(path, LEASE_FILE));
    return isDataRootLease(movedLease)
      ? { ok: true, path, lease: movedLease }
      : { ok: true, path, lease: undefined };
  }

  #restoreQuarantinedLock(quarantinePath: string): void {
    try {
      renameSync(quarantinePath, this.#lockDirectory);
      return;
    } catch {
      // Fall through: restore the lease file alone if the directory cannot move.
    }
    try {
      ensureDirectory(this.#lockDirectory);
      renameSync(join(quarantinePath, LEASE_FILE), this.#leasePath);
      rmSync(quarantinePath, { recursive: true, force: true });
    } catch {
      // Leave the quarantine as evidence; never clobber a fresher lock.
    }
  }

  #recordEvidence(entry: Omit<DataRootLockEvidence, 'schemaVersion' | 'at'>): void {
    try {
      const record: DataRootLockEvidence = {
        schemaVersion: '1',
        at: this.#now(),
        ...entry,
      };
      this.#evidence.push(record);
      if (this.#evidence.length > 64) {
        this.#evidence.shift();
      }
      ensureDirectory(this.#evidenceDirectory);
      const path = join(
        this.#evidenceDirectory,
        `${entry.kind}-${String(Date.now())}-${randomUUID()}.json`,
      );
      const descriptor = openSync(path, 'wx');
      try {
        writeSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch {
      // Evidence is best-effort; it must never break acquisition/release.
    }
  }

  #recordAttempt(outcome: AcquireAttempt, waitedMs: number): void {
    const reason = this.#platformVerified
      ? this.#attemptReason
      : `${this.#attemptReason} (unverified platform: ${this.#platform}; no cross-process exclusivity claim)`;
    this.#lastAttempt = {
      at: this.#now(),
      outcome,
      reason,
      waitedMs,
      takeover: this.#attemptTakeover,
      ...(this.#attemptObservedLockId === undefined
        ? {}
        : { observedLockId: this.#attemptObservedLockId }),
    };
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

/** Best-effort directory fsync; some platforms reject fsync on directory fds. */
const fsyncDirectory = (path: string): void => {
  try {
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Durability of the rename stays best-effort where the platform refuses.
  }
};
