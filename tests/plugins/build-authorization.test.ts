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

const GITHUB_DEP_PATH =
  'hdsl-s4-gh-fixture-root@https://codeload.github.com/YingkeSu/hdsl-s4-gh-fixture/tar.gz/cb265920d7b0d0d5f3616417cd4053176b998f80';
// Authentic `github:`-form lock captured from the real production transport
// (probe cb265920): the packages entry carries the codeload tarball key AND the
// package version; the snapshot repeats the key without a version.
const GITHUB_LOCK = [
  "lockfileVersion: '9.0'",
  '',
  'settings:',
  '  autoInstallPeers: true',
  '  excludeLinksFromLockfile: false',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      hdsl-s4-gh-fixture-root:',
  '        specifier: github:YingkeSu/hdsl-s4-gh-fixture#cb265920d7b0d0d5f3616417cd4053176b998f80',
  '        version: https://codeload.github.com/YingkeSu/hdsl-s4-gh-fixture/tar.gz/cb265920d7b0d0d5f3616417cd4053176b998f80',
  '',
  'packages:',
  '',
  `  ${GITHUB_DEP_PATH}:`,
  '    resolution: {gitHosted: true, integrity: sha512-sTJ4c0o0zKJ6SOFmFr+b9GjW6osYzFTxEXChTI+NEh4HtvClnpv3c4bwmNgCfVZu7CPShk9H6sGEMwIajCAvJg==, tarball: https://codeload.github.com/YingkeSu/hdsl-s4-gh-fixture/tar.gz/cb265920d7b0d0d5f3616417cd4053176b998f80}',
  '    version: 0.0.1',
  '',
  'snapshots:',
  '',
  `  ${GITHUB_DEP_PATH}: {}`,
].join('\n');

const CLOSURE_LOCK = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      shared-dep:',
  '        specifier: 1.2.3',
  '        version: 1.2.3',
  "      '@scope/scoped-dep':",
  '        specifier: 2.0.0',
  '        version: 2.0.0',
  'packages:',
  '  shared-dep@1.2.3:',
  '    version: 1.2.3',
  '  transitive@3.0.0:',
  '    version: 3.0.0',
  "  '@scope/scoped-dep@2.0.0':",
  '    version: 2.0.0',
  'snapshots:',
  '  shared-dep@1.2.3:',
  '    dependencies:',
  '      transitive: 3.0.0',
  '  transitive@3.0.0: {}',
  "  '@scope/scoped-dep@2.0.0': {}",
].join('\n');

describe('github-form pinned-lock identity derivation (matches the production probe)', () => {
  it('derives the exact codeload depPath byte-for-byte with a unique name/version match', () => {
    const identities = readLockedIdentities(GITHUB_LOCK);
    expect(identities).toEqual([
      { depPath: GITHUB_DEP_PATH, name: 'hdsl-s4-gh-fixture-root', version: '0.0.1' },
    ]);
    const bound = bindAuthorizedScriptsToLock(GITHUB_LOCK, [
      { packageName: 'hdsl-s4-gh-fixture-root', packageVersion: '0.0.1', script: 'postinstall', source: 'dependency' },
    ]);
    expect(bound.ok).toBe(true);
    if (bound.ok) expect(bound.depPaths).toEqual([GITHUB_DEP_PATH]);
  });
});

describe('enumerateInstallScriptsFromInstalledTree (pinned-lock guided, .pnpm layout unit logic)', () => {
  const readPackageJsonText = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };

  const buildTree = (options: { omitTransitive?: boolean; sourcePackage?: boolean } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'hdsl-enum-'));
    roots.push(root);
    const nodeModules = join(root, 'node_modules');
    // Direct dependency at the top level (as pnpm links it).
    mkdirSync(join(nodeModules, 'shared-dep'), { recursive: true });
    writeFileSync(
      join(nodeModules, 'shared-dep', 'package.json'),
      JSON.stringify({ name: 'shared-dep', version: '1.2.3', scripts: { postinstall: 'node x.js' } }),
    );
    // TRANSITIVE dependency only inside the .pnpm virtual store (not top-level).
    if (options.omitTransitive !== true) {
      mkdirSync(join(nodeModules, '.pnpm', 'transitive@3.0.0', 'node_modules', 'transitive'), { recursive: true });
      writeFileSync(
        join(nodeModules, '.pnpm', 'transitive@3.0.0', 'node_modules', 'transitive', 'package.json'),
        JSON.stringify({ name: 'transitive', version: '3.0.0', scripts: { prepare: 'node y.js' } }),
      );
    }
    // Scoped direct dependency, no scripts.
    mkdirSync(join(nodeModules, '.pnpm', '@scope+scoped-dep@2.0.0', 'node_modules', '@scope', 'scoped-dep'), { recursive: true });
    writeFileSync(
      join(nodeModules, '.pnpm', '@scope+scoped-dep@2.0.0', 'node_modules', '@scope', 'scoped-dep', 'package.json'),
      JSON.stringify({ name: '@scope/scoped-dep', version: '2.0.0' }),
    );
    if (options.sourcePackage === true) {
      mkdirSync(join(nodeModules, '.pnpm', 'hdsl-plugin-demo@1.0.0', 'node_modules', 'hdsl-plugin-demo'), { recursive: true });
      writeFileSync(
        join(nodeModules, '.pnpm', 'hdsl-plugin-demo@1.0.0', 'node_modules', 'hdsl-plugin-demo', 'package.json'),
        JSON.stringify({ name: 'hdsl-plugin-demo', version: '1.0.0', scripts: { prepare: 'node z.js' } }),
      );
    }
    return { nodeModules };
  };

  it('enumerates a transitive dependency that only exists in the .pnpm virtual store', () => {
    const { nodeModules } = buildTree();
    const scripts = enumerateInstallScriptsFromInstalledTree({
      nodeModulesDirectory: nodeModules,
      lockText: CLOSURE_LOCK,
      excludePackageName: 'hdsl-plugin-demo',
      readPackageJsonText,
    });
    expect(scripts).toEqual(
      expect.arrayContaining([
        { packageName: 'shared-dep', packageVersion: '1.2.3', script: 'postinstall', source: 'dependency' },
        { packageName: 'transitive', packageVersion: '3.0.0', script: 'prepare', source: 'dependency' },
      ]),
    );
    expect(scripts).toHaveLength(2);
  });

  it('excludes the authorized source package from the dependency set (counted as root)', () => {
    const { nodeModules } = buildTree({ sourcePackage: true });
    const lock = `${CLOSURE_LOCK}\n  hdsl-plugin-demo@1.0.0:\n    version: 1.0.0\n`;
    const scripts = enumerateInstallScriptsFromInstalledTree({
      nodeModulesDirectory: nodeModules,
      lockText: lock,
      excludePackageName: 'hdsl-plugin-demo',
      readPackageJsonText,
    });
    expect(scripts?.some((script) => script.packageName === 'hdsl-plugin-demo')).toBe(false);
  });

  it('returns undefined (unknown) when a reachable locked package has no readable manifest', () => {
    const { nodeModules } = buildTree({ omitTransitive: true });
    const scripts = enumerateInstallScriptsFromInstalledTree({
      nodeModulesDirectory: nodeModules,
      lockText: CLOSURE_LOCK,
      excludePackageName: 'hdsl-plugin-demo',
      readPackageJsonText,
    });
    expect(scripts).toBeUndefined();
  });

  it('fail-closes when two reachable identities share name+version but differ in resolved Git identity', () => {
    // `(name, version)` equality does NOT prove the same commit/peer identity; a
    // one-to-many merge is never silently accepted.
    const ambiguousLock = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      a:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '      b:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      'packages:',
      '  a@1.0.0:',
      '    version: 1.0.0',
      '  b@1.0.0:',
      '    version: 1.0.0',
      '  dup@1.0.0:',
      '    version: 1.0.0',
      '  dup@git+file:///x#abc:',
      '    version: 1.0.0',
      'snapshots:',
      '  a@1.0.0:',
      '    dependencies:',
      '      dup: 1.0.0',
      '  b@1.0.0:',
      '    dependencies:',
      '      dup: git+file:///x#abc',
      '  dup@1.0.0: {}',
      '  dup@git+file:///x#abc: {}',
    ].join('\n');
    const { nodeModules } = buildTree();
    const scripts = enumerateInstallScriptsFromInstalledTree({
      nodeModulesDirectory: nodeModules,
      lockText: ambiguousLock,
      excludePackageName: 'hdsl-plugin-demo',
      readPackageJsonText,
    });
    expect(scripts).toBeUndefined();
  });
});
