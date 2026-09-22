/**
 * APPLY transaction windows with a REAL subprocess SIGKILL and recover().
 * Separate from the creation windows (a2-window-kill.test.ts).
 *  - pre-pointer (pauseAt 'verified'): roll back, old generation active, plan not consumed
 *  - post-pointer (pauseAt 'committed'): roll forward, new generation active, plan consumed once
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeApplyService, ChangePlanStore, EnvironmentStore, OperationStore, resolveLayout, type ChangeFaults, type PluginApplyPort } from '@hdsl/core';
import { createGenerationRuntimeVerifier } from '@hdsl/runtime';

const HOLDER = fileURLToPath(new URL('./support/apply-window-holder.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENV = 'env-0000000000000001';
const GEN1 = 'gen-0000000000000001';

const fakePort: PluginApplyPort = {
  stage: async () => ({ ok: false, code: 'INTERNAL_ERROR', message: 'recovery does not stage' }),
};

const runWindow = async (phase: 'verified' | 'committed') => {
  const dataRoot = mkdtempSync(join(tmpdir(), `hdsl-apply-window-${phase}-`));
  roots.push(dataRoot);
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
  const exit = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (_code, signal) => resolve({ signal }));
  });
  child.kill('SIGKILL');
  expect((await exit).signal).toBe('SIGKILL');
  return dataRoot;
};

const recover = async (dataRoot: string) => {
  const layout = resolveLayout(dataRoot);
  const service = new ChangeApplyService({
    layout,
    plans: new ChangePlanStore(layout),
    environments: new EnvironmentStore(layout),
    operations: new OperationStore(layout),
    compositionDigest: (l) => JSON.stringify(l.plugins),
    port: fakePort,
    verifyGenerationRuntime: createGenerationRuntimeVerifier(),
    faults: {} as ChangeFaults,
  });
  return { service, layout, environments: new EnvironmentStore(layout), plans: new ChangePlanStore(layout) };
};

describe('apply transaction windows (real SIGKILL + recover)', () => {
  it('pre-pointer kill rolls back: old generation active, plan not consumed', async () => {
    const dataRoot = await runWindow('verified');
    const { service, environments, plans, layout } = await recover(dataRoot);
    const report = service.recover();
    expect(report.rolledBack).toBeGreaterThanOrEqual(1);
    expect(environments.read(ENV)?.activeGenerationId).toBe(GEN1);
    expect(plans.read('plan-0000000000000001')?.consumedBy).toBeNull();
    // The interrupted transaction journal is reconciled (removed) on recovery.
    expect(existsSync(layout.applyJournals)).toBe(true);
    expect(readdirSync(layout.applyJournals)).toHaveLength(0);
  }, 30_000);

  it('post-pointer kill rolls forward: new generation active, plan consumed once', async () => {
    const dataRoot = await runWindow('committed');
    const reached = JSON.parse(readFileSync(join(dataRoot, 'apply-reached.json'), 'utf8')) as { activeGenerationId: string };
    const { service, environments, plans } = await recover(dataRoot);
    const report = service.recover();
    expect(report.finalized).toBeGreaterThanOrEqual(1);
    expect(environments.read(ENV)?.activeGenerationId).toBe(reached.activeGenerationId);
    expect(plans.read('plan-0000000000000001')?.consumedBy).toBe('req-apply-window');
  }, 30_000);
});
