// A2 production-window child: runs a real (synthetic-artifact) creation
// transaction with a controlled fault, reaches a named production phase, prints
// `REACHED <phase>` and blocks until the parent sends a real SIGKILL. The parent
// then opens a fresh instance and reconciles.
//
// Phases: `before-pointer` (pause before the commit pointer switch) and
// `after-pointer` (pause after the pointer switch, before the journal commit).
//
// This is a lifecycle/process harness; the install artifacts are synthetic
// fixtures, so it is not real-install evidence.
import { register } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./a2-window-hook.mjs', import.meta.url);

const { createManagedInstall, JournalStore, resolveLayout } = await import('@hdsl/core');
const { createRuntimePort } = await import('@hdsl/runtime');
const { syntheticCombination, syntheticNodeTarball, syntheticDshTarball, writeLocalArtifact, sha256 } =
  await import('../../install/synthetic.ts');

const dataRoot = process.argv[2];
const phase = process.argv[3];
if (dataRoot === undefined || (phase !== 'before-pointer' && phase !== 'after-pointer')) {
  process.stderr.write('usage: node a2-window-holder.mjs <dataRoot> <before-pointer|after-pointer>\n');
  process.exit(2);
}

const nodeTarball = syntheticNodeTarball('22.0.0');
const dshTarball = syntheticDshTarball('0.1.5-rc.2');
const combination = syntheticCombination({
  nodeVersion: '22.0.0',
  nodeTarball,
  dshVersion: '0.1.5-rc.2',
  dshTarball,
});
const artifacts = mkdtempSync(join(tmpdir(), 'hdsl-a2-window-artifacts-'));
writeLocalArtifact(artifacts, sha256(nodeTarball), nodeTarball);
writeLocalArtifact(artifacts, sha256(dshTarball), dshTarball);

const runtime = createRuntimePort({
  closureInstall: false,
  precheck: 'none',
  localArtifactDirectory: artifacts,
});
const managed = await createManagedInstall({
  dataRoot,
  catalog: [combination],
  runtime,
  fixtures: { allowArtifactsOnly: true },
  lockStaleAfterMs: 150,
  lockHeartbeatIntervalMs: 50,
  lockWaitTimeoutMs: 5_000,
  faults: phase === 'before-pointer' ? { pauseBeforeCommit: true } : { pauseAfterPointerSwitch: true },
});

const created = managed.service.createEnvironment({
  requestId: `req-window-${phase}`,
  name: `window-${phase}`,
  combination,
});
if (!created.ok) {
  process.stderr.write(`create rejected: ${created.code}\n`);
  process.exit(3);
}

const layout = resolveLayout(dataRoot);
const journals = new JournalStore(layout);
const deadline = Date.now() + 15_000;
for (;;) {
  const environment = managed.service.listEnvironments();
  const active = environment.ok ? environment.value[0]?.activeGenerationId : undefined;
  const journalPhase = journals.list()[0]?.phase;
  const reached =
    phase === 'before-pointer'
      ? journalPhase === 'artifacts-installed' && active === null
      : active !== undefined && active !== null;
  if (reached) {
    writeFileSync(join(dataRoot, 'window-reached.json'), JSON.stringify({ phase, activeGenerationId: active ?? null }));
    process.stdout.write(`REACHED ${phase}\n`);
    break;
  }
  if (Date.now() > deadline) {
    process.stderr.write(`phase ${phase} was not reached\n`);
    process.exit(4);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// Block until the parent sends a real SIGKILL.
setInterval(() => {}, 1_000);
