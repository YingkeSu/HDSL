/**
 * Minimal deterministic `.tar.gz` writer for install-QA fixtures.
 *
 * Node and DSH are distributed as tarballs (T001 R001/R002: npm tarball and
 * Node distribution archives), so a real gzip-compressed tar is the least
 * surprising artifact shape to feed the managed installer. This module has no
 * third-party dependency and is byte-deterministic so fixture digests are
 * stable across runs and machines.
 *
 * Only regular files are supported; paths must be short enough to fit the
 * 100-byte ustar `name` field. That is enough for a fixture whose purpose is
 * digest/download/fault behavior, not archive-format coverage.
 */
import { gzipSync } from 'node:zlib';

const BLOCK = 512;

export interface TarEntry {
  readonly path: string;
  readonly data: Uint8Array;
  /** POSIX mode bits; defaults to 0o644. */
  readonly mode?: number;
}

const stringField = (value: string, size: number): Uint8Array => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > size) {
    throw new Error(`tar field overflow: ${value}`);
  }
  const out = Buffer.alloc(size, 0);
  bytes.copy(out, 0);
  return out;
};

const octalField = (value: number, size: number): Uint8Array => {
  // `size` includes the trailing NUL; ustar writes octal ASCII digits.
  const digits = Math.max(1, value).toString(8);
  const padded = digits.padStart(size - 1, '0');
  if (padded.length > size - 1) {
    throw new Error(`tar octal overflow: ${value}`);
  }
  return stringField(padded, size);
};

const checksumField = (header: Uint8Array): Uint8Array => {
  // Checksum is computed with the checksum field itself treated as spaces.
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  const digits = sum.toString(8).padStart(6, '0');
  return stringField(`${digits}\0 `, 8);
};

const headerFor = (entry: TarEntry): Uint8Array => {
  const header = new Uint8Array(BLOCK);
  const write = (offset: number, field: Uint8Array): void => {
    header.set(field, offset);
  };
  const mode = entry.mode ?? 0o644;
  write(0, stringField(entry.path, 100));
  write(100, octalField(mode, 8));
  write(108, octalField(0, 8)); // uid
  write(116, octalField(0, 8)); // gid
  write(124, octalField(entry.data.length, 12));
  write(136, octalField(0, 12)); // mtime: fixed for determinism
  write(148, stringField('        ', 8)); // checksum placeholder
  write(156, stringField('0', 1)); // typeflag: regular file
  write(157, stringField('', 100)); // linkname
  write(257, stringField('ustar\0', 6));
  write(263, stringField('00', 2));
  write(265, stringField('hdsl-qa', 32));
  write(297, stringField('hdsl-qa', 32));
  write(329, octalField(0, 8)); // devmajor
  write(337, octalField(0, 8)); // devminor
  write(345, stringField('', 155)); // prefix
  write(148, checksumField(header));
  return header;
};

const padToBlock = (data: Uint8Array): Uint8Array => {
  const remainder = data.length % BLOCK;
  if (remainder === 0) {
    return data;
  }
  const out = Buffer.alloc(data.length + (BLOCK - remainder), 0);
  out.set(data, 0);
  return out;
};

/** Builds a deterministic ustar archive (not compressed). */
export const createTar = (entries: readonly TarEntry[]): Buffer => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(headerFor(entry)));
    parts.push(Buffer.from(padToBlock(entry.data)));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
};

/** Builds a deterministic `.tar.gz` (gzip header carries no wall-clock time). */
export const createTarGz = (entries: readonly TarEntry[]): Buffer =>
  gzipSync(createTar(entries), { level: 9 });

/**
 * Independent reader used by the harness self-test: parses a tar header and
 * returns the file entries. It deliberately re-implements the field layout so
 * a writer bug is not masked by sharing code with the writer.
 */
export interface ParsedTarEntry {
  readonly path: string;
  readonly size: number;
  readonly data: Buffer;
}

export const parseTar = (archive: Uint8Array): ParsedTarEntry[] => {
  const buffer = Buffer.from(archive);
  const entries: ParsedTarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const path = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '');
    const size = Number.parseInt(
      header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0',
      8,
    );
    const dataStart = offset + BLOCK;
    const data = buffer.subarray(dataStart, dataStart + size);
    entries.push({ path, size, data: Buffer.from(data) });
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
};
