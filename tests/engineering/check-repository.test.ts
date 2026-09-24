/**
 * Regression tests for `scripts/check_repository.py` (issue #15 residual).
 *
 * The requirement/task check used to hardcode a fixed `range(1, 9)`, so adding
 * FR-009+/T009+ silently stopped verifying them (stale rather than failing) and
 * nothing proved that a removed id still fails. These tests run the *real*
 * checker against a throwaway copy of the tracked tree, so the pass case and
 * every fail-closed negative control below exercise the shipped script rather
 * than a re-implementation:
 *
 * - the untouched copy passes;
 * - removing a frozen requirement (middle or highest) fails;
 * - removing a frozen task fails;
 * - a section that defines no ids fails;
 * - a missing required file still fails (the id check must not replace it);
 * - appending a new contiguous id passes without editing the checker.
 *
 * The fixture is a full copy, so it stays valid when the required-file set or
 * the authored links change in an unrelated PR.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkerRelative = 'scripts/check_repository.py';
const specRelative = 'specs/001-environment-lifecycle/spec.md';
const tasksRelative = 'specs/001-environment-lifecycle/tasks.md';
const requiredFileRelative = 'docs/README.md';

let fixtureRoot = '';

/** Every publishable file, mirroring the file set the checker itself scans. */
const repositoryFiles = (): readonly string[] =>
  execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\0')
    .filter((name) => name.length > 0);

const copyRepository = (destination: string): void => {
  for (const relative of repositoryFiles()) {
    const source = join(repoRoot, relative);
    const target = join(destination, relative);
    mkdirSync(dirname(target), { recursive: true });
    try {
      // Hardlink keeps the fixture cheap on a loaded machine; mutations unlink
      // first so the repository file itself is never written through.
      linkSync(source, target);
    } catch {
      copyFileSync(source, target);
    }
  }
};

const runChecker = (): { readonly status: number | null; readonly output: string } => {
  const result = spawnSync('python3', [join(fixtureRoot, checkerRelative)], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

/** Runs `assertion` against a mutated copy of one fixture file, then restores it. */
const withFile = (
  relative: string,
  mutate: (source: string) => string,
  assertion: () => void,
): void => {
  const path = join(fixtureRoot, relative);
  const original = readFileSync(path, 'utf8');
  try {
    rmSync(path);
    writeFileSync(path, mutate(original));
    assertion();
  } finally {
    rmSync(path, { force: true });
    writeFileSync(path, original);
  }
};

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'hdsl-check-repository-'));
  copyRepository(fixtureRoot);
  // A fresh repository with no index is enough: the checker's
  // `git ls-files --cached --others --exclude-standard` lists every copied
  // file as an untracked (\"other\") file, so `git add -A` is unnecessary.
  execFileSync('git', ['init', '-q'], { cwd: fixtureRoot });
}, 120_000);

afterAll(() => {
  if (fixtureRoot.length > 0) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}, 60_000);

describe('scripts/check_repository.py requirement and task integrity', () => {
  it('passes on an untouched copy of the repository', () => {
    const result = runChecker();
    expect(result.output).toContain('PASS:');
    expect(result.status).toBe(0);
  });

  it('fails when a middle frozen requirement definition is removed', () => {
    withFile(specRelative, (source) => source.replace(/^- \*\*FR-004\*\*:.*\n/m, ''), () => {
      const result = runChecker();
      expect(result.status).toBe(1);
      expect(result.output).toContain('FR-004');
    });
  });

  it('fails when the highest frozen requirement is removed without leaving a gap', () => {
    withFile(specRelative, (source) => source.replace(/^- \*\*FR-008\*\*:.*\n/m, ''), () => {
      const result = runChecker();
      expect(result.status).toBe(1);
      expect(result.output).toContain('FR-008');
    });
  });

  it('fails when a frozen task is removed', () => {
    withFile(tasksRelative, (source) => source.replace(/^- \[[ xX]\] T005 .*\n/m, ''), () => {
      const result = runChecker();
      expect(result.status).toBe(1);
      expect(result.output).toContain('T005');
    });
  });

  it('fails when the requirement section defines no ids', () => {
    withFile(
      specRelative,
      (source) => source.replace(/^- \*\*FR-\d{3}\*\*:.*\n/gm, ''),
      () => {
        const result = runChecker();
        expect(result.status).toBe(1);
        expect(result.output).toContain('defines no');
      },
    );
  });

  it('still fails when a required file is missing', () => {
    const path = join(fixtureRoot, requiredFileRelative);
    const original = readFileSync(path, 'utf8');
    try {
      rmSync(path);
      const result = runChecker();
      expect(result.status).toBe(1);
      expect(result.output).toContain(requiredFileRelative);
    } finally {
      rmSync(path, { force: true });
      writeFileSync(path, original);
    }
  });

  it('accepts a new contiguous requirement id without editing the checker', () => {
    withFile(
      specRelative,
      (source) => `${source}\n- **FR-009**: 系统 MUST 支持测试用的新增需求。\n`,
      () => {
        const result = runChecker();
        expect(result.status).toBe(0);
        expect(result.output).toContain('9 requirements');
      },
    );
  });
});
