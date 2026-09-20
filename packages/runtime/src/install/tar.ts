/**
 * Minimal, dependency-free, hardened tar.gz extractor.
 *
 * Only the subset needed by the audited artifacts is implemented (regular
 * files, directories, symlinks, hardlinks, GNU long names, ustar prefixes and
 * pax extended headers). The extractor is deliberately closed rather than
 * permissive:
 *
 * - absolute entry paths, `..` traversal, Windows drive prefixes and NUL bytes
 *   are rejected (`INTERNAL_ERROR`, never silently skipped);
 * - symlinks must resolve inside the destination, so an archive cannot plant a
 *   link that later writes escape through;
 * - hardlinks must point at an already-extracted file inside the destination;
 * - entry count and total uncompressed size are bounded (decompression-bomb
 *   guard);
 * - header checksums are verified, so a corrupted stream cannot be parsed as a
 *   different tree.
 *
 * It has no third-party dependency on purpose: extraction is a security
 * boundary and must not add supply-chain surface to `@hdsl/runtime`.
 */
import { createReadStream } from 'node:fs';
import { chmod, link, mkdir, open, symlink, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { InstallFailure } from './failure.js';
import { assertWithin, isWithin } from './paths.js';

const BLOCK_SIZE = 512;

class ChunkReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #buffer: Buffer = Buffer.alloc(0);
  #ended = false;

  constructor(source: Readable) {
    this.#iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  async #pull(): Promise<boolean> {
    while (!this.#ended) {
      const next = await this.#iterator.next();
      if (next.done === true) {
        this.#ended = true;
        return false;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (chunk.length === 0) {
        continue;
      }
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      return true;
    }
    return false;
  }

  async readExactly(size: number): Promise<Buffer | undefined> {
    while (this.#buffer.length < size) {
      if (!(await this.#pull())) {
        return undefined;
      }
    }
    const result = Buffer.from(this.#buffer.subarray(0, size));
    this.#buffer = this.#buffer.subarray(size);
    return result;
  }

  async writeExactly(size: number, handle: FileHandle): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (this.#buffer.length === 0 && !(await this.#pull())) {
        throw new InstallFailure('INTERNAL_ERROR', 'the archive ended inside an entry');
      }
      const take = Math.min(remaining, this.#buffer.length);
      await handle.write(this.#buffer.subarray(0, take));
      this.#buffer = this.#buffer.subarray(take);
      remaining -= take;
    }
  }

  async drain(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (this.#buffer.length === 0 && !(await this.#pull())) {
        throw new InstallFailure('INTERNAL_ERROR', 'the archive ended inside an entry');
      }
      const take = Math.min(remaining, this.#buffer.length);
      this.#buffer = this.#buffer.subarray(take);
      remaining -= take;
    }
  }
}

const readString = (buffer: Buffer, offset: number, length: number): string => {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buffer[end] !== 0) {
    end += 1;
  }
  return buffer.toString('utf8', offset, end);
};

const readNumeric = (buffer: Buffer, offset: number, length: number): number => {
  const first = buffer[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let index = 1; index < length; index += 1) {
      value = value * 256 + (buffer[offset + index] ?? 0);
    }
    return value;
  }
  const text = readString(buffer, offset, length).trim();
  if (text === '') {
    return 0;
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InstallFailure('INTERNAL_ERROR', 'the archive contains an invalid numeric field');
  }
  return value;
};

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0);

const checksumMatches = (header: Buffer, expected: number): boolean => {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index] ?? 0;
  }
  return sum === expected;
};

const parsePaxRecords = (payload: string, into: Record<string, string>): void => {
  let cursor = 0;
  while (cursor < payload.length) {
    const space = payload.indexOf(' ', cursor);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(payload.slice(cursor, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > payload.length) {
      throw new InstallFailure('INTERNAL_ERROR', 'the archive contains a malformed pax header');
    }
    const record = payload.slice(space + 1, cursor + length).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals > 0) {
      into[record.slice(0, equals)] = record.slice(equals + 1);
    }
    cursor += length;
  }
};

/** Splits an archive path into safe segments, or rejects it. */
const safeSegments = (value: string): string[] => {
  if (value.includes('\0')) {
    throw new InstallFailure('INTERNAL_ERROR', 'the archive contains a NUL byte in a path');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new InstallFailure('INTERNAL_ERROR', 'the archive contains an absolute path');
  }
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.');
  for (const segment of segments) {
    if (segment === '..') {
      throw new InstallFailure('INTERNAL_ERROR', 'the archive contains a path traversal');
    }
  }
  return segments;
};

export interface TarExtractOptions {
  readonly stripComponents?: number;
  /** Destination-relative prefix every entry is written under. */
  readonly prefix?: string;
  readonly signal?: AbortSignal;
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly onBytes?: (bytes: number) => void;
}

export interface TarExtractResult {
  readonly entries: number;
  readonly bytes: number;
}

const resolveEntryPath = (
  destination: string,
  prefixSegments: readonly string[],
  rawName: string,
  stripComponents: number,
): { absolute: string; segments: string[] } | undefined => {
  const segments = safeSegments(rawName);
  const stripped = stripComponents > 0 ? segments.slice(stripComponents) : segments;
  if (stripped.length === 0) {
    return undefined;
  }
  const combined = [...prefixSegments, ...stripped];
  const absolute = assertWithin(destination, resolve(destination, ...combined), 'archive entry');
  return { absolute, segments: combined };
};

export const extractTarGz = async (
  archivePath: string,
  destination: string,
  options: TarExtractOptions = {},
): Promise<TarExtractResult> => {
  const stripComponents = options.stripComponents ?? 0;
  const prefixSegments = options.prefix === undefined ? [] : safeSegments(options.prefix);
  const maxEntries = options.maxEntries ?? 200_000;
  const maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;

  await mkdir(destination, { recursive: true });
  const input = createReadStream(archivePath);
  const gunzip = createGunzip();
  input.pipe(gunzip);
  const reader = new ChunkReader(gunzip);

  let entries = 0;
  let bytes = 0;
  let pendingPax: Record<string, string> = {};
  const globalPax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;

  try {
    for (;;) {
      if (options.signal?.aborted === true) {
        throw new InstallFailure('INTERNAL_ERROR', 'extraction was cancelled');
      }
      const header = await reader.readExactly(BLOCK_SIZE);
      if (header === undefined || isZeroBlock(header)) {
        break;
      }
      if (!checksumMatches(header, readNumeric(header, 148, 8))) {
        throw new InstallFailure('INTERNAL_ERROR', 'the archive contains a header with a bad checksum');
      }

      let name = readString(header, 0, 100);
      const ustarPrefix = readString(header, 345, 155);
      if (ustarPrefix !== '') {
        name = `${ustarPrefix}/${name}`;
      }
      const type = String.fromCharCode(header[156] ?? 0);
      const mode = readNumeric(header, 100, 8);
      let size = readNumeric(header, 124, 12);
      const linkname = readString(header, 157, 100);

      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        const payload = (await reader.readExactly(size)) ?? Buffer.alloc(0);
        const padding = size % BLOCK_SIZE === 0 ? 0 : BLOCK_SIZE - (size % BLOCK_SIZE);
        await reader.drain(padding);
        if (type === 'x' || type === 'g') {
          parsePaxRecords(payload.toString('utf8'), type === 'x' ? pendingPax : globalPax);
        } else if (type === 'L') {
          longName = payload.toString('utf8').replace(/\0.*$/s, '');
        } else {
          longLink = payload.toString('utf8').replace(/\0.*$/s, '');
        }
        continue;
      }

      const effectiveName = pendingPax['path'] ?? longName ?? name;
      const effectiveLink = pendingPax['linkpath'] ?? longLink ?? linkname;
      if (pendingPax['size'] !== undefined) {
        const paxSize = Number.parseInt(pendingPax['size'], 10);
        if (Number.isSafeInteger(paxSize) && paxSize >= 0) {
          size = paxSize;
        }
      }
      const padding = size % BLOCK_SIZE === 0 ? 0 : BLOCK_SIZE - (size % BLOCK_SIZE);
      pendingPax = {};
      longName = undefined;
      longLink = undefined;

      entries += 1;
      if (entries > maxEntries) {
        throw new InstallFailure('INTERNAL_ERROR', 'the archive contains too many entries');
      }

      const resolved = resolveEntryPath(destination, prefixSegments, effectiveName, stripComponents);
      if (resolved === undefined) {
        await reader.drain(size + padding);
        continue;
      }

      if (type === '5') {
        await mkdir(resolved.absolute, { recursive: true, mode: mode === 0 ? 0o755 : mode & 0o777 });
        await reader.drain(size + padding);
        continue;
      }

      if (type === '0' || type === '\0' || type === '' || type === '7') {
        if (bytes + size > maxTotalBytes) {
          throw new InstallFailure('INTERNAL_ERROR', 'the archive exceeds the extraction size limit');
        }
        bytes += size;
        await mkdir(dirname(resolved.absolute), { recursive: true });
        const handle = await open(resolved.absolute, 'w', mode === 0 ? 0o644 : mode & 0o777);
        try {
          await reader.writeExactly(size, handle);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(resolved.absolute, mode === 0 ? 0o644 : mode & 0o777);
        await reader.drain(padding);
        options.onBytes?.(size);
        continue;
      }

      if (type === '2') {
        const linkTarget = resolve(dirname(resolved.absolute), effectiveLink);
        if (!isWithin(destination, linkTarget)) {
          throw new InstallFailure('INTERNAL_ERROR', 'the archive contains a symlink that escapes the destination');
        }
        await mkdir(dirname(resolved.absolute), { recursive: true });
        await symlink(effectiveLink, resolved.absolute);
        await reader.drain(size + padding);
        continue;
      }

      if (type === '1') {
        const linkResolved = resolveEntryPath(destination, prefixSegments, effectiveLink, stripComponents);
        if (linkResolved === undefined) {
          throw new InstallFailure('INTERNAL_ERROR', 'the archive contains an unusable hardlink');
        }
        await mkdir(dirname(resolved.absolute), { recursive: true });
        await link(linkResolved.absolute, resolved.absolute);
        await reader.drain(size + padding);
        continue;
      }

      // Character/block devices, FIFOs and unknown types carry no usable tree.
      await reader.drain(size + padding);
    }
  } finally {
    input.destroy();
    gunzip.destroy();
  }

  return { entries, bytes };
};
