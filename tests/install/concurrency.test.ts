/**
 * Cache concurrency + corruption regression tests (review P1 / issue #37).
 *
 * The install pipeline shares one content-addressed artifact cache across
 * concurrent creations, so these tests prove the publish invariants directly:
 * unique per-attempt staging, verify-then-atomic-publish, reuse of a valid
 * existing entry, atomic replacement of a corrupt one, and failure isolation
 * (a failed attempt only removes its own staging).
 *
 * Synthetic offline artifacts are used; the SHA-256 of the cache entries is
 * still verified, so this is a real cache-boundary test.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimePort, type InstallContext, type ManagedRuntimePort } from '@hdsl/runtime';
import { sha256, syntheticCombination, syntheticDshTarball, syntheticNodeTarball, writeLocalArtifact } from './synthetic.js';

const roots: string[] = [];

const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-cache-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const listFiles = (root: string): string[] => {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
};

const contextFor = (root: string): InstallContext => ({
  signal: new AbortController().signal,
  cacheDirectory: join(root, 'artifacts'),
  scratchDirectory: join(root, 'tmp'),
  npmCacheDirectory: join(root, 'npm-cache'),
});

const setupRuntime = (
  options: { readonly corruptDownload?: boolean; readonly localArtifacts: string },
): ManagedRuntimePort =>
  createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    localArtifactDirectory: options.localArtifacts,
    ...(options.corruptDownload === true ? { faults: { corruptDownload: true } } : {}),
  });

const installLock = async (
  runtime: ManagedRuntimePort,
  combination: ReturnType<typeof syntheticCombination>,
  destination: string,
  root: string,
): Promise<{ ok: boolean; code?: string }> => {
  const resolved = runtime.resolveComposition(combination);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code };
  }
  const outcome = await runtime.install(resolved.value, destination, contextFor(root));
  return outcome.ok ? { ok: true } : { ok: false, code: outcome.code };
};

describe('artifact cache concurrency', () => {
  const nodeTarball = syntheticNodeTarball('24.0.0');
  const dshTarball = syntheticDshTarball('0.1.5-rc.2');
  const combination = syntheticCombination({
    nodeVersion: '24.0.0',
    nodeTarball,
    dshVersion: '0.1.5-rc.2',
    dshTarball,
  });

  it('publishes exactly one valid entry when eight installs race', async () => {
    const root = freshRoot();
    const localArtifacts = freshRoot();
    writeLocalArtifact(localArtifacts, sha256(nodeTarball), nodeTarball);
    writeLocalArtifact(localArtifacts, sha256(dshTarball), dshTarball);
    const runtime = setupRuntime({ localArtifacts });

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        installLock(runtime, combination, join(root, `generation-${String(index)}`), root),
      ),
    );
    expect(attempts.every((attempt) => attempt.ok)).toBe(true);

    const cacheFiles = listFiles(join(root, 'artifacts'));
    expect(cacheFiles).toHaveLength(2);
    const digests = cacheFiles.map((file) =>
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    );
    expect(new Set(digests)).toEqual(new Set([sha256(nodeTarball), sha256(dshTarball)]));
    // No staging leftovers from any attempt.
    expect(listFiles(join(root, 'tmp'))).toHaveLength(0);
  });

  it('replaces a corrupt existing cache entry atomically instead of reusing it', async () => {
    const root = freshRoot();
    const localArtifacts = freshRoot();
    writeLocalArtifact(localArtifacts, sha256(nodeTarball), nodeTarball);
    writeLocalArtifact(localArtifacts, sha256(dshTarball), dshTarball);
    const runtime = setupRuntime({ localArtifacts });

    expect((await installLock(runtime, combination, join(root, 'first'), root)).ok).toBe(true);
    const corruptTarget = join(root, 'artifacts', 'sha256', sha256(nodeTarball), `node-${sha256(nodeTarball)}.tgz`);
    expect(existsSync(corruptTarget)).toBe(true);
    writeFileSync(corruptTarget, 'corrupted');

    const second = await installLock(runtime, combination, join(root, 'second'), root);
    expect(second.ok).toBe(true);
    const repaired = createHash('sha256').update(readFileSync(corruptTarget)).digest('hex');
    expect(repaired).toBe(sha256(nodeTarball));
  });

  it('never lets a failed attempt delete a published or another attempt entry', async () => {
    const root = freshRoot();
    const localArtifacts = freshRoot();
    const otherNode = syntheticNodeTarball('22.0.0');
    const otherDsh = syntheticDshTarball('0.2.0-rc.1');
    for (const tarball of [nodeTarball, dshTarball, otherNode, otherDsh]) {
      writeLocalArtifact(localArtifacts, sha256(tarball), tarball);
    }
    const otherCombination = syntheticCombination({
      nodeVersion: '22.0.0',
      nodeTarball: otherNode,
      dshVersion: '0.2.0-rc.1',
      dshTarball: otherDsh,
    });

    const good = setupRuntime({ localArtifacts });
    expect((await installLock(good, combination, join(root, 'good'), root)).ok).toBe(true);
    const published = listFiles(join(root, 'artifacts')).map((file) =>
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    );
    expect(published).toHaveLength(2);

    const failing = setupRuntime({ localArtifacts, corruptDownload: true });
    const failed = await installLock(failing, otherCombination, join(root, 'bad'), root);
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe('DIGEST_MISMATCH');

    // The earlier published entries survive and no staging file remains.
    const after = listFiles(join(root, 'artifacts')).map((file) =>
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    );
    expect(after).toEqual(expect.arrayContaining(published));
    expect(listFiles(join(root, 'tmp'))).toHaveLength(0);
  });
});
