/**
 * #77 S3: pnpm 11.7.0 lock reachability — retention is decided by the resolved
 * closure with EXACT identities, not by the root importer's direct list and not
 * by package-name string matching.
 */
import { describe, expect, it } from 'vitest';
import { resolveLockClosure, targetRetentionInLock } from '@hdsl/runtime';

/** Real shape from the managed fixture profile lock (git dep via codeload). */
const GIT_LOCK = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      hdsl-plugin-e2e-fixture:',
  '        specifier: github:YingkeSu/hdsl-plugin-e2e-fixture#e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838',
  '        version: https://codeload.github.com/YingkeSu/hdsl-plugin-e2e-fixture/tar.gz/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838',
  'packages:',
  '  hdsl-plugin-e2e-fixture@https://codeload.github.com/YingkeSu/hdsl-plugin-e2e-fixture/tar.gz/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838:',
  '    resolution: {gitHosted: true, integrity: sha512-abc, tarball: https://codeload.github.com/YingkeSu/hdsl-plugin-e2e-fixture/tar.gz/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838}',
  '    version: 0.0.1',
  'snapshots:',
  '  hdsl-plugin-e2e-fixture@https://codeload.github.com/YingkeSu/hdsl-plugin-e2e-fixture/tar.gz/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838: {}',
].join('\n');

/** A is removed directly, but retained B still depends on A (transitive retention). */
const TRANSITIVE_LOCK = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      b:',
  '        specifier: 1.0.0',
  '        version: 1.0.0',
  'packages:',
  '  b@1.0.0:',
  '    resolution: {integrity: sha512-b}',
  '  a@1.0.0:',
  '    resolution: {integrity: sha512-a}',
  '  unrelated@1.0.0:',
  '    resolution: {integrity: sha512-u}',
  'snapshots:',
  "  b@1.0.0:",
  '    dependencies:',
  '      a: 1.0.0',
  '  a@1.0.0: {}',
  '  unrelated@1.0.0: {}',
].join('\n');

describe('resolveLockClosure', () => {
  it('walks resolved snapshot edges (git identity is the tarball URL, not the version)', () => {
    const closure = resolveLockClosure(GIT_LOCK);
    expect(closure.status).toBe('ok');
    if (closure.status !== 'ok') return;
    expect(closure.direct).toEqual(['hdsl-plugin-e2e-fixture']);
    expect(closure.reachable).toContain(
      'hdsl-plugin-e2e-fixture@https://codeload.github.com/YingkeSu/hdsl-plugin-e2e-fixture/tar.gz/e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838',
    );
    // The registry-style identity (version) is NOT the resolved identity here.
    expect(closure.reachable).not.toContain('hdsl-plugin-e2e-fixture@0.0.1');
  });

  it('keeps a transitively retained package in the closure and excludes unreachable entries', () => {
    const closure = resolveLockClosure(TRANSITIVE_LOCK);
    expect(closure.status).toBe('ok');
    if (closure.status !== 'ok') return;
    expect(closure.direct).toEqual(['b']);
    expect(closure.reachable).toContain('a@1.0.0');
    expect(closure.reachable).not.toContain('unrelated@1.0.0');
  });

  it('fails closed on REACHABLE local edges and ignores unreachable ones', () => {
    const reachableLocal = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      b:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      'packages:',
      '  b@1.0.0:',
      '    resolution: {integrity: sha512-b}',
      '  a@1.0.0:',
      '    resolution: {integrity: sha512-a}',
      'snapshots:',
      '  b@1.0.0:',
      '    dependencies:',
      '      a: link:../a',
      '  a@1.0.0: {}',
    ].join('\n');
    // A could be referenced through the reachable local edge => unsupported, and
    // never a silent retained:false.
    expect(resolveLockClosure(reachableLocal).status).toBe('unsupported');
    expect(targetRetentionInLock(reachableLocal, 'a@1.0.0')).toMatchObject({ status: 'unsupported' });

    const localSeed = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      b:',
      '        specifier: link:../b',
      '        version: link:../b',
      'packages:',
      '  b@1.0.0: {}',
      'snapshots:',
      '  b@1.0.0: {}',
    ].join('\n');
    expect(resolveLockClosure(localSeed).status).toBe('unsupported');

    // An UNREACHABLE record containing a local edge must not block.
    const unreachableLocal = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      b:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      'packages:',
      '  b@1.0.0:',
      '    resolution: {integrity: sha512-b}',
      '  orphan@1.0.0:',
      '    resolution: {integrity: sha512-o}',
      'snapshots:',
      '  b@1.0.0: {}',
      '  orphan@1.0.0:',
      '    dependencies:',
      '      a: link:../a',
    ].join('\n');
    const closure = resolveLockClosure(unreachableLocal);
    expect(closure.status).toBe('ok');
    if (closure.status !== 'ok') return;
    expect(closure.reachable).toEqual(['b@1.0.0']);
  });

  it('fails closed on unsupported shapes instead of claiming completion', () => {
    expect(resolveLockClosure('lockfileVersion: 9.0\n').status).toBe('unsupported');
    expect(resolveLockClosure('importers:\n  .:\n    dependencies:\n      a:\n        specifier: 1\n').status).toBe('unsupported');
  });
});

describe('targetRetentionInLock (mandatory #77 regression)', () => {
  it('reports A as legitimately retained when retained B depends on it', () => {
    const retention = targetRetentionInLock(TRANSITIVE_LOCK, 'a@1.0.0');
    expect(retention).toMatchObject({ retained: true, direct: ['b'] });
  });

  it('does not report an unreachable A as retained', () => {
    const withoutA = TRANSITIVE_LOCK.replace('      a: 1.0.0\n', '');
    const retention = targetRetentionInLock(withoutA, 'a@1.0.0');
    expect(retention).toMatchObject({ retained: false });
  });

  it('returns unsupported (never "removed") when the lock cannot be interpreted', () => {
    expect(targetRetentionInLock('lockfileVersion: 9.0\n', 'a@1.0.0')).toMatchObject({ status: 'unsupported' });
  });
});
