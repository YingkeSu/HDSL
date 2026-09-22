/**
 * E10b real-subprocess kill / throw prototype per reachable phase (ADR 0006, #76).
 *
 * THIS IS A THROWAWAY MECHANISM PROTOTYPE, NOT PRODUCTION CODE. Unlike the
 * sequential crash-window model in e10b-publish-crash-prototype.mjs, this
 * spawns `e10b-phase-worker.mjs` as a REAL child process and either sends a real
 * SIGKILL (observed as signal === 'SIGKILL') or lets it throw at each reachable
 * phase, then runs reconciliation and asserts the outcome.
 *
 * Phases: staged (before publish), published (after publish), pointed (after
 * pointer switch). Reconciliation rules match the sibling prototype: the
 * pointer is authoritative, the journal only identifies a pending transaction,
 * GC is confined to the `hdsl-` namespace.
 *
 * The phases are MODELLED (a tiny worker performs the filesystem steps); only
 * the signal is real. This does not stand in for a real HDSL transaction.
 *
 * Usage: node scripts/research/e10b-phase-kill-prototype.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./e10b-phase-worker.mjs', import.meta.url));
const MANAGED_PREFIX = 'hdsl-';

const setupWork = () => {
  const work = mkdtempSync(join(tmpdir(), 'hdsl-e10b-phase-'));
  const home = join(work, 'home');
  mkdirSync(join(home, 'profiles', `${MANAGED_PREFIX}gen1`), { recursive: true });
  writeFileSync(join(home, 'profiles', `${MANAGED_PREFIX}gen1`, 'package.json'), '{"gen":1}');
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true });
  mkdirSync(join(work, 'locks'), { recursive: true });
  writeFileSync(join(work, 'locks', 'gen1.json'), JSON.stringify({ schemaVersion: '1', plugins: ['p1'] }));
  writeFileSync(join(work, 'environment.json'), JSON.stringify({ activeGenerationId: 'gen1' }));
  writeFileSync(join(work, 'journal.json'), JSON.stringify({ generationId: 'gen2', committed: false }));
  return work;
};

const recover = (work) => {
  const home = join(work, 'home');
  const envPath = join(work, 'environment.json');
  const journalPath = join(work, 'journal.json');
  const active = JSON.parse(readFileSync(envPath, 'utf8')).activeGenerationId;
  if (!existsSync(journalPath)) {
    return [];
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const actions = [];
  const name = `${MANAGED_PREFIX}${journal.generationId}`;
  if (journal.generationId === active) {
    rmSync(journalPath, { force: true });
    actions.push(`roll-forward: pointer references ${journal.generationId}; kept ${name}`);
    return actions;
  }
  const dir = join(home, 'profiles', name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    actions.push(`removed orphan ${name}`);
  }
  const stage = join(work, 'stage', journal.generationId);
  if (existsSync(stage)) {
    rmSync(stage, { recursive: true, force: true });
    actions.push(`removed stage ${journal.generationId}`);
  }
  rmSync(journalPath, { force: true });
  return actions;
};

const runChild = (args) => {
  const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, done };
};

const waitForMarker = async (work, pid) => {
  const marker = join(work, 'phase.marker');
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(marker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`worker ${String(pid)} never signalled its phase`);
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};

const pauseAt = async (phase) => {
  const work = setupWork();
  const { child, done } = runChild([work, phase, 'pause']);
  await waitForMarker(work, child.pid);
  child.kill('SIGKILL');
  const outcome = await done;
  const actions = recover(work);
  const env = JSON.parse(readFileSync(join(work, 'environment.json'), 'utf8'));
  const oldLock = readFileSync(join(work, 'locks', 'gen1.json'), 'utf8');
  const passed =
    outcome.signal === 'SIGKILL' &&
    env.activeGenerationId === (phase === 'pointed' ? 'gen2' : 'gen1') &&
    existsSync(join(work, 'home', 'profiles', `${MANAGED_PREFIX}gen1`)) &&
    oldLock === JSON.stringify({ schemaVersion: '1', plugins: ['p1'] });
  check(
    `KILL@${phase}`,
    passed,
    `signal=${String(outcome.signal)} active=${env.activeGenerationId} oldGenKept=${String(existsSync(join(work, 'home', 'profiles', `${MANAGED_PREFIX}gen1`)))} actions=[${actions.join(', ')}]`,
  );
  rmSync(work, { recursive: true, force: true });
};

const throwAt = async (phase) => {
  const work = setupWork();
  const outcome = await runChild([work, phase, 'throw']).done;
  const actions = recover(work);
  const env = JSON.parse(readFileSync(join(work, 'environment.json'), 'utf8'));
  // A throw after the commit point (pointed) rolls forward: the pointer is
  // authoritative and the new profile is kept, never reported as rolled back.
  const committed = phase === 'pointed';
  const expectedActive = committed ? 'gen2' : 'gen1';
  const newProfile = existsSync(join(work, 'home', 'profiles', `${MANAGED_PREFIX}gen2`));
  check(
    `THROW@${phase}`,
    outcome.code !== 0 && env.activeGenerationId === expectedActive && newProfile === committed,
    `exit=${String(outcome.code)} active=${env.activeGenerationId} newProfileKept=${String(newProfile)} actions=[${actions.join(', ')}]`,
  );
  rmSync(work, { recursive: true, force: true });
};

for (const phase of ['staged', 'published', 'pointed']) {
  await pauseAt(phase);
}
for (const phase of ['staged', 'published', 'pointed']) {
  await throwAt(phase);
}

console.log('# prototype only: real SIGKILL/throw of the modelled phases, not production durability/boot');
const failed = results.filter((entry) => !entry.ok);
console.log(`# ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
