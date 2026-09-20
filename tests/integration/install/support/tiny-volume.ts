/**
 * Real disk-exhaustion fixture (macOS) plus an explicit injected fallback.
 *
 * A genuine ENOSPC is produced by attaching a tiny HFS+ disk image with
 * `hdiutil` and writing until the filesystem returns `errno 28`. This is a
 * mounted volume, not a mock. On non-macOS hosts (the engineering CI runs on
 * Linux) there is no equivalent unprivileged way to mount a tiny volume, so the
 * suite substitutes an injected `ENOSPC` and must label it as such
 * (`DiskFaultMode`). The two modes are never conflated in the report.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export type DiskFaultMode = 'mounted-tiny-volume' | 'injected-enospc' | 'unavailable';

export interface TinyVolume {
  readonly mode: 'mounted-tiny-volume';
  readonly mountPath: string;
  readonly sizeMb: number;
  detach(): void;
}

/** Creates and mounts a small HFS+ image; returns `undefined` off macOS. */
export const mountTinyVolume = (root: string, sizeMb = 2): TinyVolume | undefined => {
  if (process.platform !== 'darwin') {
    return undefined;
  }
  const image = join(root, 'hdsl-qa-disk.dmg');
  const mountPath = join(root, 'mnt');
  mkdirSync(mountPath, { recursive: true });
  const run = (args: readonly string[]): void => {
    execFileSync('hdiutil', args, { stdio: 'ignore' });
  };
  run(['create', '-size', `${sizeMb}m`, '-fs', 'HFS+', '-volname', 'HDSLQA', image]);
  run(['attach', '-nobrowse', '-quiet', '-mountpoint', mountPath, image]);
  let detached = false;
  return {
    mode: 'mounted-tiny-volume',
    mountPath,
    sizeMb,
    detach: () => {
      if (detached) {
        return;
      }
      detached = true;
      try {
        run(['detach', mountPath]);
      } catch {
        run(['detach', '-force', mountPath]);
      }
    },
  };
};

/**
 * Writes fixed blocks until the filesystem reports ENOSPC; returns the error.
 *
 * P3-4: call this only on a mounted tiny volume. The default cap is small so a
 * mistaken call against a normal directory cannot fill the temp disk; pass an
 * explicit larger cap if a bigger volume is under test.
 */
export const writeUntilEnospc = (dir: string, maxBytes = 8 * 1024 * 1024): NodeJS.ErrnoException => {
  const block = Buffer.alloc(1024 * 1024, 0x41);
  const path = join(dir, 'hdsl-qa-fill.bin');
  const fd = openSync(path, 'w');
  let written = 0;
  try {
    for (;;) {
      try {
        writeSync(fd, block);
        written += block.length;
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === 'ENOSPC') {
          return errno;
        }
        throw error;
      }
      if (written > maxBytes) {
        throw new Error(`filesystem did not report ENOSPC after ${written} bytes`);
      }
    }
  } finally {
    closeSync(fd);
  }
};
