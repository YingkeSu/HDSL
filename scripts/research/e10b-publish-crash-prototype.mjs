/**
 * E10b publish / switch crash-window prototype (ADR 0006 §2.3 / §5, #76).
 *
 * THIS IS A THROWAWAY MECHANISM PROTOTYPE, NOT PRODUCTION CODE. It models the
 * candidate P-A ordering at the filesystem level only:
 *
 *   shared home (env/home) + per-generation profile at <home>/profiles/hdsl-<gen>
 *   publish = atomic rename of a staged profile dir into the managed namespace
 *   commit  = atomic write of environment.json.activeGenerationId
 *
 * Reconciliation rules encoded here (review M3):
 *   - the active-generation pointer is authoritative: a profile the pointer
 *     references is NEVER removed;
 *   - the journal only identifies a *pending* transaction; if the pointer
 *     already references that transaction's generation (window W5), recovery
 *     rolls forward and keeps the profile;
 *   - GC is confined to the `hdsl-` managed namespace and never touches `web`
 *     or user profiles.
 *
 * Window W2 models a partially written published profile. Under a single atomic
 * `rename` that window is UNREACHABLE and is kept only as a defensive check for
 * a future non-atomic publish.
 *
 * It does not boot DSH and does not implement fsync/durability guarantees.
 *
 * Usage: node scripts/research/e10b-publish-crash-prototype.mjs [--keep]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORK = mkdtempSync(join(tmpdir(), 'hdsl-e10b-crash-'));
const HOME = join(WORK, 'home');
const ENV = join(WORK, 'environment.json');
const MANAGED_PREFIX = 'hdsl-';

const profileDir = (gen) => join(HOME, 'profiles', `${MANAGED_PREFIX}${gen}`);
const stageDir = (gen) => join(WORK, 'stage', gen);
const lockPath = (gen) => join(WORK, 'locks', `${gen}.json`);
const journalPath = () => join(WORK, 'journal.json');

const writeEnv = (activeGenerationId) => writeFileSync(ENV, JSON.stringify({ activeGenerationId }));
const readEnv = () => JSON.parse(readFileSync(ENV, 'utf8'));
const writeJournal = (generationId, committed) =>
  writeFileSync(journalPath(), JSON.stringify({ generationId, committed }));
const readJournal = () =>
  existsSync(journalPath()) ? JSON.parse(readFileSync(journalPath(), 'utf8')) : undefined;
const clearJournal = () => rmSync(journalPath(), { force: true });

const writeProfile = (dir, marker) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: marker } } }));
  writeFileSync(join(dir, 'cordis.patch.yml'), `# ${JSON.stringify(marker)}\n`);
};
const publish = (gen) => renameSync(stageDir(gen), profileDir(gen));

/** Remove one profile, but only inside the managed namespace and never the active generation. */
const removeProfileByName = (name) => {
  if (!name.startsWith(MANAGED_PREFIX)) {
    return `refused to remove non-managed ${name}`;
  }
  const active = readEnv().activeGenerationId;
  if (active !== null && name === `${MANAGED_PREFIX}${active}`) {
    return `refused to remove active ${name}`;
  }
  const dir = join(HOME, 'profiles', name);
  if (!existsSync(dir)) {
    return `no profile ${name}`;
  }
  rmSync(dir, { recursive: true, force: true });
  return `removed orphan profile ${name}`;
};
const removeManagedProfile = (gen) => removeProfileByName(`${MANAGED_PREFIX}${gen}`);

/**
 * Recovery: pointer is authoritative. A pending journal either rolls forward
 * (pointer references it) or rolls back (orphan profile + stage removed).
 */
const recover = () => {
  const journal = readJournal();
  const actions = [];
  if (journal === undefined) {
    return actions;
  }
  const active = readEnv().activeGenerationId;
  if (journal.generationId === active) {
    clearJournal();
    actions.push(`roll-forward: pointer references ${journal.generationId}; kept profile`);
    return actions;
  }
  actions.push(removeManagedProfile(journal.generationId));
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

// --- fixture: gen1 committed; `web` is a user/default profile that is off-limits
mkdirSync(HOME, { recursive: true });
mkdirSync(join(WORK, 'locks'), { recursive: true });
writeProfile(profileDir('gen1'), ['base', 'web-app']);
writeProfile(join(HOME, 'profiles', 'web'), ['web-template']);
writeFileSync(lockPath('gen1'), JSON.stringify({ schemaVersion: '1', plugins: ['p1'] }));
writeEnv('gen1');
const before = gen1Digest();
const webProfileDir = join(HOME, 'profiles', 'web');

const webIntact = () => existsSync(webProfileDir) && readFileSync(join(webProfileDir, 'cordis.patch.yml'), 'utf8').includes('web-template');

// window 1: crash before publish -------------------------------------------------
writeProfile(stageDir('gen2'), ['base', 'web-app', 'p9']);
writeJournal('gen2', false);
const w1 = recover();
check('W1 crash before publish', gen1Digest() === before && !existsSync(stageDir('gen2')), `actions=[${w1.join(', ')}]`);

// window 2: DEFENSIVE partial published profile (unreachable with atomic rename) --
writeProfile(profileDir('gen2'), ['base']);
writeFileSync(join(profileDir('gen2'), '.partial'), '1');
writeJournal('gen2', false);
const w2 = recover();
check(
  'W2 defensive partial publish (atomic-rename gap, orphan removed)',
  gen1Digest() === before && !existsSync(profileDir('gen2')),
  `actions=[${w2.join(', ')}]`,
);

// window 3: crash after publish, before pointer switch ---------------------------
writeProfile(stageDir('gen2'), ['base', 'web-app', 'p9']);
publish('gen2');
writeJournal('gen2', false);
const w3 = recover();
check(
  'W3 crash after publish before pointer (orphan removed)',
  gen1Digest() === before && !existsSync(profileDir('gen2')) && readEnv().activeGenerationId === 'gen1',
  `actions=[${w3.join(', ')}]`,
);

// window 4: crash after pointer switch AND journal committed ---------------------
writeProfile(stageDir('gen2'), ['base', 'web-app', 'p9']);
publish('gen2');
writeEnv('gen2');
writeJournal('gen2', true);
const w4 = recover();
check(
  'W4 crash after pointer switch + committed journal (finalize, gen1 restorable)',
  readEnv().activeGenerationId === 'gen2' &&
    existsSync(profileDir('gen2')) &&
    existsSync(profileDir('gen1')) &&
    gen1Digest() === before,
  `actions=[${w4.join(', ')}]`,
);

// window 5: pointer switched but journal NOT committed ---------------------------
writeProfile(stageDir('gen3'), ['base', 'web-app', 'p9']);
publish('gen3');
writeEnv('gen3');
writeJournal('gen3', false);
const w5 = recover();
check(
  'W5 pointer switched, journal uncommitted (roll-forward; active profile never deleted)',
  readEnv().activeGenerationId === 'gen3' &&
    existsSync(profileDir('gen3')) &&
    existsSync(profileDir('gen1')) &&
    existsSync(profileDir('gen2')) &&
    gen1Digest() === before,
  `active=gen3 kept=${String(existsSync(profileDir('gen3')))} actions=[${w5.join(', ')}]`,
);

check('N1 user/default `web` profile never touched by GC', webIntact(), 'web profile intact across all windows');
check('N2 GC confined to hdsl- namespace (non-managed name refused)', removeProfileByName('web').startsWith('refused'), removeProfileByName('web'));

console.log('# prototype only: ordering semantics, not production durability/fsync or real DSH boot');
const failed = results.filter((entry) => !entry.ok);
if (process.argv.includes('--keep')) {
  console.log(`# kept ${WORK}`);
} else {
  rmSync(WORK, { recursive: true, force: true });
}
console.log(`# ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
