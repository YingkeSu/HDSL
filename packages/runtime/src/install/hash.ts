/** Streaming file digests used to verify audited artifacts and extracted trees. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { InstallFailure } from './failure.js';

const digestFile = (path: string, algorithm: 'sha256' | 'sha512'): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('end', () => {
      resolve(hash.digest());
    });
  });

export const sha256File = async (path: string): Promise<string> =>
  (await digestFile(path, 'sha256')).toString('hex');

/** npm `integrity` values are `sha512-<base64>`. */
export const sha512Integrity = async (path: string): Promise<string> =>
  `sha512-${(await digestFile(path, 'sha512')).toString('base64')}`;

interface TreeEntry {
  readonly path: string;
  readonly kind: 'file' | 'symlink';
  readonly value: string;
}

const collectTree = async (root: string, current: string, entries: TreeEntry[]): Promise<void> => {
  const names = await readdir(current);
  names.sort();
  for (const name of names) {
    const absolute = join(current, name);
    const stats = await lstat(absolute);
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (stats.isSymbolicLink()) {
      entries.push({ path: relativePath, kind: 'symlink', value: await readlink(absolute) });
    } else if (stats.isDirectory()) {
      await collectTree(root, absolute, entries);
    } else if (stats.isFile()) {
      entries.push({ path: relativePath, kind: 'file', value: await sha256File(absolute) });
    } else {
      throw new InstallFailure('INTERNAL_ERROR', 'unexpected file type in extracted tree');
    }
  }
};

/**
 * Deterministic digest of a directory tree: sorted `relativePath` + kind +
 * content hash (or symlink target). Used to prove the npm-installed DSH package
 * is byte-identical to the audited top-level artifact we extracted.
 */
export const sha256TreeDigest = async (root: string): Promise<string> => {
  const entries: TreeEntry[] = [];
  await collectTree(root, root, entries);
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${entry.path}\0${entry.value}\n`, 'utf8');
  }
  return hash.digest('hex');
};
