/**
 * A2 production windows with a REAL subprocess SIGKILL and recover():
 *  - before-pointer: crash before the active-generation pointer switch → roll back
 *  - after-pointer:  crash after the pointer switch, before the journal commit →
 *    roll forward (pointer is authoritative; the generation is never deleted)
 *
 * The child drives the real core creation transaction; install artifacts are
 * synthetic fixtures, so this is a lifecycle/process harness, not real-install
 * evidence. Same-environment multi-generation/restore remains gated by the
 * unimplemented `changes.apply` and is NOT claimed here.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createManagedInstall, generationPaths, resolveLayout } from '@hdsl/core';
import { createRuntimePort } from '@hdsl/runtime';
import {
  sha256,
  syntheticCombination,
  syntheticDshTarball,
  syntheticNodeTarball,
  writeLocalArtifact,
} from '../install/synthetic.js';

const HOLDER = fileURLToPath(new URL('./support/a2-window-holder.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const nodeTarball = syntheticNodeTarball('22.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});

const buildRuntime = (artifacts: string) =>
  createRuntimePort({ closureInstall: false, precheck: 'none', localArtifactDirectory: artifacts });

const runWindow = async (
  phase: 'before-pointer' | 'after-pointer',
): Promise<{ dataRoot: string; artifacts: string; generationId: string | null }> => {
  const dataRoot = mkdtempSync(join(tmpdir(), `hdsl-a2-${phase}-`));
  roots.push(dataRoot);
  const artifacts = mkdtempSync(join(tmpdir(), 'hdsl-a2-window-artifacts-'));
  roots.push(artifacts);
  writeLocalArtifact(artifacts, sha256(nodeTarball), nodeTarball);
  writeLocalArtifact(artifacts, sha256(dshTarball), dshTarball);

  const child = spawn(process.execPath, [HOLDER, dataRoot, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    const timer = setInterval(() => {
      if (stdout.includes(`REACHED ${phase}`)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`child never reached ${phase}: ${stdout}`));
      }
    }, 20);
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  child.kill('SIGKILL');
  const outcome = await exit;
  expect(outcome.signal).toBe('SIGKILL');

  const reached = JSON.parse(readFileSync(join(dataRoot, 'window-reached.json'), 'utf8')) as {
    activeGenerationId: string | null;
  };
  return { dataRoot, artifacts, generationId: reached.activeGenerationId };
};

const reconcile = async (dataRoot: string, artifacts: string) => {
  const managed = await createManagedInstall({
    dataRoot,
    catalog: [combination],
    runtime: buildRuntime(artifacts),
    fixtures: { allowArtifactsOnly: true },
    lockStaleAfterMs: 150,
    lockHeartbeatIntervalMs: 50,
    lockWaitTimeoutMs: 5_000,
  });
  const report = await managed.recover();
  return { managed, report };
};

describe('A2 production windows (real SIGKILL + recover)', () => {
  it('rolls back when killed before the pointer switch (old generation untouched)', async () => {
    const { dataRoot, artifacts, generationId } = await runWindow('before-pointer');
    expect(generationId).toBeNull();

    const { managed, report } = await reconcile(dataRoot, artifacts);
    expect(report.rolledBack).toBeGreaterThanOrEqual(1);
    const listed = managed.service.listEnvironments();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value[0]?.activeGenerationId).toBeNull();
      expect(listed.value[0]?.state).toBe('error');
    }
    await managed.close();
  });

  it('rolls forward when killed after the pointer switch, before the journal commit', async () => {
    const { dataRoot, artifacts, generationId } = await runWindow('after-pointer');
    expect(generationId).not.toBeNull();
    if (generationId === null) {
      return;
    }

    const { managed, report } = await reconcile(dataRoot, artifacts);
    expect(report.finalized).toBeGreaterThanOrEqual(1);
    const listed = managed.service.listEnvironments();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const environment = listed.value[0];
      expect(environment?.activeGenerationId).toBe(generationId);
      expect(environment?.state).toBe('stopped');
      // The committed generation directory is retained (never deleted on roll-forward).
      const layout = resolveLayout(dataRoot);
      expect(
        existsSync(generationPaths(layout, environment?.id ?? '', generationId).generationDirectory),
      ).toBe(true);
    }
    await managed.close();
  });
});
