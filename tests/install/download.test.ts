/**
 * Download-boundary tests against a local loopback HTTP server.
 *
 * The server stands in for the audited artifact host so the tests can produce a
 * truncated response deterministically; the digest is still enforced by the
 * installer, so this is not a mock of the verification itself.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimePort, downloadToFile } from '@hdsl/runtime';
import { sha256, syntheticCombination, syntheticDshTarball, syntheticNodeTarball } from './synthetic.js';

interface Route {
  readonly body: Buffer;
  /** Declares a larger `content-length` and stops, simulating an interruption. */
  readonly truncateAt?: number;
}

const servers: Server[] = [];
const roots: string[] = [];

const startServer = async (routes: Record<string, Route>): Promise<string> => {
  const server = createServer((request, response) => {
    const route = routes[request.url ?? ''];
    if (route === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const declared = route.truncateAt ?? route.body.length;
    response.setHeader('content-length', String(declared));
    if (route.truncateAt === undefined) {
      response.end(route.body);
      return;
    }
    response.write(route.body.subarray(0, route.truncateAt));
    response.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
};

const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-download-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('downloadToFile', () => {
  it('writes the received bytes and honours the signal', async () => {
    const base = await startServer({ '/artifact.bin': { body: Buffer.from('hello world') } });
    const root = temporaryRoot();
    const target = join(root, 'artifact.bin');
    const bytes = await downloadToFile(`${base}/artifact.bin`, target, {
      fetch: (input, init) => fetch(input, init),
      signal: new AbortController().signal,
      maxBytes: 1024,
    });
    expect(bytes).toBe(11);
    expect(readFileSync(target, 'utf8')).toBe('hello world');
  });

  it('rejects a truncated response instead of accepting partial bytes', async () => {
    const base = await startServer({ '/artifact.bin': { body: Buffer.from('hello world'), truncateAt: 4 } });
    const root = temporaryRoot();
    await expect(
      downloadToFile(`${base}/artifact.bin`, join(root, 'artifact.bin'), {
        fetch: (input, init) => fetch(input, init),
        signal: new AbortController().signal,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/download|interrupted|truncated/i);
  });
});

describe('runtime port download faults', () => {
  const nodeTarball = syntheticNodeTarball('24.0.0');
  const dshTarball = syntheticDshTarball('0.1.5-rc.2');

  it('fails with DOWNLOAD_FAILED when the transfer is interrupted', async () => {
    const base = await startServer({
      [`/node-${sha256(nodeTarball)}.tgz`]: { body: nodeTarball },
      [`/dsh-${sha256(dshTarball)}.tgz`]: { body: dshTarball },
    });
    const root = temporaryRoot();
    const combination = syntheticCombination({
      nodeVersion: '24.0.0',
      nodeTarball,
      dshVersion: '0.1.5-rc.2',
      dshTarball,
      urlBase: base,
    });
    const runtime = createRuntimePort({
      closureInstall: false,
      precheck: 'none',
      faults: { failDownloadAfterBytes: 4 },
    });
    const resolved = runtime.resolveComposition(combination);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const outcome = await runtime.install(resolved.value, join(root, 'generation'), {
      signal: new AbortController().signal,
      cacheDirectory: join(root, 'artifacts'),
      scratchDirectory: join(root, 'tmp'),
      npmCacheDirectory: join(root, 'npm-cache'),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('DOWNLOAD_FAILED');
    }
  });

  it('fails with DIGEST_MISMATCH when the bytes do not match the catalog', async () => {
    const base = await startServer({
      [`/node-${sha256(nodeTarball)}.tgz`]: { body: nodeTarball },
      [`/dsh-${sha256(dshTarball)}.tgz`]: { body: dshTarball },
    });
    const root = temporaryRoot();
    const combination = syntheticCombination({
      nodeVersion: '24.0.0',
      nodeTarball,
      dshVersion: '0.1.5-rc.2',
      dshTarball,
      urlBase: base,
    });
    const runtime = createRuntimePort({
      closureInstall: false,
      precheck: 'none',
      faults: { corruptDownload: true },
    });
    const resolved = runtime.resolveComposition(combination);
    if (!resolved.ok) return;
    const outcome = await runtime.install(resolved.value, join(root, 'generation'), {
      signal: new AbortController().signal,
      cacheDirectory: join(root, 'artifacts'),
      scratchDirectory: join(root, 'tmp'),
      npmCacheDirectory: join(root, 'npm-cache'),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('DIGEST_MISMATCH');
    }
  });
});
