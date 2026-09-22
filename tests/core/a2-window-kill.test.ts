/**
 * A2 production windows with a REAL subprocess SIGKILL and recover(), with
 * profileInit enabled through a controlled executor:
 *  - before-pointer: killed before publish → roll back, no published profile
 *  - after-publish:  killed after publish, before the pointer switch → roll back;
 *    the published profile is an uncommitted orphan that is RETAINED and carries
 *    provenance (generation/profile/digest/transaction) for future attribution
 *  - after-pointer:  killed after the pointer switch, before the journal commit →
 *    roll forward; the published profile belongs to the committed ACTIVE
 *    generation and must match the generation record name+digest
 *
 * The child drives the real core creation transaction and is killed with a real
 * SIGKILL; install artifacts are synthetic fixtures and profile init uses a
 * controlled executor, so this is a lifecycle/process harness, not real-install
 * evidence. A fresh environment is created only as an "other environments are
 * unaffected" control, never as same-environment retry/dual-generation evidence
 * (that remains gated by the unimplemented `changes.apply`).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createManagedInstall,
  environmentPaths,
  generationPaths,
  managedProfileName,
  readProfileProvenance,
  resolveLayout,
} from '@hdsl/core';
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

const stagingExecutor = async (
  _executable: string,
  args: readonly string[],
  options: { env: Record<string, string> },
) => {
  const name = args[args.indexOf('--profile') + 1] as string;
  const directory = join(options.env['DSH_HOME'] as string, 'profiles', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-fixture', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
  );
  writeFileSync(join(directory, 'cordis.patch.yml'), '# fixture patch\n');
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
};

const buildRuntime = (artifacts: string) =>
  createRuntimePort({
    closureInstall: false,
    precheck: 'none',
    profileInit: true,
    executeCommand: stagingExecutor as never,
    localArtifactDirectory: artifacts,
  });

interface Reached {
  readonly environmentId: string | null;
  readonly activeGenerationId: string | null;
  readonly journalGenerationId: string | null;
  readonly profileName: string | null;
}

const runWindow = async (
  phase: 'before-pointer' | 'after-publish' | 'after-pointer',
): Promise<{ dataRoot: string; artifacts: string; reached: Reached }> => {
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

  const reached = JSON.parse(readFileSync(join(dataRoot, 'window-reached.json'), 'utf8')) as Reached;
  return { dataRoot, artifacts, reached };
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

describe('A2 production windows (real SIGKILL + recover, profileInit)', () => {
  it('before-pointer: rolls back with no published profile', async () => {
    const { dataRoot, artifacts, reached } = await runWindow('before-pointer');
    expect(reached.activeGenerationId).toBeNull();
    expect(reached.journalGenerationId).not.toBeNull();

    const { managed, report } = await reconcile(dataRoot, artifacts);
    expect(report.rolledBack).toBeGreaterThanOrEqual(1);
    const listed = managed.service.listEnvironments();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value[0]?.activeGenerationId).toBeNull();
      expect(listed.value[0]?.state).toBe('error');
      const layout = resolveLayout(dataRoot);
      const profileName = managedProfileName(reached.journalGenerationId ?? '');
      expect(
        existsSync(join(environmentPaths(layout, listed.value[0]?.id ?? '').profilesDirectory, profileName)),
      ).toBe(false);
    }
    await managed.close();
  });

  it('after-publish: rolls back, retains the uncommitted orphan with provenance, new env unaffected', async () => {
    const { dataRoot, artifacts, reached } = await runWindow('after-publish');
    expect(reached.activeGenerationId).toBeNull();
    expect(reached.journalGenerationId).not.toBeNull();

    const { managed, report } = await reconcile(dataRoot, artifacts);
    expect(report.rolledBack).toBeGreaterThanOrEqual(1);
    const listed = managed.service.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      await managed.close();
      return;
    }
    const environment = listed.value[0];
    expect(environment?.activeGenerationId).toBeNull();
    expect(environment?.state).toBe('error');

    // The uncommitted orphan profile is retained and attributed.
    const layout = resolveLayout(dataRoot);
    const profileName = managedProfileName(reached.journalGenerationId ?? '');
    const published = join(environmentPaths(layout, environment?.id ?? '').profilesDirectory, profileName);
    expect(existsSync(published)).toBe(true);
    const provenance = readProfileProvenance(published);
    expect(provenance?.generationId).toBe(reached.journalGenerationId);
    expect(provenance?.profileName).toBe(profileName);
    expect(typeof provenance?.transactionId).toBe('string');
    expect((provenance?.digest ?? '').length).toBe(64);

    // Control only: another environment is unaffected by the orphan.
    const second = managed.service.createEnvironment({
      requestId: 'req-window-control',
      name: 'window-control',
      combination,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      const snapshot = await managed.waitForOperation(second.value.operationId, { timeoutMs: 20_000 });
      expect(snapshot.status).toBe('succeeded');
    }
    await managed.close();
  });

  it('after-pointer: rolls forward; published profile matches the active generation record', async () => {
    const { dataRoot, artifacts, reached } = await runWindow('after-pointer');
    expect(reached.activeGenerationId).not.toBeNull();
    if (reached.activeGenerationId === null) {
      return;
    }

    const { managed, report } = await reconcile(dataRoot, artifacts);
    expect(report.finalized).toBeGreaterThanOrEqual(1);
    const listed = managed.service.listEnvironments();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      await managed.close();
      return;
    }
    const environment = listed.value[0];
    expect(environment?.activeGenerationId).toBe(reached.activeGenerationId);
    expect(environment?.state).toBe('stopped');

    const layout = resolveLayout(dataRoot);
    const paths = generationPaths(layout, environment?.id ?? '', reached.activeGenerationId);
    expect(existsSync(paths.generationDirectory)).toBe(true);
    const record = JSON.parse(readFileSync(paths.generationRecordPath, 'utf8')) as {
      profileName?: string;
      profileDigest?: string;
    };
    const profileName = managedProfileName(reached.activeGenerationId);
    expect(record.profileName).toBe(profileName);
    const published = join(environmentPaths(layout, environment?.id ?? '').profilesDirectory, profileName);
    expect(existsSync(published)).toBe(true);
    const provenance = readProfileProvenance(published);
    expect(provenance?.generationId).toBe(reached.activeGenerationId);
    expect(provenance?.profileName).toBe(profileName);
    expect(provenance?.digest).toBe(record.profileDigest);
    await managed.close();
  });
});
