/**
 * Typed harness around `fixture-process.mjs`.
 *
 * A {@link FixtureProcess} owns exactly one fixture process (plus, optionally,
 * its grandchild). Readiness is a file the fixture writes atomically — tests
 * wait on that gate with a bounded timeout rather than sleeping. Every signal
 * goes through {@link import('./identity.js').killGuarded}, so QA only ever
 * kills processes whose token and start time it recorded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { killGuarded, readProcessTableEntry, verifyOwnership, type FixtureRecord } from './identity.js';
import { GateTimeoutError, waitFor } from './isolation.js';

const SCRIPT = fileURLToPath(new URL('./fixture-process.mjs', import.meta.url));

export type FixtureMode = 'hold' | 'stubborn' | 'crash' | 'never-ready' | 'bind';

export interface FixtureSpec {
  readonly label: string;
  readonly mode?: FixtureMode;
  /** Spawn a real grandchild that holds independently. */
  readonly grandchild?: boolean;
  readonly grandchildStubborn?: boolean;
  /** Only for `bind`; 0 or omitted means an ephemeral loopback port. */
  readonly port?: number;
  /** Only for `crash`; default 3. */
  readonly exitCode?: number;
  /** Extra environment for the fixture process (e.g. per-instance HOME). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ReadyInfo {
  readonly raw: string;
  readonly port?: number;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const parseReady = (raw: string): ReadyInfo => {
  const match = /(?:^|\n)port=(\d+)/.exec(raw);
  return match?.[1] === undefined ? { raw } : { raw, port: Number(match[1]) };
};

export class FixtureProcess {
  public readonly label: string;
  public readonly token: string;
  public readonly recordPath: string;
  public readonly recordDir: string;
  public readonly readyFile: string;
  private child: ChildProcess;
  private record?: FixtureRecord;
  private exited?: ExitInfo;
  private exitWaiters: ((info: ExitInfo) => void)[] = [];

  private constructor(spec: FixtureSpec, root: string, child: ChildProcess, token: string) {
    this.label = spec.label;
    this.token = token;
    this.recordDir = join(root, 'records');
    this.readyFile = join(root, 'ready', `${spec.label}.ready`);
    this.recordPath = join(this.recordDir, `parent-${spec.label}.json`);
    this.child = child;
    child.on('close', (code, signal) => {
      this.exited = { code, signal };
      for (const waiter of this.exitWaiters.splice(0)) {
        waiter(this.exited);
      }
    });
  }

  public static spawn(spec: FixtureSpec, root: string): FixtureProcess {
    const token = `hdsl-qa-${randomUUID()}`;
    const recordDir = join(root, 'records');
    const readyDir = join(root, 'ready');
    mkdirSync(recordDir, { recursive: true });
    mkdirSync(readyDir, { recursive: true });
    const args = [
      SCRIPT,
      '--role',
      'parent',
      '--mode',
      spec.mode ?? 'hold',
      '--label',
      spec.label,
      '--record-dir',
      recordDir,
      '--ready-file',
      join(readyDir, `${spec.label}.ready`),
      '--token',
      token,
    ];
    if (spec.grandchild === true) {
      args.push('--grandchild', '1');
    }
    if (spec.grandchildStubborn === true) {
      args.push('--grandchild-stubborn', '1');
    }
    if (spec.port !== undefined) {
      args.push('--port', String(spec.port));
    }
    if (spec.exitCode !== undefined) {
      args.push('--exit-code', String(spec.exitCode));
    }
    if (spec.env !== undefined) {
      args.push('--record-env', '1');
    }
    const child = spawn(process.execPath, args, {
      env: { ...(spec.env ?? {}), HDSL_QA_PROC_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    return new FixtureProcess(spec, root, child, token);
  }

  public get pid(): number {
    return this.record?.pid ?? this.child.pid ?? -1;
  }

  public get fixtureRecord(): FixtureRecord | undefined {
    return this.record;
  }

  public async waitForRecord(timeoutMs = 5_000): Promise<FixtureRecord> {
    if (this.record !== undefined) {
      return this.record;
    }
    await waitFor(() => existsSync(this.recordPath), {
      timeoutMs,
      label: `record ${this.label}`,
    });
    this.record = JSON.parse(readFileSync(this.recordPath, 'utf8')) as FixtureRecord;
    return this.record;
  }

  public async waitForReady(timeoutMs = 10_000): Promise<ReadyInfo> {
    await this.waitForRecord(timeoutMs);
    await waitFor(() => existsSync(this.readyFile), {
      timeoutMs,
      label: `ready ${this.label}`,
    });
    return parseReady(readFileSync(this.readyFile, 'utf8'));
  }

  public grandchildRecordPath(): string {
    return join(this.recordDir, `grandchild-${this.label}-g.json`);
  }

  public async waitForGrandchildRecord(timeoutMs = 5_000): Promise<FixtureRecord> {
    await waitFor(() => existsSync(this.grandchildRecordPath()), {
      timeoutMs,
      label: `grandchild record ${this.label}`,
    });
    return JSON.parse(readFileSync(this.grandchildRecordPath(), 'utf8')) as FixtureRecord;
  }

  /** Reads the SIGTERM/SIGINT counters the fixture recorded (stubborn proof). */
  public signalCount(name: 'SIGTERM' | 'SIGINT'): number {
    const path = join(this.recordDir, `parent-${this.label}.signals`);
    if (!existsSync(path)) {
      return 0;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>;
    return parsed[name] ?? 0;
  }

  public async waitForSignal(name: 'SIGTERM' | 'SIGINT', timeoutMs = 2_000): Promise<void> {
    await waitFor(() => this.signalCount(name) > 0, { timeoutMs, label: `${name} on ${this.label}` });
  }

  public isAlive(): boolean {
    return this.record !== undefined && readProcessTableEntry(this.record.pid) !== undefined;
  }

  public waitForExit(timeoutMs = 5_000): Promise<ExitInfo> {
    if (this.exited !== undefined) {
      return Promise.resolve(this.exited);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) {
          this.exitWaiters.splice(index, 1);
        }
        reject(new GateTimeoutError(`process ${this.label} did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (info: ExitInfo): void => {
        clearTimeout(timer);
        resolve(info);
      };
      this.exitWaiters.push(waiter);
    });
  }

  /**
   * Signals the fixture only after identity verification. Before the record is
   * written we hold a direct ChildProcess handle, which is exact ownership too.
   */
  public kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.record === undefined) {
      this.child.kill(signal);
      return;
    }
    killGuarded(this.record, signal);
  }

  /** Kills the grandchild this fixture spawned, verifying identity first. */
  public async reapGrandchild(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const record = await this.waitForGrandchildRecord();
    if (readProcessTableEntry(record.pid) === undefined) {
      return;
    }
    killGuarded(record, signal);
  }

  /**
   * Best-effort teardown of this fixture and its grandchild. A PID whose
   * identity cannot be proven is never signalled; the method returns the list
   * of records it intentionally skipped so a test can assert nothing leaked.
   */
  public async cleanup(): Promise<readonly FixtureRecord[]> {
    const skipped: FixtureRecord[] = [];
    const reap = (record: FixtureRecord | undefined, fallback?: ChildProcess): void => {
      if (record === undefined) {
        fallback?.kill('SIGKILL');
        return;
      }
      if (readProcessTableEntry(record.pid) === undefined) {
        return;
      }
      try {
        verifyOwnership(record);
        process.kill(record.pid, 'SIGKILL');
      } catch {
        skipped.push(record);
      }
    };
    if (this.child.exitCode === null && !this.exited) {
      reap(this.record, this.child);
    }
    if (existsSync(this.grandchildRecordPath())) {
      reap(JSON.parse(readFileSync(this.grandchildRecordPath(), 'utf8')) as FixtureRecord);
    }
    await this.waitForExit(3_000).catch(() => undefined);
    return skipped;
  }
}

/** Convenience: spawn a fixture that is deliberately never touched by QA. */
export const spawnControlProcess = (label: string, root: string): FixtureProcess =>
  FixtureProcess.spawn({ label, mode: 'hold' }, root);
