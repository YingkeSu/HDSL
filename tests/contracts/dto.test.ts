/**
 * DTO schema checks: strict shapes, nullable/optional fields and the
 * composition-digest subset that must exclude download URLs (issue #15 N3).
 */
import {
  canonicalizeJson,
  compositionDigestInput,
  compositionLockSchema,
  environmentSummarySchema,
  exportResultSchema,
  runtimeArtifactRefSchema,
  runtimeCombinationSchema,
  serializeCompositionDigestInput,
  operationSnapshotSchema,
  type CompositionLock,
  type RuntimeArtifactRef,
  type Schema,
  type ValidationIssue,
} from '@hdsl/contracts';
import { describe, expect, it } from 'vitest';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const parse = <T>(schema: Schema<T>, value: unknown): { value: T | undefined; issues: ValidationIssue[] } => {
  const issues: ValidationIssue[] = [];
  const parsed = schema(value, 'value', issues);
  return { value: parsed, issues };
};

const ref = (sha256: string): RuntimeArtifactRef => ({
  version: '24.21.0',
  platform: 'darwin',
  arch: 'arm64',
  sha256,
});

const lock = (nodeUrl: string): CompositionLock => ({
  schemaVersion: '1',
  node: ref(SHA_A),
  dsh: ref(SHA_B),
  plugins: [],
  sources: {
    node: { url: nodeUrl, sha256: SHA_A },
    dsh: { url: 'https://example.invalid/dsh.tgz', sha256: SHA_B },
  },
});

describe('composition lock and digest subset', () => {
  it('accepts a lock that retains download provenance in sources', () => {
    const { value, issues } = parse(compositionLockSchema, lock('https://example.invalid/node.tgz'));
    expect(issues).toEqual([]);
    expect(value?.sources.node.url).toBe('https://example.invalid/node.tgz');
  });

  it('keeps the URL out of the digest input while retaining it on the lock', () => {
    const first = lock('https://example.invalid/node-a.tgz');
    const second = lock('https://cdn.example.invalid/other/node-b.tgz?signature=xyz');

    const input = compositionDigestInput(first);
    expect(Object.keys(input).sort()).toEqual(['dsh', 'node', 'plugins', 'schemaVersion']);
    expect(JSON.stringify(input)).not.toContain('example.invalid');
    expect(serializeCompositionDigestInput(first)).toBe(serializeCompositionDigestInput(second));
    expect(first.sources.node.url).not.toBe(second.sources.node.url);
  });

  it('rejects a URL on RuntimeArtifactRef', () => {
    const { value, issues } = parse(runtimeArtifactRefSchema, {
      ...ref(SHA_A),
      url: 'https://example.invalid/node.tgz',
    });
    expect(value).toBeUndefined();
    expect(issues.some((issue) => issue.path === 'value.url' && issue.message === 'unknown field')).toBe(
      true,
    );
  });

  it('serializes canonical JSON independently of key order', () => {
    expect(canonicalizeJson({ b: 1, a: { d: 2, c: [3, 1] } })).toBe(
      '{"a":{"c":[3,1],"d":2},"b":1}',
    );
  });
});

describe('shared DTO schemas', () => {
  it('validates a RuntimeCombination with parallel artifact locations', () => {
    const combination = {
      id: 'combo-darwin-arm64',
      platform: 'darwin',
      arch: 'arm64',
      node: ref(SHA_A),
      dsh: ref(SHA_B),
      compatibility: { status: 'verified', evidenceRef: 'docs/research/dsh-compatibility.md' },
      artifactLocations: {
        node: {
          version: '24.21.0',
          platform: 'darwin',
          arch: 'arm64',
          url: 'https://example.invalid/node.tgz',
          sha256: SHA_A,
        },
        dsh: {
          version: '0.1.5-rc.2',
          platform: 'darwin',
          arch: 'arm64',
          url: 'https://example.invalid/dsh.tgz',
          sha256: SHA_B,
        },
      },
    };
    const { value, issues } = parse(runtimeCombinationSchema, combination);
    expect(issues).toEqual([]);
    expect(value?.artifactLocations.node.sha256).toBe(SHA_A);
  });

  it('validates an EnvironmentSummary and rejects local-path-like secrets', () => {
    const summary = {
      id: 'env-1',
      name: 'Work env',
      revision: 2,
      stateVersion: 3,
      state: 'running',
      activeGenerationId: 'gen-1',
      compositionDigest: SHA_A,
    };
    expect(parse(environmentSummarySchema, summary).issues).toEqual([]);
    expect(parse(environmentSummarySchema, { ...summary, activeGenerationId: null }).issues).toEqual(
      [],
    );
    const extra = parse(environmentSummarySchema, { ...summary, workspacePath: '/Users/alice' });
    expect(extra.value).toBeUndefined();
    expect(extra.issues.some((issue) => issue.message === 'unknown field')).toBe(true);
  });

  it('validates an OperationSnapshot with optional progress and error', () => {
    const base = {
      id: 'op-1',
      environmentId: 'env-1',
      kind: 'start',
      phase: 'running',
      status: 'running',
      sequence: 2,
    };
    expect(parse(operationSnapshotSchema, base).issues).toEqual([]);
    expect(parse(operationSnapshotSchema, { ...base, progress: 40 }).value).toMatchObject({
      progress: 40,
    });
    expect(parse(operationSnapshotSchema, { ...base, progress: 140 }).value).toBeUndefined();
    expect(
      parse(operationSnapshotSchema, { ...base, environmentId: null }).issues,
    ).toEqual([]);
  });

  it('requires the ExportResult summary to claim a redacted export', () => {
    expect(parse(exportResultSchema, { exportId: 'export-1', exported: true, redacted: true }).issues).toEqual(
      [],
    );
    expect(
      parse(exportResultSchema, { exportId: 'export-1', exported: true, redacted: false }).value,
    ).toBeUndefined();
    expect(
      parse(exportResultSchema, { exportId: 'export-1', exported: false, redacted: true }).value,
    ).toBeUndefined();
  });
});
