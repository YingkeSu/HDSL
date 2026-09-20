/**
 * Small synchronous filesystem helpers used by the environment/transaction
 * layer.
 *
 * Records (environment, operation, journal, idempotency) are tiny JSON files
 * that must be durable *before* the synchronous `ContractPort` call returns, so
 * this layer uses the synchronous `node:fs` API. Writes go through
 * write-temp → fsync → rename so a crash can never leave a half-written record
 * in place.
 *
 * No helper here ever walks outside its caller-provided root: every derived
 * path is checked with {@link assertWithin}.
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
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

let temporaryCounter = 0;

export const ensureDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true });
};

export const pathExists = (path: string): boolean => existsSync(path);

export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Directory fsync is best-effort: some platforms reject it on directory fds. */
const fsyncBestEffort = (path: string): void => {
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

export const writeFileAtomic = (path: string, data: string | Uint8Array): void => {
  ensureDirectory(dirname(path));
  temporaryCounter += 1;
  const temporary = `${path}.tmp-${String(process.pid)}-${String(temporaryCounter)}`;
  const descriptor = openSync(temporary, 'w');
  try {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    writeSync(descriptor, buffer);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  fsyncBestEffort(dirname(path));
};

export const writeJsonAtomic = (path: string, value: unknown): void => {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** Reads JSON, returning `undefined` only when the file does not exist. */
export const readJsonFile = <T>(path: string): T | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(raw) as T;
};

export const readTextFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

export const removePath = (path: string): void => {
  rmSync(path, { recursive: true, force: true });
};

export const readDirectoryNames = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

/** True when `candidate` is `root` itself or lives inside it. */
export const isWithin = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
};

/**
 * Resolves `candidate` and rejects it when it escapes `root`. This is the
 * single guard that prevents an opaque id or a composed path from turning into
 * a directory-traversal write (FR-001, path-safety acceptance).
 */
export const assertWithin = (root: string, candidate: string, label: string): string => {
  const resolved = resolve(candidate);
  if (!isWithin(root, resolved)) {
    throw new Error(`${label} escapes its root directory`);
  }
  return resolved;
};

/** `ENOSPC` / `EDQUOT` are the real "disk is full" signals from the OS. */
export const isSpaceError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT';
};
