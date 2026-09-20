/**
 * Boundary tests for the hardened tar.gz extractor.
 *
 * These use tiny synthetic archives: they prove path safety, symlink/hardlink
 * handling and header validation, not real DSH installation.
 */
import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractTarGz } from '@hdsl/runtime';
import { buildTarGz } from './tar-builder.js';

const roots: string[] = [];

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-tar-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('extractTarGz', () => {
  it('extracts files, directories, symlinks and hardlinks with modes', async () => {
    const root = temporaryRoot();
    const archive = join(root, 'archive.tgz');
    writeFileSync(
      archive,
      buildTarGz([
        { name: 'pkg/', type: 'dir', mode: 0o755 },
        { name: 'pkg/lib/', type: 'dir', mode: 0o755 },
        { name: 'pkg/lib/main.js', type: 'file', mode: 0o755, content: 'console.log(1);\n' },
        { name: 'pkg/bin/main.js', type: 'symlink', linkname: '../lib/main.js' },
        { name: 'pkg/lib/copy.js', type: 'hardlink', linkname: 'pkg/lib/main.js' },
      ]),
    );
    const destination = join(root, 'out');
    const result = await extractTarGz(archive, destination, { stripComponents: 1 });
    expect(result.bytes).toBe(Buffer.byteLength('console.log(1);\n'));
    expect(readFileSync(join(destination, 'lib/main.js'), 'utf8')).toBe('console.log(1);\n');
    expect(statSync(join(destination, 'lib/main.js')).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(destination, 'bin/main.js'))).toBe('../lib/main.js');
    expect(readFileSync(join(destination, 'lib/copy.js'), 'utf8')).toBe('console.log(1);\n');
  });

  it('applies a destination prefix', async () => {
    const root = temporaryRoot();
    const archive = join(root, 'archive.tgz');
    writeFileSync(archive, buildTarGz([{ name: 'package/lib/bin.js', type: 'file', content: 'x' }]));
    const destination = join(root, 'out');
    await extractTarGz(archive, destination, {
      stripComponents: 1,
      prefix: 'node_modules/@deepseek-ai/dsh',
    });
    expect(readFileSync(join(destination, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'utf8')).toBe('x');
  });

  it('honours ustar pax and GNU long names', async () => {
    const root = temporaryRoot();
    const longName = `package/${'nested/'.repeat(30)}file.txt`;
    const archive = join(root, 'archive.tgz');
    writeFileSync(
      archive,
      buildTarGz([
        { name: 'package/short.txt', type: 'file', content: 'pax', paxPath: longName },
        { name: 'ignored', type: 'file', content: 'gnu', longName: 'package/gnu-long-name.txt' },
      ]),
    );
    const destination = join(root, 'out');
    await extractTarGz(archive, destination, { stripComponents: 1 });
    expect(readFileSync(join(destination, 'nested/'.repeat(30), 'file.txt'), 'utf8')).toBe('pax');
    expect(readFileSync(join(destination, 'gnu-long-name.txt'), 'utf8')).toBe('gnu');
  });

  it('rejects traversal, absolute paths and escaping symlinks without writing outside', async () => {
    const root = temporaryRoot();
    const destination = join(root, 'out');
    for (const entry of [
      { name: '../escape.txt', type: 'file' as const, content: 'x' },
      { name: '/absolute.txt', type: 'file' as const, content: 'x' },
      { name: 'package/link', type: 'symlink' as const, linkname: '../../escape.txt' },
    ]) {
      const archive = join(root, `evil-${String(Math.random())}.tgz`);
      writeFileSync(archive, buildTarGz([entry]));
      await expect(extractTarGz(archive, destination, { stripComponents: 1 })).rejects.toThrow(
        /traversal|absolute|escapes/,
      );
    }
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
  });

  it('rejects a corrupted header checksum', async () => {
    const root = temporaryRoot();
    const archive = join(root, 'archive.tgz');
    const buffer = buildTarGz([{ name: 'package/a.txt', type: 'file', content: 'x' }]);
    // Gunzip, corrupt a header byte in the name field, and rewrite.
    const { gunzipSync, gzipSync } = await import('node:zlib');
    const raw = gunzipSync(buffer);
    raw[0] = raw[0] === 0x61 ? 0x62 : 0x61;
    writeFileSync(archive, gzipSync(raw));
    await expect(extractTarGz(archive, join(root, 'out'))).rejects.toThrow(/checksum/);
  });

  it('rejects an archive that ends mid-entry', async () => {
    const root = temporaryRoot();
    const archive = join(root, 'archive.tgz');
    const { gunzipSync, gzipSync } = await import('node:zlib');
    const raw = gunzipSync(buildTarGz([{ name: 'package/a.txt', type: 'file', content: 'x'.repeat(2048) }]));
    // Keep only the first header + 100 bytes of the file content.
    writeFileSync(archive, gzipSync(raw.subarray(0, 512 + 100)));
    await expect(extractTarGz(archive, join(root, 'out'))).rejects.toThrow(/ended inside an entry/);
  });
});
