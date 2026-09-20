/** Disk-space guard for the download/extract boundaries. */
import { statfs } from 'node:fs/promises';

export type FreeBytesProbe = (path: string) => Promise<number | undefined>;

export const defaultFreeBytes: FreeBytesProbe = async (path) => {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // Unknown free space must not block an install; the real ENOSPC signal is
    // still mapped to DISK_FULL by the write path.
    return undefined;
  }
};
