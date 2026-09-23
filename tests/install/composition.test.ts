/**
 * Composition digest + audited catalog tests.
 *
 * The digest golden value was computed independently from the canonical bytes
 * (`printf '%s' "<canonical>" | shasum -a 256`), so this pins the frozen
 * cross-platform digest, not just the current implementation.
 */
import { describe, expect, it } from 'vitest';
import { compositionLockSchema, type CompositionLock } from '@hdsl/contracts';
import {
  CATALOG_REVISION,
  DSH_ARTIFACT_SHA256,
  DSH_ARTIFACT_SHA256_TIER2,
  DSH_VERSION,
  DSH_VERSION_TIER2,
  VERIFIED_COMBINATIONS,
  VERIFIED_DSH_RELEASES,
  computeCompositionDigest,
  isCompositionLockConsistent,
  readDependencyClosure,
  resolveComposition,
} from '@hdsl/runtime';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const GOLDEN_CANONICAL =
  '{"dsh":{"arch":"arm64","platform":"darwin","sha256":"' +
  B +
  '","version":"0.1.5-rc.2"},"node":{"arch":"arm64","platform":"darwin","sha256":"' +
  A +
  '","version":"24.21.0"},"plugins":[{"id":"p","sha256":"' +
  C +
  '","version":"1.0.0"}],"schemaVersion":"1"}';

const GOLDEN_DIGEST = 'a0865e778539b5550e64129605df2989b55b20f71f5a1475f34fdb4f6afe9248';

const goldenLock = (url: string): CompositionLock => ({
  schemaVersion: '1',
  node: { version: '24.21.0', platform: 'darwin', arch: 'arm64', sha256: A },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: B },
  plugins: [{ id: 'p', version: '1.0.0', sha256: C }],
  sources: {
    node: { url, sha256: A },
    dsh: { url: 'https://example.invalid/dsh.tgz?signature=1', sha256: B },
  },
});

describe('composition digest', () => {
  it('matches the independently computed golden value', async () => {
    const { serializeCompositionDigestInput } = await import('@hdsl/contracts');
    expect(serializeCompositionDigestInput(goldenLock('https://example.invalid/node.tgz'))).toBe(
      GOLDEN_CANONICAL,
    );
    expect(computeCompositionDigest(goldenLock('https://example.invalid/node.tgz'))).toBe(GOLDEN_DIGEST);
  });

  it('ignores download URLs included in sources', () => {
    const first = computeCompositionDigest(goldenLock('https://mirror.a.invalid/node.tgz'));
    const second = computeCompositionDigest(goldenLock('https://mirror.b.invalid/node.tgz?sig=2'));
    expect(first).toBe(second);
  });

  it('changes when a digest-eligible field changes', () => {
    const base = computeCompositionDigest(goldenLock('https://example.invalid/node.tgz'));
    const other = goldenLock('https://example.invalid/node.tgz');
    const changed: CompositionLock = { ...other, plugins: [] };
    expect(computeCompositionDigest(changed)).not.toBe(base);
  });
});

describe('audited catalog', () => {
  it('lists the verified macOS ARM64 combinations for both supported DSH releases', () => {
    expect(CATALOG_REVISION).toBe('a2-tier2-2026-09-24.1');
    expect(VERIFIED_COMBINATIONS).toHaveLength(4);
    for (const combination of VERIFIED_COMBINATIONS) {
      expect(combination.platform).toBe('darwin');
      expect(combination.arch).toBe('arm64');
      expect(combination.compatibility.status).toBe('verified');
      expect([DSH_VERSION, DSH_VERSION_TIER2]).toContain(combination.dsh.version);
      expect(combination.dsh.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(combination.node.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(combination.artifactLocations.node.url).toMatch(/^https:\/\/nodejs\.org\/dist\//);
      expect(combination.artifactLocations.dsh.url).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      const resolved = resolveComposition(combination);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(isCompositionLockConsistent(resolved.value)).toBe(true);
        expect(computeCompositionDigest(resolved.value)).toMatch(/^[0-9a-f]{64}$/);
        const issues: import('@hdsl/contracts').ValidationIssue[] = [];
        expect(compositionLockSchema(resolved.value, 'lock', issues)).toBeDefined();
      }
    }
    // Baseline combinations stay first with byte-identical ids, then Tier 2.
    expect(VERIFIED_COMBINATIONS.map((entry) => entry.id)).toEqual([
      'darwin-arm64-node22_19_0-dsh0_1_5-rc_2',
      'darwin-arm64-node24_21_0-dsh0_1_5-rc_2',
      'darwin-arm64-node22_19_0-dsh0_1_7-rc_1',
      'darwin-arm64-node24_21_0-dsh0_1_7-rc_1',
    ]);
    expect(VERIFIED_COMBINATIONS.map((entry) => entry.node.version)).toEqual([
      '22.19.0',
      '24.21.0',
      '22.19.0',
      '24.21.0',
    ]);
    const baseline = VERIFIED_COMBINATIONS.filter((entry) => entry.dsh.version === DSH_VERSION);
    expect(baseline).toHaveLength(2);
    for (const combination of baseline) {
      expect(combination.dsh.sha256).toBe(DSH_ARTIFACT_SHA256);
    }
    const tier2 = VERIFIED_COMBINATIONS.filter((entry) => entry.dsh.version === DSH_VERSION_TIER2);
    expect(tier2).toHaveLength(2);
    for (const combination of tier2) {
      expect(combination.dsh.sha256).toBe(DSH_ARTIFACT_SHA256_TIER2);
      expect(combination.artifactLocations.dsh.url).toBe(
        'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.1.tgz',
      );
    }
    expect(VERIFIED_DSH_RELEASES.map((entry) => entry.version)).toEqual([DSH_VERSION, DSH_VERSION_TIER2]);
  });

  it('exposes both supported DSH dependency closures without lock drift', () => {
    const expectedPackageCounts = new Map<string, number>([
      [DSH_VERSION, 585],
      [DSH_VERSION_TIER2, 586],
    ]);
    for (const release of VERIFIED_DSH_RELEASES) {
      const closure = readDependencyClosure(release.version);
      expect(closure, release.version).toBeDefined();
      if (closure === undefined) continue;
      expect(closure.dshVersion).toBe(release.version);
      expect(closure.dshSha256).toBe(release.sha256);
      expect(closure.packageCount).toBe(expectedPackageCounts.get(release.version));
      expect(closure.actualLockSha256).toBe(closure.lockSha256);
      expect(closure.rootResolved).toBe(release.url);
    }
    expect(readDependencyClosure(DSH_VERSION)?.dshSha256).toBe(DSH_ARTIFACT_SHA256);
    expect(readDependencyClosure(DSH_VERSION_TIER2)?.dshSha256).toBe(DSH_ARTIFACT_SHA256_TIER2);
    expect(readDependencyClosure('0.0.0-unknown')).toBeUndefined();
  });
});
