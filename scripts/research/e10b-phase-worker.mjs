/**
 * Child worker for e10b-phase-kill-prototype.mjs. NOT PRODUCTION CODE.
 *
 * Performs the modelled P-A phases for one generation and then either pauses
 * (for a real SIGKILL from the parent) or throws, at the requested phase.
 *
 * Usage: node e10b-phase-worker.mjs <work> <phase> <mode>
 *   phase: staged | published | pointed
 *   mode:  pause | throw
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , work, phase, mode] = process.argv;
const HOME = join(work, 'home');
const stage = join(work, 'stage', 'gen2');
const profile = join(HOME, 'profiles', 'hdsl-gen2');
const env = join(work, 'environment.json');

const writeProfile = (dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['base', 'web-app'] } } }));
  writeFileSync(join(dir, 'cordis.patch.yml'), '# gen2\n');
};

writeProfile(stage);
if (phase === 'published' || phase === 'pointed') {
  renameSync(stage, profile);
}
if (phase === 'pointed') {
  writeFileSync(env, JSON.stringify({ activeGenerationId: 'gen2' }));
}

if (mode === 'throw') {
  throw new Error(`injected throw at ${phase}`);
}
if (mode === 'pause') {
  writeFileSync(join(work, 'phase.marker'), phase);
  // Stay alive until the parent sends a real SIGKILL.
  setInterval(() => {}, 1000);
}
if (!existsSync(stage) && !existsSync(profile)) {
  throw new Error('worker invariant violated: neither stage nor profile exists');
}
