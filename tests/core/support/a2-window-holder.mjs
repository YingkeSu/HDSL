// A2 production-window child: runs a real (synthetic-artifact) creation
// transaction with profileInit enabled through a controlled executor, reaches a
// named production phase, prints `REACHED <phase>` and blocks until the parent
// sends a real SIGKILL. The parent then opens a fresh instance and reconciles.
//
// Phases:
//   before-pointer : paused before the profile publish (no published profile)
//   after-publish  : paused after publish, before the pointer switch (orphan)
//   after-pointer  : paused after the pointer switch, before the journal commit
//
// Synthetic fixtures + controlled executor, so this is a lifecycle/process
// harness, not real-install evidence.
import { register } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./a2-window-hook.mjs', import.meta.url);

const { createManagedInstall, JournalStore, environmentPaths, managedProfileName, resolveLayout } = await import(
  '@hdsl/core'
);
const { createRuntimePort } = await import('@hdsl/runtime');
const { syntheticCombination, syntheticNodeTarball, syntheticDshTarball, writeLocalArtifact, sha256 } =
  await import('../../install/synthetic.ts');

const dataRoot = process.argv[2];
const phase = process.argv[3];
const PHASES = ['before-pointer', 'after-publish', 'after-pointer'];
if (dataRoot === undefined || !PHASES.includes(phase)) {
  process.stderr.write(`usage: node a2-window-holder.mjs <dataRoot> <${PHASES.join('|')}>\n`);
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

// Controlled executor: stages a profile declaration source in the isolated
// staging home, exactly where the real DSH initializer would.
const executeCommand = async (executable, args, options) => {
  const name = args[args.indexOf('--profile') + 1];
  const home = options.env.DSH_HOME;
  const directory = join(home, 'profiles', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-fixture', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
  );
  writeFileSync(join(directory, 'cordis.patch.yml'), '# fixture patch\n');
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
};

const runtime = createRuntimePort({
  closureInstall: false,
  precheck: 'none',
  profileInit: true,
  executeCommand,
  localArtifactDirectory: artifacts,
});
const faults =
  phase === 'before-pointer'
    ? { pauseBeforeCommit: true }
    : phase === 'after-publish'
      ? { pauseAfterPublishBeforePointer: true }
      : { pauseAfterPointerSwitch: true };

const managed = await createManagedInstall({
  dataRoot,
  catalog: [combination],
  runtime,
  fixtures: { allowArtifactsOnly: true },
  lockStaleAfterMs: 150,
  lockHeartbeatIntervalMs: 50,
  lockWaitTimeoutMs: 5_000,
  faults,
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
  const listed = managed.service.listEnvironments();
  const environment = listed.ok ? listed.value[0] : undefined;
  const active = environment?.activeGenerationId ?? null;
  const journal = journals.list()[0];
  const journalPhase = journal?.phase;
  const generationId = journal?.generationId;
  const published =
    environment !== undefined && generationId !== undefined
      ? environmentPaths(layout, environment.id).profilesDirectory
      : undefined;
  const publishedExists =
    published !== undefined && generationId !== undefined
      ? existsSync(join(published, managedProfileName(generationId)))
      : false;

  const reached =
    phase === 'before-pointer'
      ? journalPhase === 'artifacts-installed' && active === null && !publishedExists
      : phase === 'after-publish'
        ? active === null && publishedExists
        : active !== null;

  if (reached) {
    writeFileSync(
      join(dataRoot, 'window-reached.json'),
      JSON.stringify({
        phase,
        environmentId: environment?.id ?? null,
        activeGenerationId: active,
        journalGenerationId: generationId ?? null,
        profileName: generationId === undefined ? null : managedProfileName(generationId),
      }),
    );
    process.stdout.write(`REACHED ${phase}\n`);
    break;
  }
  if (Date.now() > deadline) {
    process.stderr.write(`phase ${phase} was not reached\n`);
    process.exit(4);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

setInterval(() => {}, 1_000);
