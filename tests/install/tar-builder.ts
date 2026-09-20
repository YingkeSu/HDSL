/**
 * Synthetic tar.gz builder for installer boundary tests.
 *
 * Real artifacts are downloaded only by the opt-in evidence test; the unit and
 * fault-boundary tests build tiny archives here so they never touch the network.
 */
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  readonly name: string;
  readonly type?: 'file' | 'dir' | 'symlink' | 'hardlink';
  readonly content?: string;
  readonly linkname?: string;
  readonly mode?: number;
  /** Emits a pax extended header carrying `path=` for this entry. */
  readonly paxPath?: string;
  /** Emits a GNU long-name header for this entry. */
  readonly longName?: string;
  /** Emits a GNU long-link header for this entry. */
  readonly longLink?: string;
}

const BLOCK = 512;

const octal = (value: number, length: number): string =>
  `${value.toString(8).padStart(length - 1, '0')}\0`;

const writeNumeric = (block: Buffer, offset: number, length: number, value: number): void => {
  block.write(octal(value, length), offset, length, 'ascii');
};

const headerBlock = (
  name: string,
  size: number,
  type: string,
  mode: number,
  linkname: string,
): Buffer => {
  const block = Buffer.alloc(BLOCK);
  block.write(name.slice(0, 99), 0, 100, 'utf8');
  writeNumeric(block, 100, 8, mode);
  writeNumeric(block, 108, 8, 0);
  writeNumeric(block, 116, 8, 0);
  writeNumeric(block, 124, 12, size);
  writeNumeric(block, 136, 12, 0);
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write(linkname.slice(0, 99), 157, 100, 'utf8');
  block.write('ustar', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
};

const dataBlocks = (content: Buffer): Buffer[] => {
  if (content.length === 0) {
    return [];
  }
  const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  content.copy(padded);
  return [padded];
};

const paxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}`.length + body.length !== length) {
    length = `${length}`.length + body.length;
  }
  return `${length}${body}`;
};

export const buildTarGz = (entries: readonly TarEntry[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.paxPath !== undefined) {
      const body = Buffer.from(paxRecord('path', entry.paxPath), 'utf8');
      blocks.push(headerBlock('./PaxHeaders/entry', body.length, 'x', 0o644, ''));
      blocks.push(...dataBlocks(body));
    }
    if (entry.longName !== undefined) {
      const body = Buffer.from(`${entry.longName}\0`, 'utf8');
      blocks.push(headerBlock('././@LongLink', body.length, 'L', 0o644, ''));
      blocks.push(...dataBlocks(body));
    }
    if (entry.longLink !== undefined) {
      const body = Buffer.from(`${entry.longLink}\0`, 'utf8');
      blocks.push(headerBlock('././@LongLink', body.length, 'K', 0o644, ''));
      blocks.push(...dataBlocks(body));
    }
    const content = entry.content === undefined ? Buffer.alloc(0) : Buffer.from(entry.content, 'utf8');
    const type = entry.type ?? 'file';
    const typeFlag = type === 'file' ? '0' : type === 'dir' ? '5' : type === 'symlink' ? '2' : '1';
    const size = type === 'file' ? content.length : 0;
    const name = type === 'dir' && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
    blocks.push(headerBlock(name, size, typeFlag, entry.mode ?? (type === 'file' ? 0o644 : 0o755), entry.linkname ?? ''));
    if (type === 'file') {
      blocks.push(...dataBlocks(content));
    }
  }
  blocks.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return gzipSync(Buffer.concat(blocks));
};
