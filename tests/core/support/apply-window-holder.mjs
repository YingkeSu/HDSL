// Real-subprocess holder for the APPLY transaction windows (distinct from the
// creation holder). Builds a fixture environment + plan, runs ChangeApplyService
// with a paused phase, prints REACHED and blocks until SIGKILL.
import { register } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

register('./a2-window-hook.mjs', import.meta.url);
const core = await import('@hdsl/core');
const runtime = await import('@hdsl/runtime');
const {
  ChangeApplyService, ChangePlanStore, EnvironmentStore, OperationStore,
  ensureLayout, generationPaths, resolveLayout,
} = core;
const { createGenerationRuntimeVerifier, sha256TreeDigestSync } = runtime;

const dataRoot = process.argv[2];
const phase = process.argv[3]; // 'verified' (pre-pointer) | 'committed' (post-pointer)
const layout = resolveLayout(dataRoot);
ensureLayout(layout);
const environments = new EnvironmentStore(layout);
const ENV = 'env-0000000000000001';
const GEN1 = 'gen-0000000000000001';
const now = '2026-09-22T00:05:00.000Z';
environments.write({ schemaVersion: '1', id: ENV, name: 'apply-window', revision: 1, stateVersion: 1, state: 'stopped', activeGenerationId: GEN1, compositionDigest: '0'.repeat(64), createdAt: now, updatedAt: now });
const p1 = generationPaths(layout, ENV, GEN1);
mkdirSync(join(p1.nodeDirectory, 'bin'), { recursive: true });
mkdirSync(join(p1.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
writeFileSync(join(p1.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
writeFileSync(join(p1.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'), '// dsh\n');
writeFileSync(p1.manifestPath, JSON.stringify({ schemaVersion: '1', installMode: 'npm-ci', node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(p1.nodeDirectory) }, dsh: { version: '0.1.5-rc.2', treeDigest: sha256TreeDigestSync(join(p1.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')) } }));
writeFileSync(p1.lockPath, JSON.stringify({ schemaVersion: '1', node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) }, dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) }, plugins: [], sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } } }));

const plans = new ChangePlanStore(layout);
plans.write({ schemaVersion: '1', plan: {
  planId: 'plan-0000000000000001', environmentId: ENV, baseRevision: 1,
  action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
  createdAt: now, expiresAt: '2026-09-22T00:15:00.000Z', sourceLock: null,
  scriptAssessment: 'none-detected', scripts: [], requiresBuildAuthorization: false,
  riskItems: [], removals: [], retention: [], blockingReferences: [], executor: null,
  planInputsDigest: 'd'.repeat(64),
}, consumedBy: null });

const port = {
  stage: async (command) => {
    const profile = join(command.generationDirectory, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['b'] } } }));
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
    return { ok: true, value: { compositionLock: { schemaVersion: '1', node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) }, dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) }, plugins: [], sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } } }, sourceLock: null, stagedProfileDirectory: profile } };
  },
};
const service = new ChangeApplyService({ layout, plans, environments, operations: new OperationStore(layout), compositionDigest: (l) => JSON.stringify(l.plugins), port, verifyGenerationRuntime: createGenerationRuntimeVerifier(), faults: { pauseAt: phase }, now: () => new Date('2026-09-22T00:05:00.000Z') });
const started = service.applyChange({ requestId: 'req-apply-window', environmentId: ENV, expectedRevision: 1, planId: 'plan-0000000000000001', buildAuthorization: null });
if (!started.ok) { process.stderr.write(`apply rejected ${started.code}\n`); process.exit(3); }
const journalPhase = () => {
  for (const name of readdirSync(layout.applyJournals)) {
    if (!name.endsWith('.json')) continue;
    try {
      return JSON.parse(readFileSync(join(layout.applyJournals, name), 'utf8')).phase;
    } catch {
      return undefined;
    }
  }
  return undefined;
};
const deadline = Date.now() + 15_000;
for (;;) {
  const env = environments.read(ENV);
  const currentPhase = journalPhase();
  // The child pauses INSIDE the phase, so the journal records that phase before
  // the marker is written (avoids racing on a pointer that is already GEN1).
  const reached = currentPhase === phase;
  if (reached) { writeFileSync(join(dataRoot, 'apply-reached.json'), JSON.stringify({ phase, activeGenerationId: env.activeGenerationId })); process.stdout.write(`REACHED ${phase}\n`); break; }
  if (Date.now() > deadline) { process.stderr.write(`phase ${phase} not reached (journal=${String(currentPhase)})\n`); process.exit(4); }
  await new Promise((r) => setTimeout(r, 20));
}
setInterval(() => {}, 1000);
