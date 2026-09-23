/**
 * `generations.restore` DSH-version compatibility warning (issue #114 / A2,
 * D5/D6): a NON-BLOCKING downgrade hint derived from the environment's last
 * successfully started DSH version. Same version (the Node-only axis) and an
 * unknown version on either side never warn; the restore itself always
 * completes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangeApplyService,
  ChangePlanStore,
  EnvironmentStore,
  OperationStore,
  ensureLayout,
  generationPaths,
  resolveLayout,
  type EnvironmentRecord,
} from '@hdsl/core';
import { createGenerationRuntimeVerifier, sha256TreeDigestSync } from '@hdsl/runtime';
import type { CompositionLock, GenerationSummary } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const GEN_OLD = 'gen-0000000000000001';
const GEN_NEW = 'gen-0000000000000002';

const lock = (): CompositionLock => ({
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [],
  sources: {
    node: { url: 'https://x/n', sha256: 'a'.repeat(64) },
    dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) },
  },
});

const writeGeneration = (
  layout: ReturnType<typeof resolveLayout>,
  generationId: string,
  digest: string,
  dshVersion: string,
): void => {
  const paths = generationPaths(layout, ENVIRONMENT_ID, generationId);
  mkdirSync(join(paths.nodeDirectory, 'bin'), { recursive: true });
  mkdirSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(paths.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  writeFileSync(
    join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'bin.js'),
    `// ${generationId}\n`,
  );
  writeFileSync(
    paths.manifestPath,
    JSON.stringify({
      schemaVersion: '1',
      installMode: 'npm-ci',
      node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(paths.nodeDirectory) },
      dsh: {
        version: dshVersion,
        treeDigest: sha256TreeDigestSync(join(paths.dshDirectory, 'node_modules', '@deepseek-ai', 'dsh')),
      },
    }),
  );
  writeFileSync(paths.lockPath, JSON.stringify(lock()));
  writeFileSync(
    paths.generationRecordPath,
    JSON.stringify({
      id: generationId,
      environmentId: ENVIRONMENT_ID,
      compositionDigest: digest,
      dshVersion,
      createdAt: '2026-09-22T00:00:00.000Z',
      profileName: `hdsl-${generationId}`,
    }),
  );
  const profile = join(paths.generationDirectory, 'profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['b'] } } }),
  );
  writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
};

interface BuildOptions {
  readonly activeGenerationId: string;
  readonly activeDigest: string;
  readonly lastStartedGenerationId?: string | null;
  readonly lastStartedDshVersion?: string | null;
  readonly generations: readonly {
    readonly id: string;
    readonly digest: string;
    readonly dshVersion: string;
  }[];
}

const build = (options: BuildOptions) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-restore-warning-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  const now = '2026-09-22T00:05:00.000Z';
  const record: EnvironmentRecord = {
    schemaVersion: '1',
    id: ENVIRONMENT_ID,
    name: 'restore-warning-env',
    revision: 2,
    stateVersion: 2,
    state: 'stopped',
    activeGenerationId: options.activeGenerationId,
    compositionDigest: options.activeDigest,
    lastStartedGenerationId: options.lastStartedGenerationId ?? null,
    lastStartedDshVersion: options.lastStartedDshVersion ?? null,
    createdAt: now,
    updatedAt: now,
  };
  environments.write(record);
  for (const generation of options.generations) {
    writeGeneration(layout, generation.id, generation.digest, generation.dshVersion);
  }
  const service = new ChangeApplyService({
    layout,
    plans: new ChangePlanStore(layout),
    environments,
    operations: new OperationStore(layout),
    compositionDigest: (l) => JSON.stringify(l.plugins),
    verifyGenerationRuntime: createGenerationRuntimeVerifier(),
    now: () => new Date(now),
  });
  return { layout, environments, operations: new OperationStore(layout), service };
};

const restore = (service: ChangeApplyService, targetGenerationId: string, requestId = 'req-restore') => {
  const outcome = service.restoreGeneration({
    requestId,
    environmentId: ENVIRONMENT_ID,
    expectedRevision: 2,
    targetGenerationId,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    throw new Error('expected the restore to start');
  }
  return outcome.value.operationId;
};

const warningOf = (
  operations: OperationStore,
  operationId: string,
): string | null | undefined => {
  const record = operations.read(operationId);
  const output = record?.output as GenerationSummary | undefined;
  return output?.dshCompatibilityWarning;
};

describe('generations.restore: DSH compatibility warning', () => {
  it('warns (non-blocking) when the target DSH version is older than the last started version', () => {
    const { environments, operations, service } = build({
      activeGenerationId: GEN_NEW,
      activeDigest: '2'.repeat(64),
      lastStartedGenerationId: GEN_NEW,
      lastStartedDshVersion: '0.1.6',
      generations: [
        { id: GEN_OLD, digest: '1'.repeat(64), dshVersion: '0.1.5-rc.2' },
        { id: GEN_NEW, digest: '2'.repeat(64), dshVersion: '0.1.6' },
      ],
    });
    const operationId = restore(service, GEN_OLD);
    const warning = warningOf(operations, operationId);
    expect(typeof warning).toBe('string');
    expect(warning).toContain('0.1.5-rc.2');
    expect(warning).toContain('0.1.6');
    // Non-blocking: the pointer still moved and nothing was undone.
    const environment = environments.read(ENVIRONMENT_ID);
    expect(environment?.activeGenerationId).toBe(GEN_OLD);
    expect(environment?.revision).toBe(3);
  });

  it('does not warn on the Node-only axis (same DSH version)', () => {
    const { operations, service } = build({
      activeGenerationId: GEN_NEW,
      activeDigest: '2'.repeat(64),
      lastStartedGenerationId: GEN_NEW,
      lastStartedDshVersion: '0.1.5-rc.2',
      generations: [
        { id: GEN_OLD, digest: '1'.repeat(64), dshVersion: '0.1.5-rc.2' },
        { id: GEN_NEW, digest: '2'.repeat(64), dshVersion: '0.1.5-rc.2' },
      ],
    });
    expect(warningOf(operations, restore(service, GEN_OLD))).toBeNull();
  });

  it('does not warn when upgrading, and does not warn when the last started version is unknown', () => {
    const upgrading = build({
      activeGenerationId: GEN_OLD,
      activeDigest: '1'.repeat(64),
      lastStartedGenerationId: GEN_OLD,
      lastStartedDshVersion: '0.1.5-rc.2',
      generations: [
        { id: GEN_OLD, digest: '1'.repeat(64), dshVersion: '0.1.5-rc.2' },
        { id: GEN_NEW, digest: '2'.repeat(64), dshVersion: '0.1.6' },
      ],
    });
    expect(warningOf(upgrading.operations, restore(upgrading.service, GEN_NEW, 'req-up'))).toBeNull();

    const unknown = build({
      activeGenerationId: GEN_NEW,
      activeDigest: '2'.repeat(64),
      generations: [
        { id: GEN_OLD, digest: '1'.repeat(64), dshVersion: '0.1.5-rc.2' },
        { id: GEN_NEW, digest: '2'.repeat(64), dshVersion: '0.1.6' },
      ],
    });
    expect(warningOf(unknown.operations, restore(unknown.service, GEN_OLD, 'req-unknown'))).toBeNull();
  });

  it('carries the warning on the idempotent no-op path too, without moving the revision', () => {
    const { environments, operations, service } = build({
      activeGenerationId: GEN_OLD,
      activeDigest: '1'.repeat(64),
      lastStartedGenerationId: GEN_NEW,
      lastStartedDshVersion: '0.1.6',
      generations: [
        { id: GEN_OLD, digest: '1'.repeat(64), dshVersion: '0.1.5-rc.2' },
        { id: GEN_NEW, digest: '2'.repeat(64), dshVersion: '0.1.6' },
      ],
    });
    const operationId = restore(service, GEN_OLD, 'req-noop');
    expect(typeof warningOf(operations, operationId)).toBe('string');
    expect(environments.read(ENVIRONMENT_ID)?.revision).toBe(2);
  });

  it('refuses a restore while a core switch transaction journal is unresolved', () => {
    const { layout, service } = build({
      activeGenerationId: GEN_NEW,
      activeDigest: '2'.repeat(64),
      generations: [
        { id: GEN_OLD, digest: '1'.repeat(64), dshVersion: '0.1.5-rc.2' },
        { id: GEN_NEW, digest: '2'.repeat(64), dshVersion: '0.1.6' },
      ],
    });
    mkdirSync(layout.transactions, { recursive: true });
    writeFileSync(
      join(layout.transactions, 'txn-00000000000000sw.json'),
      JSON.stringify({ schemaVersion: '1', kind: 'switch', environmentId: ENVIRONMENT_ID }),
    );
    const outcome = service.restoreGeneration({
      requestId: 'req-blocked-by-switch',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 2,
      targetGenerationId: GEN_OLD,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('ENVIRONMENT_BUSY');
    }
  });

  it('reads a generation DSH version from the install manifest when generation.json omits it', () => {
    const { operations, service, layout } = build({
      activeGenerationId: GEN_NEW,
      activeDigest: '2'.repeat(64),
      lastStartedGenerationId: GEN_NEW,
      lastStartedDshVersion: '0.1.6',
      generations: [
        { id: GEN_OLD, digest: '1'.repeat(64), dshVersion: '0.1.5-rc.2' },
        { id: GEN_NEW, digest: '2'.repeat(64), dshVersion: '0.1.6' },
      ],
    });
    // Drop the additive field to emulate a record written by an older build; the
    // manifest still pins the same DSH version.
    const paths = generationPaths(layout, ENVIRONMENT_ID, GEN_OLD);
    const record = JSON.parse(readFileSync(paths.generationRecordPath, 'utf8')) as Record<string, unknown>;
    delete record['dshVersion'];
    writeFileSync(paths.generationRecordPath, JSON.stringify(record));
    expect(existsSync(paths.manifestPath)).toBe(true);
    expect(typeof warningOf(operations, restore(service, GEN_OLD, 'req-manifest-fallback'))).toBe('string');
  });
});
