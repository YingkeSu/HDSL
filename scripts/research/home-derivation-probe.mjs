/**
 * Reproducible home-derivation / rollback probe for ADR 0005 D18 + E10 (issue #76 gate).
 *
 * It runs the *real* creation-transaction / recovery code (`@hdsl/core` dist)
 * against a temporary data root, a fake `ManagedRuntimePort` and no network, and
 * observes three things about the CURRENT creation transaction:
 *
 *   A. The rollback/removal scope is the staged generation directory itself:
 *      a file written under the staged generation home is gone after a
 *      pre-commit rollback (A1/A2).
 *   B. An environment-level home written by the harness is not touched by the
 *      creation transaction (A3/A4/B1) — a structural observation about the
 *      current code's delete scope, NOT a product guarantee (current code does
 *      not know that path).
 *   C. The commit point is the active-generation pointer (A0/B0).
 *
 * What this probe does NOT test: the "copy the previous home into the new
 * generation" mechanism (there is no committed previous generation here), a
 * two-generation change/restore transaction, or whether an old generation
 * actually loads its own composition. Those are S2 gates.
 *
 * The probe never touches the host `$HOME`/`~/.dsh`, uses no credentials and
 * runs no third-party code. `install-manifest.json` written by the fake runtime
 * is an explicit fixture; this is layout/transaction evidence, not real-install
 * evidence.
 *
 * Usage:
 *   pnpm run build            # the probe imports the built packages
 *   node scripts/research/home-derivation-probe.mjs [--keep]
 *
 * Exit code 0 = all observations as expected; 1 = expectation failed.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { createManagedInstall, generationPaths, generationsDirectory, resolveLayout } = await import(
  new URL('packages/core/dist/index.js', `file://${root}`)
);
const { computeCompositionDigest, resolveComposition } = await import(
  new URL('packages/runtime/dist/index.js', `file://${root}`)
);

const keep = process.argv.includes('--keep');
const sha = (character) => character.repeat(64);

const combination = {
  id: `fixture-darwin-arm64-24.21.0-0.1.5-rc.2`,
  platform: 'darwin',
  arch: 'arm64',
  node: { version: '24.21.0', platform: 'darwin', arch: 'arm64', sha256: sha('a') },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: sha('b') },
  compatibility: { status: 'verified', evidenceRef: 'scripts/research/home-derivation-probe.mjs' },
  artifactLocations: {
    node: {
      version: '24.21.0',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://fixture.invalid/node.tgz',
      sha256: sha('a'),
    },
    dsh: {
      version: '0.1.5-rc.2',
      platform: 'darwin',
      arch: 'arm64',
      url: 'https://fixture.invalid/dsh.tgz',
      sha256: sha('b'),
    },
  },
};

const SENTINEL = '{"secret":"home-derivation-sentinel"}';
const CREDENTIALS = 'version: 1\nclient-connection: home-derivation-sentinel\n';

const makeRuntime = ({ plantStagedHome }) => ({
  resolveComposition: (entry) => resolveComposition(entry),
  compositionDigest: (lock) => computeCompositionDigest(lock),
  install: async (lock, destination) => {
    const nodeExecutable = join(destination, 'node', 'bin', 'node');
    const dshEntrypoint = join(destination, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    mkdirSync(dirname(nodeExecutable), { recursive: true });
    writeFileSync(nodeExecutable, '#!/bin/sh\necho fixture-node\n', { mode: 0o755 });
    mkdirSync(dirname(dshEntrypoint), { recursive: true });
    writeFileSync(dshEntrypoint, '// fixture dsh entrypoint\n');
    if (plantStagedHome) {
      // Models a "copy the previous home into the new generation" mechanism.
      const home = join(destination, 'home');
      mkdirSync(join(home, 'sessions'), { recursive: true });
      writeFileSync(join(home, 'sessions', 'sentinel.json'), SENTINEL);
      writeFileSync(join(home, '.credentials.yaml'), CREDENTIALS, { mode: 0o600 });
    }
    const manifest = {
      schemaVersion: '1',
      installMode: 'artifacts-only',
      catalogRevision: 'home-derivation-probe',
      compositionDigest: computeCompositionDigest(lock),
      node: { version: lock.node.version, sha256: lock.node.sha256, executable: 'node/bin/node' },
      dsh: {
        version: lock.dsh.version,
        sha256: lock.dsh.sha256,
        entrypoint: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
        treeDigest: sha('c'),
      },
      closure: null,
      preflight: { skipped: true, passed: false, checks: [], reason: 'fixture' },
      installedAt: new Date().toISOString(),
    };
    writeFileSync(join(destination, 'install-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      ok: true,
      value: {
        directory: destination,
        nodeExecutable,
        dshEntrypoint,
        manifestPath: join(destination, 'install-manifest.json'),
      },
    };
  },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(20);
  }
};

const journalDirectory = (layout) => layout.transactions;

const readJournals = (layout) =>
  readdirSync(journalDirectory(layout))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(journalDirectory(layout), name), 'utf8')));

const environmentDirectoryOf = (layout, environmentId) =>
  join(layout.environments, environmentId);

/** Structural observation helper: any secret-shaped file left under a generation dir. */
const findCredentialsUnder = (directory) => {
  if (!existsSync(directory)) {
    return [];
  }
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === '.credentials.yaml') {
        found.push(full);
      }
    }
  };
  walk(directory);
  return found;
};

const plantEnvironmentHome = (layout, environmentId) => {
  const home = join(environmentDirectoryOf(layout, environmentId), 'home');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'sentinel.json'), SENTINEL);
  writeFileSync(join(home, '.credentials.yaml'), CREDENTIALS, { mode: 0o600 });
  return home;
};

const results = [];
const record = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};

const rootA = mkdtempSync(join(tmpdir(), 'hdsl-home-rollback-'));
const rootB = mkdtempSync(join(tmpdir(), 'hdsl-home-commit-'));

try {
  // --- Scenario A: pre-commit rollback -----------------------------------
  console.log(`# scenario A (rollback) data root: ${rootA}`);
  const first = await createManagedInstall({
    dataRoot: rootA,
    catalog: [combination],
    runtime: makeRuntime({ plantStagedHome: true }),
    faults: { pauseBeforeCommit: true },
    allowArtifactsOnly: true,
  });
  if (!first.available) {
    throw new Error('scenario A: could not acquire the data-root lease');
  }
  const layoutA = resolveLayout(rootA);
  const created = first.service.createEnvironment({
    requestId: 'req-home-rollback',
    name: 'home-rollback',
    combination,
  });
  if (!created.ok) {
    throw new Error(`scenario A: create rejected: ${created.code}`);
  }
  const journal = await waitFor(
    () => readJournals(layoutA).find((entry) => entry.phase === 'artifacts-installed'),
    'journal phase artifacts-installed',
  );
  const stagedPaths = generationPaths(layoutA, journal.environmentId, journal.generationId);
  const stagedSentinel = join(stagedPaths.homeDirectory, 'sessions', 'sentinel.json');
  await waitFor(() => existsSync(stagedSentinel), 'staged home sentinel');
  const envHome = plantEnvironmentHome(layoutA, journal.environmentId);
  const envSentinel = join(envHome, 'sessions', 'sentinel.json');

  const environmentBefore = first.service.findEnvironment(journal.environmentId).value;
  record(
    'A0 commit never happened',
    environmentBefore.activeGenerationId === null,
    `activeGenerationId=${String(environmentBefore.activeGenerationId)} state=${environmentBefore.state}`,
  );
  await first.close();

  const second = await createManagedInstall({
    dataRoot: rootA,
    catalog: [combination],
    runtime: makeRuntime({ plantStagedHome: false }),
    allowArtifactsOnly: true,
  });
  const recovery = await second.recover();
  const environmentAfter = second.service.findEnvironment(journal.environmentId).value;

  record(
    'A1 staged generation directory removed by rollback',
    !existsSync(stagedPaths.generationDirectory),
    `generationDirectory exists=${String(existsSync(stagedPaths.generationDirectory))}`,
  );
  record(
    'A2 structural: a file written under the staged generation home is removed by rollback',
    !existsSync(stagedSentinel) && !existsSync(join(stagedPaths.homeDirectory, '.credentials.yaml')),
    `staged home/sessions/sentinel.json exists=${String(existsSync(stagedSentinel))}`,
  );
  record(
    'A3 structural: environment-level home is outside the transaction delete scope and stays readable',
    existsSync(envSentinel) && readFileSync(envSentinel, 'utf8') === SENTINEL,
    `env home sentinel readable=${String(existsSync(envSentinel))}`,
  );
  record(
    'A4 credential-shaped file under env home survives with 0600',
    existsSync(join(envHome, '.credentials.yaml')) &&
      (statSync(join(envHome, '.credentials.yaml')).mode & 0o777) === 0o600,
    `mode=${(statSync(join(envHome, '.credentials.yaml')).mode & 0o777).toString(8)}`,
  );
  record(
    'A5 rollback is explained: no active generation, operation failed',
    environmentAfter.activeGenerationId === null && recovery.details.length === 1,
    `reconciled=${recovery.reconciled} rolledBack=${recovery.rolledBack} activeGenerationId=${String(environmentAfter.activeGenerationId)}`,
  );
  const credentialsA = findCredentialsUnder(generationsDirectory(layoutA, journal.environmentId));
  record(
    'A6 structural: no secret-shaped file left under any generation dir after rollback',
    credentialsA.length === 0,
    `credentials under generations=${credentialsA.length}`,
  );
  await second.close();

  // --- Scenario B: successful commit ------------------------------------
  console.log(`# scenario B (commit) data root: ${rootB}`);
  const third = await createManagedInstall({
    dataRoot: rootB,
    catalog: [combination],
    runtime: makeRuntime({ plantStagedHome: false }),
    allowArtifactsOnly: true,
  });
  const layoutB = resolveLayout(rootB);
  const createdB = third.service.createEnvironment({
    requestId: 'req-home-commit',
    name: 'home-commit',
    combination,
  });
  if (!createdB.ok) {
    throw new Error(`scenario B: create rejected: ${createdB.code}`);
  }
  const snapshot = await third.waitForOperation(createdB.value.operationId, { timeoutMs: 15_000 });
  const environmentB = third.service.listEnvironments().value[0];
  const committedPaths = generationPaths(layoutB, environmentB.id, environmentB.activeGenerationId);
  const envHomeB = plantEnvironmentHome(layoutB, environmentB.id);
  record(
    'B0 commit switches the active generation pointer only after success',
    snapshot.status === 'succeeded' && environmentB.activeGenerationId !== null,
    `operation=${snapshot.status} activeGenerationId=${String(environmentB.activeGenerationId)}`,
  );
  record(
    'B1 structural: commit does not touch the environment-level home written by the harness',
    existsSync(join(envHomeB, 'sessions', 'sentinel.json')) &&
      readFileSync(join(envHomeB, 'sessions', 'sentinel.json'), 'utf8') === SENTINEL,
    'env home sentinel still readable after commit',
  );
  record(
    'B2 committed generation home is a separate, empty directory (per-generation home baseline)',
    existsSync(committedPaths.homeDirectory) && readdirSync(committedPaths.homeDirectory).length === 0,
    `generation home entries=${String(readdirSync(committedPaths.homeDirectory).length)}`,
  );
  const credentialsB = findCredentialsUnder(generationsDirectory(layoutB, environmentB.id));
  record(
    'B3 structural: no secret-shaped file left under any generation dir after commit',
    credentialsB.length === 0,
    `credentials under generations=${credentialsB.length}`,
  );
  await third.close();
} finally {
  if (keep) {
    console.log(`# kept data roots: ${rootA} ${rootB}`);
  } else {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
}

const failed = results.filter((entry) => !entry.passed);
console.log(`# ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  process.exitCode = 1;
}
