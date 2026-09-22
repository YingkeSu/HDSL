/**
 * E10b publish / switch crash-window prototype (ADR 0006 §2.3 / §5, #76).
 *
 * THIS IS A THROWAWAY MECHANISM PROTOTYPE, NOT PRODUCTION CODE. It models the
 * candidate P-A ordering at the filesystem level only:
 *
 *   shared home (env/home)  +  per-generation profile at <home>/profiles/<gen>
 *   publish = atomic rename of a staged profile dir into <home>/profiles/<gen>
 *   commit  = atomic write of environment.json.activeGenerationId
 *
 * It asserts the crash windows leave the previous generation's composition
 * lock bytes untouched and that recovery only removes unreferenced orphans.
 * It does not boot DSH (see `dsh-profile-runtime-marker-probe.sh` for runtime
 * binding) and does not implement fsync/durability guarantees.
 *
 * Usage: node scripts/research/e10b-publish-crash-prototype.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'hdsl-e10b-crash-'));
const HOME = join(WORK, 'home');
const ENV = join(WORK, 'environment.json');

const profileDir = (gen) => join(HOME, 'profiles', `hdsl-${gen}`);
const stageDir = (gen) => join(WORK, 'stage', gen);
const lockPath = (gen) => join(WORK, 'locks', `${gen}.json`);
const journalPath = () => join(WORK, 'journal.json');

const writeJournal = (generationId, committed) =>
  writeFileSync(journalPath(), JSON.stringify({ generationId, committed }));
const readJournal = () => (existsSync(journalPath()) ? JSON.parse(readFileSync(journalPath(), 'utf8')) : undefined);
const clearJournal = () => rmSync(journalPath(), { force: true });

const writeEnv = (activeGenerationId) =>
  writeFileSync(ENV, JSON.stringify({ activeGenerationId }));
const readEnv = () => JSON.parse(readFileSync(ENV, 'utf8'));

const writeProfile = (dir, marker) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: marker } } }));
  writeFileSync(join(dir, 'cordis.patch.yml'), `# ${JSON.stringify(marker)}\n`);
};

const publish = (gen) => renameSync(stageDir(gen), profileDir(gen));

/**
 * Recovery: a published profile for a *pending, uncommitted* transaction is an
 * orphan and is removed. A profile for a committed generation is kept —
 * including old generations still available for restore. This is why recovery
 * must key off the transaction journal, never off "not the active generation".
 */
const recover = () => {
  const journal = readJournal();
  const actions = [];
  if (journal === undefined) {
    return actions;
  }
  if (journal.committed === true) {
    clearJournal();
    actions.push(`finalized committed ${journal.generationId}`);
    return actions;
  }
  if (existsSync(profileDir(journal.generationId))) {
    rmSync(profileDir(journal.generationId), { recursive: true, force: true });
    actions.push(`removed orphan profile hdsl-${journal.generationId}`);
  }
  if (existsSync(stageDir(journal.generationId))) {
    rmSync(stageDir(journal.generationId), { recursive: true, force: true });
    actions.push(`removed stage ${journal.generationId}`);
  }
  clearJournal();
  return actions;
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};

const gen1Digest = () => readFileSync(lockPath('gen1'), 'utf8');

// --- fixture: gen1 is already committed and running ------------------------
mkdirSync(HOME, { recursive: true });
mkdirSync(join(WORK, 'locks'), { recursive: true });
writeProfile(profileDir('gen1'), ['base', 'web-app']);
writeFileSync(join(WORK, 'locks', 'gen1.json'), JSON.stringify({ schemaVersion: '1', node: 'n1', dsh: 'd1', plugins: ['p1'] }));
writeEnv('gen1');
const before = gen1Digest();

// window 1: crash before publish (stage exists, nothing published) ----------
writeProfile(stageDir('gen2'), ['base', 'web-app', 'p9']);
writeJournal('gen2', false);
const recover1 = recover();
check(
  'W1 crash before publish',
  gen1Digest() === before && !existsSync(profileDir('gen2')) && !existsSync(stageDir('gen2')),
  `gen1 lock unchanged; actions=[${recover1.join(', ')}]`,
);

// window 2: crash mid-publish (partial profile dir, then stage gone) --------
writeProfile(profileDir('gen2'), ['base']); // partial/incomplete published profile
writeFileSync(join(profileDir('gen2'), '.partial'), '1');
writeJournal('gen2', false);
const recover2 = recover();
check(
  'W2 crash mid-publish (orphan, pointer still gen1)',
  gen1Digest() === before && !existsSync(profileDir('gen2')) && readEnv().activeGenerationId === 'gen1',
  `gen1 lock unchanged; actions=[${recover2.join(', ')}]`,
);

// window 3: crash after publish, before pointer switch ---------------------
writeProfile(stageDir('gen2'), ['base', 'web-app', 'p9']);
publish('gen2');
writeJournal('gen2', false);
const publishedExists = existsSync(profileDir('gen2'));
const recover3 = recover();
check(
  'W3 crash after publish before pointer (orphan removed, old gen bootable)',
  publishedExists && gen1Digest() === before && !existsSync(profileDir('gen2')) && readEnv().activeGenerationId === 'gen1',
  `gen1 lock unchanged; actions=[${recover3.join(', ')}]`,
);

// window 4: crash after pointer switch, before finalize --------------------
writeProfile(stageDir('gen2'), ['base', 'web-app', 'p9']);
publish('gen2');
writeEnv('gen2');
writeJournal('gen2', true);
const recover4 = recover();
check(
  'W4 crash after pointer switch (finalize keeps gen2, gen1 restorable)',
  readEnv().activeGenerationId === 'gen2' &&
    existsSync(profileDir('gen2')) &&
    existsSync(profileDir('gen1')) &&
    gen1Digest() === before,
  `active=gen2; actions=[${recover4.join(', ')}]`,
);

console.log('# prototype only: ordering semantics, not production durability/fsync or real DSH boot');
const failed = results.filter((entry) => !entry.ok);
if (!process.argv.includes('--keep')) {
  rmSync(WORK, { recursive: true, force: true });
} else {
  console.log(`# kept ${WORK}`);
}
console.log(`# ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
