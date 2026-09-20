/**
 * Durable process records.
 *
 * Two journals live under the app-data root:
 *
 * - `process/launches/<environmentId>.json` — one managed DSH launch per
 *   environment. It records the ownership identity (pid + kernel start token +
 *   command fragment), the verified loopback origin and the last state. It is
 *   the only place restart reconciliation reads from, and it never contains a
 *   token, query string, cookie or credential value.
 * - `<generation>/.hdsl-process-children/<token>.json` — short-lived managed
 *   installer children (`npm ci`, preflight). They are written by
 *   `run-command.ts` so a crash during install leaves a durable identity that
 *   reconciliation can prove and clean up with the same ownership check.
 *
 * Writes go temp → fsync → rename, so a reader never observes a half-written
 * record.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OPAQUE_ID_PATTERN, type ErrorCode } from '@hdsl/contracts';

let temporaryCounter = 0;

const writeJsonAtomic = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  temporaryCounter += 1;
  const temporary = `${path}.tmp-${String(process.pid)}-${String(temporaryCounter)}`;
  const descriptor = openSync(temporary, 'w');
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
};

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // Missing or torn records are treated as absent (an interrupted write must
    // not make reconciliation throw).
    return undefined;
  }
};

const listJsonFiles = (directory: string): string[] => {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
};

/** Kernel-backed identity of a managed child; never a bare pid. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly pgid: number;
  readonly startToken: string;
  readonly commandFragment: string;
  readonly createdAt: string;
}

export interface ProcessEndpoint {
  /** Canonical loopback origin, never carries a token, query or cookie. */
  readonly origin: string;
  readonly host: string;
  readonly port: number;
}

export type ProcessLaunchState =
  | 'spawning'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'unverifiable';

export interface ProcessLaunchRecord {
  readonly schemaVersion: '1';
  readonly environmentId: string;
  readonly expectedRevision: number;
  readonly generationDirectory: string;
  readonly commandFragment: string;
  readonly state: ProcessLaunchState;
  readonly identity: ProcessIdentity | null;
  readonly endpoint: ProcessEndpoint | null;
  readonly exitCode: number | null;
  readonly errorCode: ErrorCode | null;
  readonly errorDetail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sequence: number;
}

export class LaunchRecordStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  get directory(): string {
    return this.#directory;
  }

  #path(environmentId: string): string {
    return join(this.#directory, `${environmentId}.json`);
  }

  read(environmentId: string): ProcessLaunchRecord | undefined {
    if (!OPAQUE_ID_PATTERN.test(environmentId)) {
      return undefined;
    }
    return readJson<ProcessLaunchRecord>(this.#path(environmentId));
  }

  write(record: ProcessLaunchRecord): void {
    if (!OPAQUE_ID_PATTERN.test(record.environmentId)) {
      throw new Error('environmentId must be an opaque id');
    }
    writeJsonAtomic(this.#path(record.environmentId), record);
  }

  remove(environmentId: string): void {
    if (!OPAQUE_ID_PATTERN.test(environmentId)) {
      return;
    }
    rmSync(this.#path(environmentId), { force: true });
  }

  list(): ProcessLaunchRecord[] {
    const records: ProcessLaunchRecord[] = [];
    for (const name of listJsonFiles(this.#directory)) {
      const record = readJson<ProcessLaunchRecord>(join(this.#directory, name));
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

/** One managed installer child (`npm ci`, preflight). */
export interface InstallChildRecord {
  readonly schemaVersion: '1';
  readonly token: string;
  readonly pid: number;
  readonly pgid: number;
  readonly startToken: string;
  readonly commandFragment: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class InstallChildJournal {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  get directory(): string {
    return this.#directory;
  }

  write(record: InstallChildRecord): void {
    writeJsonAtomic(join(this.#directory, `${record.token}.json`), record);
  }

  remove(token: string): void {
    rmSync(join(this.#directory, `${token}.json`), { force: true });
  }

  list(): InstallChildRecord[] {
    const records: InstallChildRecord[] = [];
    for (const name of listJsonFiles(this.#directory)) {
      const record = readJson<InstallChildRecord>(join(this.#directory, name));
      if (record !== undefined) {
        records.push(record);
      }
    }
    return records;
  }
}

export const INSTALL_CHILD_DIRECTORY_NAME = '.hdsl-process-children';

/**
 * Derives the install-child journal directory from a managed child's explicit
 * environment. The installer always points `DSH_HOME` at `<generation>/home`
 * and `TMPDIR` inside it, so the generation directory — and therefore the
 * journal — is derivable without an installer change. Returns `undefined` for
 * an unmanaged caller (no generation layout), which simply disables the
 * journal; tree termination on timeout/cancel still applies.
 */
export const installChildDirectoryForEnvironment = (
  environment: Readonly<Record<string, string>>,
): string | undefined => {
  const dshHome = environment['DSH_HOME'];
  if (dshHome === undefined || dshHome.trim() === '') {
    return undefined;
  }
  const generationDirectory = resolve(dirname(dshHome));
  if (!existsSync(join(generationDirectory, 'home'))) {
    return undefined;
  }
  return join(generationDirectory, INSTALL_CHILD_DIRECTORY_NAME);
};

/** Every install-child journal under a data root, for restart reconciliation. */
export const listInstallChildJournals = (
  dataRoot: string,
): readonly { readonly generationDirectory: string; readonly journal: InstallChildJournal }[] => {
  const found: { generationDirectory: string; journal: InstallChildJournal }[] = [];
  const environments = join(dataRoot, 'environments');
  let environmentIds: string[];
  try {
    environmentIds = readdirSync(environments);
  } catch {
    return found;
  }
  for (const environmentId of environmentIds) {
    if (!OPAQUE_ID_PATTERN.test(environmentId)) {
      continue;
    }
    const generations = join(environments, environmentId, 'generations');
    let generationIds: string[];
    try {
      generationIds = readdirSync(generations);
    } catch {
      continue;
    }
    for (const generationId of generationIds) {
      if (!OPAQUE_ID_PATTERN.test(generationId)) {
        continue;
      }
      const generationDirectory = join(generations, generationId);
      const journalDirectory = join(generationDirectory, INSTALL_CHILD_DIRECTORY_NAME);
      if (existsSync(journalDirectory)) {
        found.push({ generationDirectory, journal: new InstallChildJournal(journalDirectory) });
      }
    }
  }
  return found;
};
