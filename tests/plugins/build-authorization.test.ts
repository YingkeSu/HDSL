/**
 * #78 S4 explicit build authorization: exact, enumerated, plan-bound decisions.
 * Pure/offline: no script is executed and no fixture is run.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildScriptEntry } from '@hdsl/contracts';
import {
  bindAuthorizedScriptsToLock,
  buildScriptKey,
  composeAuthorizedWorkspace,
  decideBuildAuthorization,
  enumerateInstallScriptsFromInstalledTree,
  readLockedIdentities,
  sameBuildScriptSet,
} from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const GIT_KEY =
  'hdsl-plugin-demo@https://codeload.github.com/octo/dsh-plugin-demo/tar.gz/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838';
const LOCK_TEXT = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      hdsl-plugin-demo:',
  '        specifier: github:octo/dsh-plugin-demo',
  `        version: ${GIT_KEY.slice(GIT_KEY.indexOf('@') + 1)}`,
  'packages:',
  `  ${GIT_KEY}:`,
  '    resolution: {integrity: sha512-x}',
  '    version: 1.0.0',
  '  shared-dep@1.2.3:',
  '    resolution: {integrity: sha512-y}',
  '    version: 1.2.3',
  'snapshots:',
  '  shared-dep@1.2.3: {}',
].join('\n');

const entry = (overrides: Partial<BuildScriptEntry> = {}): BuildScriptEntry => ({
  packageName: 'hdsl-plugin-demo',
  packageVersion: '1.0.0',
  script: 'prepare',
  source: 'root',
  ...overrides,
});

describe('build script set equality (multiset, exact)', () => {
  it('accepts the same set in any order and rejects subset/superset/duplicates', () => {
    const a = entry({ script: 'prepare' });
    const b = entry({ script: 'postinstall', source: 'dependency' });
    expect(sameBuildScriptSet([a, b], [b, a])).toBe(true);
    expect(sameBuildScriptSet([a], [a, b])).toBe(false);
    expect(sameBuildScriptSet([a, b], [a])).toBe(false);
    expect(sameBuildScriptSet([a, a], [a, b])).toBe(false);
    expect(buildScriptKey(a)).toBe('root\u0000hdsl-plugin-demo\u00001.0.0\u0000prepare');
  });
});

describe('pinned-lock identity binding', () => {
  it('derives the exact depPath for a git and a registry dependency', () => {
    const identities = readLockedIdentities(LOCK_TEXT);
    expect(identities.some((identity) => identity.depPath === GIT_KEY && identity.version === '1.0.0')).toBe(true);
    expect(identities.some((identity) => identity.depPath === 'shared-dep@1.2.3' && identity.version === '1.2.3')).toBe(true);

    const bound = bindAuthorizedScriptsToLock(LOCK_TEXT, [
      entry({ script: 'prepare' }),
      entry({ packageName: 'shared-dep', packageVersion: '1.2.3', script: 'postinstall', source: 'dependency' }),
    ]);
    expect(bound.ok).toBe(true);
    if (bound.ok) expect(bound.depPaths).toEqual(['shared-dep@1.2.3', GIT_KEY].sort());
  });

  it('fails closed on zero or ambiguous matches', () => {
    expect(bindAuthorizedScriptsToLock(LOCK_TEXT, [entry({ packageName: 'missing' })]).ok).toBe(false);
    const ambiguous = LOCK_TEXT.replace(
      'snapshots:',
      '  hdsl-plugin-demo@1.0.0:\n    version: 1.0.0\nsnapshots:',
    );
    expect(bindAuthorizedScriptsToLock(ambiguous, [entry()]).ok).toBe(false);
  });
});

describe('decideBuildAuthorization', () => {
  const base = {
    authorization: null,
    commitSha: 'e'.repeat(40),
    scriptAssessment: 'none-detected' as const,
    scripts: [] as readonly BuildScriptEntry[],
    closureEnumerated: true,
    lockText: LOCK_TEXT,
  };

  it('keeps default deny for a script-free source and refuses detected/unknown without authorization', () => {
    expect(decideBuildAuthorization(base)).toEqual({ ok: true, mode: 'deny' });
    expect(decideBuildAuthorization({ ...base, scriptAssessment: 'detected', scripts: [entry()] })).toMatchObject({
      ok: false,
      code: 'BUILD_NOT_AUTHORIZED',
    });
    expect(decideBuildAuthorization({ ...base, scriptAssessment: 'unknown' })).toMatchObject({
      ok: false,
      code: 'BUILD_NOT_AUTHORIZED',
    });
  });

  it('requests enumeration for an authorization when the closure is not yet enumerated', () => {
    const decision = decideBuildAuthorization({
      ...base,
      authorization: { commitSha: 'e'.repeat(40), scripts: [entry()] },
      scriptAssessment: 'detected',
      scripts: [entry()],
      closureEnumerated: false,
    });
    expect(decision).toEqual({ ok: true, mode: 'enumerate' });
  });

  it('refuses a commit drift and a non-exact script set', () => {
    expect(
      decideBuildAuthorization({
        ...base,
        authorization: { commitSha: 'f'.repeat(40), scripts: [entry()] },
        scriptAssessment: 'detected',
        scripts: [entry()],
      }),
    ).toMatchObject({ ok: false, code: 'AUTHORIZATION_MISMATCH' });
    expect(
      decideBuildAuthorization({
        ...base,
        authorization: { commitSha: 'e'.repeat(40), scripts: [entry({ script: 'postinstall' })] },
        scriptAssessment: 'detected',
        scripts: [entry()],
      }),
    ).toMatchObject({ ok: false, code: 'AUTHORIZATION_MISMATCH' });
  });

  it('allows exactly the enumerated set and binds it to the pinned lock', () => {
    const decision = decideBuildAuthorization({
      ...base,
      authorization: { commitSha: 'e'.repeat(40), scripts: [entry()] },
      scriptAssessment: 'detected',
      scripts: [entry()],
    });
    expect(decision).toEqual({ ok: true, mode: 'allow', depPaths: [GIT_KEY] });
  });

  it('refuses an allow without a plan-bound lock', () => {
    expect(
      decideBuildAuthorization({
        ...base,
        lockText: null,
        authorization: { commitSha: 'e'.repeat(40), scripts: [entry()] },
        scriptAssessment: 'detected',
        scripts: [entry()],
      }),
    ).toMatchObject({ ok: false, code: 'BUILD_NOT_AUTHORIZED' });
  });
});

describe('composeAuthorizedWorkspace', () => {
  it('adds only the exact allowBuilds entries and preserves other config', () => {
    const composed = composeAuthorizedWorkspace('packages:\n  - packages/*\n', [GIT_KEY]);
    expect(composed.ok).toBe(true);
    if (composed.ok) {
      expect(composed.text).toContain('packages:');
      expect(composed.text).toContain('allowBuilds:');
      expect(composed.text).toContain(`${GIT_KEY}: true`);
      expect(composed.text).not.toContain('dangerouslyAllowAllBuilds');
    }
  });

  it('refuses a pre-existing broad policy or allow list', () => {
    expect(composeAuthorizedWorkspace('dangerouslyAllowAllBuilds: true\n', [GIT_KEY]).ok).toBe(false);
    expect(composeAuthorizedWorkspace('allowBuilds:\n  other@1.0.0: true\n', [GIT_KEY]).ok).toBe(false);
    expect(composeAuthorizedWorkspace('onlyBuiltDependencies:\n  - other\n', [GIT_KEY]).ok).toBe(false);
  });
});

describe('enumerateInstallScriptsFromInstalledTree', () => {
  it('reads dependency scripts non-executing and excludes the authorized source package', () => {
    const root = mkdtempSync(join(tmpdir(), 'hdsl-enum-'));
    roots.push(root);
    const nodeModules = join(root, 'node_modules');
    mkdirSync(join(nodeModules, 'shared-dep'), { recursive: true });
    mkdirSync(join(nodeModules, '@scope', 'scoped-dep'), { recursive: true });
    mkdirSync(join(nodeModules, 'hdsl-plugin-demo'), { recursive: true });
    writeFileSync(join(nodeModules, 'shared-dep', 'package.json'), JSON.stringify({ name: 'shared-dep', version: '1.2.3', scripts: { postinstall: 'node x.js' } }));
    writeFileSync(join(nodeModules, '@scope', 'scoped-dep', 'package.json'), JSON.stringify({ name: '@scope/scoped-dep', version: '2.0.0', scripts: { prepare: 'node y.js' } }));
    writeFileSync(join(nodeModules, 'hdsl-plugin-demo', 'package.json'), JSON.stringify({ name: 'hdsl-plugin-demo', version: '1.0.0', scripts: { prepare: 'node z.js' } }));

    const scripts = enumerateInstallScriptsFromInstalledTree({
      nodeModulesDirectory: nodeModules,
      excludePackageName: 'hdsl-plugin-demo',
      readPackageJsonText: (path) => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return undefined;
        }
      },
    });
    expect(scripts).toEqual(
      expect.arrayContaining([
        { packageName: 'shared-dep', packageVersion: '1.2.3', script: 'postinstall', source: 'dependency' },
        { packageName: '@scope/scoped-dep', packageVersion: '2.0.0', script: 'prepare', source: 'dependency' },
      ]),
    );
    expect(scripts.some((script) => script.packageName === 'hdsl-plugin-demo')).toBe(false);
  });
});
