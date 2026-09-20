/**
 * Fixture-harness self-check (`tests/integration/install`).
 *
 * These tests do NOT exercise the launcher: T004 is not implemented yet. They
 * prove that the QA fixtures themselves are real and correct — a real loopback
 * HTTP endpoint, a real gzip/tar archive, real temp directories, a real macOS
 * mounted tiny volume for ENOSPC, and stable composition digests. Green here
 * means "the harness is trustworthy", never "install works".
 *
 * Run: `pnpm vitest run tests/integration/install/harness.test.ts`
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  buildArtifact,
  buildPathTraversalArtifact,
  MARKER_PATH,
  readMarkers,
} from './support/artifacts.js';
import {
  buildComposition,
  COMPOSITION_A,
  COMPOSITION_B,
} from './support/catalog-fixtures.js';
import { expectedCompositionDigest } from './support/composition.js';
import { createInjectedEnospcSink, isEnospc } from './support/disk-fault.js';
import { sha256Hex } from './support/hash.js';
import { startLocalEndpoint } from './support/local-endpoint.js';
import { createTar, createTarGz, parseTar } from './support/tar.js';
import {
  captureHostDefaults,
  createTempRoot,
  diffHostDefaults,
  diffSnapshots,
  snapshotTree,
  withIsolatedEnv,
} from './support/temp-env.js';
import { mountTinyVolume, writeUntilEnospc } from './support/tiny-volume.js';

const tarBinaryAvailable = (): boolean =>
  spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0;

describe('fixture harness', () => {
  it('computes the documented SHA-256 test vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('writes a real gzip tar that an independent parser and system tar can read', () => {
    const entries = [
      { path: 'bin/node', data: Buffer.from('binary\n') },
      { path: 'hdsl-qa/marker.txt', data: Buffer.from('scope=test\n') },
    ];
    const archive = createTar(entries);
    const parsed = parseTar(archive);
    expect(parsed.map((entry) => entry.path)).toEqual(['bin/node', 'hdsl-qa/marker.txt']);
    expect(parsed[0]?.data.toString()).toBe('binary\n');

    const gzipped = createTarGz(entries);
    expect(parseTar(gunzipSync(gzipped)).length).toBe(2);

    if (tarBinaryAvailable()) {
      const temp = createTempRoot('tar-check');
      try {
        const file = join(temp.path, 'artifact.tgz');
        writeFileSync(file, gzipped);
        const listed = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
        expect(listed.status).toBe(0);
        expect(listed.stdout).toContain('bin/node');
        expect(listed.stdout).toContain('hdsl-qa/marker.txt');
      } finally {
        temp.cleanup();
      }
    }
  });

  it('serves exact artifact bytes and detects a truncated download', async () => {
    const artifact = buildArtifact({
      kind: 'dsh',
      version: '0.1.5-rc.2',
      platform: 'darwin',
      arch: 'arm64',
      scope: 'env-a',
    });
    const endpoint = await startLocalEndpoint([
      { path: '/full.tgz', body: artifact.bytes, mode: 'full' },
      { path: '/cut.tgz', body: artifact.bytes, mode: 'truncate' },
      { path: '/reset.tgz', body: artifact.bytes, mode: 'reset' },
    ]);
    try {
      const full = await fetch(endpoint.url('/full.tgz'));
      const bytes = Buffer.from(await full.arrayBuffer());
      expect(sha256Hex(bytes)).toBe(artifact.sha256);

      const truncated = fetch(endpoint.url('/cut.tgz'));
      await expect(truncated.then((response) => response.arrayBuffer())).rejects.toThrow();

      const reset = fetch(endpoint.url('/reset.tgz'));
      await expect(reset.then((response) => response.arrayBuffer())).rejects.toThrow();

      expect(endpoint.requests.map((entry) => entry.path)).toEqual([
        '/full.tgz',
        '/cut.tgz',
        '/reset.tgz',
      ]);
      const fullLog = endpoint.requests.find((entry) => entry.path === '/full.tgz');
      expect(fullLog?.completed).toBe(true);
    } finally {
      await endpoint.close();
    }
  });

  it('creates temp roots under the OS temp dir and detects tree changes', () => {
    const temp = createTempRoot('tree-check');
    try {
      expect(temp.path.startsWith(tmpdir())).toBe(true);
      writeFileSync(join(temp.path, 'a.txt'), 'one');
      const before = snapshotTree(temp.path);
      writeFileSync(join(temp.path, 'a.txt'), 'two');
      writeFileSync(join(temp.path, 'b.txt'), 'new');
      const after = snapshotTree(temp.path);
      const diff = diffSnapshots(before, after);
      expect(diff.equal).toBe(false);
      expect(diff.added.map((entry) => entry.relPath)).toEqual(['b.txt']);
      expect(diff.changed.map((entry) => entry.relPath)).toEqual(['a.txt']);
    } finally {
      temp.cleanup();
    }
  });

  it('redirects HOME/DSH_HOME for a scenario and restores them afterwards', async () => {
    const temp = createTempRoot('env-check');
    const beforeHome = process.env['HOME'];
    const beforeDsh = process.env['DSH_HOME'];
    try {
      await withIsolatedEnv(temp.path, async () => {
        expect(process.env['HOME']).toBe(join(temp.path, 'home'));
        expect(process.env['DSH_HOME']).toBe(join(temp.path, 'dsh-home'));
      });
      expect(process.env['HOME']).toBe(beforeHome);
      expect(process.env['DSH_HOME']).toBe(beforeDsh);
    } finally {
      temp.cleanup();
    }
  });

  it('reports no host-default change when nothing is written', () => {
    const before = captureHostDefaults();
    const after = captureHostDefaults();
    expect(diffHostDefaults(before, after).equal).toBe(true);
  });

  it('produces a real ENOSPC on a mounted tiny volume (macOS) or an injected ENOSPC elsewhere', () => {
    const temp = createTempRoot('disk-check');
    try {
      const volume = mountTinyVolume(temp.path, 2);
      if (volume !== undefined) {
        try {
          const error = writeUntilEnospc(volume.mountPath);
          expect(isEnospc(error)).toBe(true);
        } finally {
          volume.detach();
        }
      } else {
        const sink = createInjectedEnospcSink(4);
        sink.write(Buffer.alloc(4));
        expect(() => sink.write(Buffer.alloc(1))).toThrow();
        try {
          sink.write(Buffer.alloc(1));
        } catch (error) {
          expect(isEnospc(error)).toBe(true);
        }
      }
    } finally {
      temp.cleanup();
    }
  }, 30_000);

  it('derives distinct composition digests and keeps URLs out of the digest', () => {
    const a = buildComposition(COMPOSITION_A);
    const b = buildComposition(COMPOSITION_B);
    const combinationA = a.combinationFor('http://127.0.0.1:1111');
    const combinationB = b.combinationFor('http://127.0.0.1:2222');
    expect(combinationA.artifactLocations.node.url).toContain('127.0.0.1:1111');
    expect(expectedCompositionDigest(combinationA)).not.toBe(
      expectedCompositionDigest(combinationB),
    );
    // Same composition input, different origin => same digest (issue #15 N3).
    const rewired = a.combinationFor('http://127.0.0.1:9999');
    expect(expectedCompositionDigest(rewired)).toBe(expectedCompositionDigest(combinationA));
  });

  it('builds a hostile path-traversal artifact and reads marker files', () => {
    const hostile = buildPathTraversalArtifact({
      kind: 'dsh',
      version: '0.0.0-hostile',
      platform: 'darwin',
      arch: 'arm64',
      scope: 'env-hostile',
    });
    const parsed = parseTar(gunzipSync(hostile.bytes));
    expect(parsed.some((entry) => entry.path.includes('..'))).toBe(true);

    const temp = createTempRoot('marker-check');
    try {
      const fakeInstall = join(temp.path, 'install', 'nested');
      mkdirSync(fakeInstall, { recursive: true });
      writeFileSync(join(fakeInstall, 'marker.txt'), `scope=env-a\n`);
      const markers = readMarkers(join(temp.path, 'install'));
      expect(markers).toHaveLength(1);
      expect(markers[0]?.content).toContain('scope=env-a');
      expect(MARKER_PATH).toBe('hdsl-qa/marker.txt');
    } finally {
      temp.cleanup();
    }
  });
});
