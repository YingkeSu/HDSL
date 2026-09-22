/**
 * ADR 0006 / S2 §1.1 first-time home + data migration: data-safety regressions.
 *
 * These are the merge-gate scenarios from review 5775104191: target conflict
 * fail-closed, missing/truncated published copy keeps the legacy source, data
 * migration, recover() process/state gating, and secret-mode preservation.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HomeMigrationStore,
  createManagedInstall,
  environmentPaths,
  generationPaths,
  managedProfileName,
  migrateEnvironmentHome,
  resolveLayout,
  treeFingerprint,
} from '@hdsl/core';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0123456789abcdef';
const GENERATION_ID = 'gen-0123456789abcdef';
const SECRET = 'version: 1\nclient-connection: migration-sentinel\n';

const build = () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-home-migration-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  const env = environmentPaths(layout, ENVIRONMENT_ID);
  mkdirSync(env.environmentDirectory, { recursive: true });
  const paths = generationPaths(layout, ENVIRONMENT_ID, GENERATION_ID);
  mkdirSync(paths.generationDirectory, { recursive: true });
  return { dataRoot, layout, paths, env };
};

const writeLegacyTree = (dir: string): void => {
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', 's.json'), '{"session":1}');
  writeFileSync(join(dir, '.credentials.yaml'), SECRET, { mode: 0o600 });
  chmodSync(join(dir, '.credentials.yaml'), 0o600);
};

const migrate = (
  layout: ReturnType<typeof resolveLayout>,
  faults: Record<string, boolean> = {},
  generationId: string = GENERATION_ID,
) =>
  migrateEnvironmentHome({
    layout,
    environmentId: ENVIRONMENT_ID,
    activeGenerationId: generationId,
    faults,
  });

describe('environment-scoped home + data migration', () => {
  it('finalizes an empty environment without creating or touching any home', () => {
    const { layout } = build();
    const result = migrateEnvironmentHome({
      layout,
      environmentId: ENVIRONMENT_ID,
      activeGenerationId: null,
    });
    expect(result.state).toBe('finalized');
    expect(existsSync(environmentPaths(layout, ENVIRONMENT_ID).homeDirectory)).toBe(false);
  });

  it('migrates home AND data, preserves the secret mode, and removes the legacy trees', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    writeLegacyTree(paths.legacyDataDirectory);

    const result = migrate(layout);
    expect(result.state).toBe('finalized');
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(env.dataDirectory)).toBe(true);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(false);
    expect(existsSync(paths.legacyDataDirectory)).toBe(false);
    for (const root of [env.homeDirectory, env.dataDirectory]) {
      const secret = join(root, '.credentials.yaml');
      expect(readFileSync(secret, 'utf8')).toBe(SECRET);
      expect(statSync(secret).mode & 0o777).toBe(0o600);
    }
    expect(new HomeMigrationStore(layout).read(ENVIRONMENT_ID, 'home')?.state).toBe('finalized');
    expect(new HomeMigrationStore(layout).read(ENVIRONMENT_ID, 'data')?.state).toBe('finalized');
  });

  it('copies symlinks as links and never follows content outside the legacy tree', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    const externalRoot = mkdtempSync(join(tmpdir(), 'hdsl-home-external-'));
    roots.push(externalRoot);
    const externalFile = join(externalRoot, 'outside.txt');
    writeFileSync(externalFile, 'OUTSIDE');
    symlinkSync(externalFile, join(paths.legacyHomeDirectory, 'external-link'));

    const sym = migrate(layout);
    expect(sym.state, JSON.stringify(sym)).toBe('finalized');
    const copied = join(env.homeDirectory, 'external-link');
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    // The link target string is preserved; the external content is untouched.
    expect(readlinkSync(copied)).toBe(externalFile);
    expect(readFileSync(externalFile, 'utf8')).toBe('OUTSIDE');
  });

  it('is idempotent and never overwrites an already-finalized published tree', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    migrate(layout);
    writeFileSync(join(env.homeDirectory, 'sessions', 'after.json'), '{}');
    const second = migrate(layout);
    expect(second.state).toBe('finalized');
    expect(existsSync(join(env.homeDirectory, 'sessions', 'after.json'))).toBe(true);
  });

  it('fails closed when a pre-existing target is not a migration product', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    mkdirSync(join(env.homeDirectory, 'sessions'), { recursive: true });
    writeFileSync(join(env.homeDirectory, 'sessions', 'newer.json'), '{"newer":true}');

    const result = migrate(layout);
    expect(result.state).toBe('conflict');
    expect(result.conflict?.kind).toBe('home');
    // Neither the foreign target nor the legacy source may be destroyed.
    expect(readFileSync(join(env.homeDirectory, 'sessions', 'newer.json'), 'utf8')).toBe('{"newer":true}');
    expect(existsSync(paths.legacyHomeDirectory)).toBe(true);
  });

  it('keeps the legacy source when a recorded published copy is missing, then republishes', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    // Simulate a crash after publish by seeding the record and no target.
    const store = new HomeMigrationStore(layout);
    store.write({
      schemaVersion: '1',
      environmentId: ENVIRONMENT_ID,
      kind: 'home',
      sourceGenerationId: GENERATION_ID,
      state: 'copied',
      sourceDigest: fingerprint(paths.legacyHomeDirectory),
      publishedDigest: fingerprint(paths.legacyHomeDirectory),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = migrate(layout);
    expect(result.state).toBe('finalized');
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(false);
    expect(readFileSync(join(env.homeDirectory, 'sessions', 's.json'), 'utf8')).toBe('{"session":1}');
  });

  it('refuses to delete the legacy source when the published copy is lost/truncated', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    const first = migrate(layout, { corruptPublished: true });
    expect(first.state).toBe('conflict');
    // Legacy is still the only intact copy.
    expect(existsSync(paths.legacyHomeDirectory)).toBe(true);
    expect(readFileSync(join(paths.legacyHomeDirectory, 'sessions', 's.json'), 'utf8')).toBe('{"session":1}');

    // A later run converges from the verified legacy source.
    const second = migrate(layout);
    expect(second.state).toBe('finalized');
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(false);
  });

  it('keeps the legacy source when the published copy is truncated (foreign digest)', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    // Seed a `copied` record then create a target with the wrong contents.
    const store = new HomeMigrationStore(layout);
    store.write({
      schemaVersion: '1',
      environmentId: ENVIRONMENT_ID,
      kind: 'home',
      sourceGenerationId: GENERATION_ID,
      state: 'copied',
      sourceDigest: fingerprint(paths.legacyHomeDirectory),
      publishedDigest: fingerprint(paths.legacyHomeDirectory),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mkdirSync(env.homeDirectory, { recursive: true });
    writeFileSync(join(env.homeDirectory, 'truncated'), 'x');

    const result = migrate(layout);
    expect(result.state).toBe('conflict');
    expect(existsSync(paths.legacyHomeDirectory)).toBe(true);
    expect(existsSync(join(paths.legacyHomeDirectory, 'sessions', 's.json'))).toBe(true);
  });

  it('converges a crash between the publish rename and the copied record (home and data)', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    writeLegacyTree(paths.legacyDataDirectory);

    const first = migrate(layout, { failAfterRename: true });
    expect(first.state).toBe('interrupted');
    // The rename published the home target, but the record is still `copying`
    // with the expected published digest persisted; the legacy source is intact.
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(true);
    const record = new HomeMigrationStore(layout).read(ENVIRONMENT_ID, 'home');
    expect(record?.state).toBe('copying');
    expect(record?.publishedDigest).not.toBeNull();

    const second = migrate(layout);
    expect(second.state).toBe('finalized');
    expect(existsSync(paths.legacyHomeDirectory)).toBe(false);
    expect(existsSync(paths.legacyDataDirectory)).toBe(false);
    expect(readFileSync(join(env.homeDirectory, 'sessions', 's.json'), 'utf8')).toBe('{"session":1}');
    expect(readFileSync(join(env.dataDirectory, 'sessions', 's.json'), 'utf8')).toBe('{"session":1}');
  });

  it('converges a legacy null-publishedDigest copying record when the target equals the verified source', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    // Reproduce the pre-fix crash state: target published, record `copying`, no
    // publishedDigest persisted (older build).
    cpSync(paths.legacyHomeDirectory, env.homeDirectory, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    new HomeMigrationStore(layout).write({
      schemaVersion: '1',
      environmentId: ENVIRONMENT_ID,
      kind: 'home',
      sourceGenerationId: GENERATION_ID,
      state: 'copying',
      sourceDigest: fingerprint(paths.legacyHomeDirectory),
      publishedDigest: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(migrate(layout).state).toBe('finalized');
    expect(existsSync(paths.legacyHomeDirectory)).toBe(false);
    expect(readFileSync(join(env.homeDirectory, 'sessions', 's.json'), 'utf8')).toBe('{"session":1}');
  });

  it('resumes after a crash before publish without leaving a partial target', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    const interrupted = migrate(layout, { failAfterCopy: true });
    expect(interrupted.state).toBe('interrupted');
    expect(existsSync(env.homeDirectory)).toBe(false);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(true);

    const resumed = migrate(layout);
    expect(resumed.state).toBe('finalized');
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(false);
  });

  it('resumes after a crash after publish (legacy then removed)', () => {
    const { layout, paths, env } = build();
    writeLegacyTree(paths.legacyHomeDirectory);
    const interrupted = migrate(layout, { failAfterPublish: true });
    expect(interrupted.state).toBe('interrupted');
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(true);

    const resumed = migrate(layout);
    expect(resumed.state).toBe('finalized');
    expect(existsSync(paths.legacyHomeDirectory)).toBe(false);
  });
});

// Local alias to avoid importing the digest helper into the public surface here.
const fingerprint = (root: string): string => treeFingerprint(root) ?? '';

describe('recover() migration gating (ADR 0006 requirement 4)', () => {
  const buildEnvironment = (state: 'running' | 'starting' | 'stopping' | 'stopped') => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-home-gating-'));
    roots.push(dataRoot);
    const layout = resolveLayout(dataRoot);
    const env = environmentPaths(layout, ENVIRONMENT_ID);
    mkdirSync(env.environmentDirectory, { recursive: true });
    const paths = generationPaths(layout, ENVIRONMENT_ID, GENERATION_ID);
    mkdirSync(paths.generationDirectory, { recursive: true });
    writeLegacyTree(paths.legacyHomeDirectory);
    writeFileSync(
      join(env.environmentDirectory, 'environment.json'),
      JSON.stringify({
        schemaVersion: '1',
        id: ENVIRONMENT_ID,
        name: 'gating',
        revision: 1,
        stateVersion: 1,
        state,
        activeGenerationId: GENERATION_ID,
        compositionDigest: 'a'.repeat(64),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      paths.manifestPath,
      JSON.stringify({
        schemaVersion: '1',
        installMode: 'artifacts-only',
        catalogRevision: 'test',
        compositionDigest: 'a'.repeat(64),
        node: { version: '22.19.0', sha256: 'b'.repeat(64), executable: 'node/bin/node' },
        dsh: {
          version: '0.1.5-rc.2',
          sha256: 'c'.repeat(64),
          entrypoint: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
          treeDigest: 'd'.repeat(64),
        },
        closure: null,
        preflight: { skipped: true, passed: false, checks: [], reason: 'fixture' },
        installedAt: new Date().toISOString(),
      }),
    );
    return { dataRoot, layout, paths, env };
  };

  const fakeProcess = (resolution: 'no-process' | 'adopted' | 'unverifiable') => ({
    start: async () => ({ ok: false, code: 'INTERNAL_ERROR', message: 'not used' }),
    stop: async () => ({ ok: true, value: { wasRunning: true } }),
    openWebUI: () => ({ ok: false, code: 'INTERNAL_ERROR', message: 'not used' }),
    recover: async () => ({ entries: [{ environmentId: ENVIRONMENT_ID, resolution }] }),
    close: async () => ({ ok: true, value: undefined }),
  });

  const fakeRuntime = () => ({
    resolveComposition: () => ({ ok: false, code: 'INTERNAL_ERROR', message: 'not used' }),
    compositionDigest: () => 'a'.repeat(64),
    install: async () => ({ ok: false, code: 'INTERNAL_ERROR', message: 'not used' }),
  });

  const openService = async (dataRoot: string, resolution: 'no-process' | 'adopted' | 'unverifiable') => {
    const managed = await createManagedInstall({
      dataRoot,
      catalog: [],
      runtime: fakeRuntime() as never,
      process: fakeProcess(resolution) as never,
      allowArtifactsOnly: true,
    });
    return managed;
  };

  it('skips migration while the environment is running (owned process) and keeps stop available', async () => {
    const { dataRoot, paths, env } = buildEnvironment('running');
    const managed = await openService(dataRoot, 'adopted');
    await managed.recover();
    expect(existsSync(paths.legacyHomeDirectory)).toBe(true);
    expect(existsSync(env.homeDirectory)).toBe(false);

    const start = managed.service.startEnvironment({
      requestId: 'req-start',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 1,
    });
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.code).toBe('ENVIRONMENT_BUSY');

    const stop = managed.service.stopEnvironment({
      requestId: 'req-stop',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 1,
    });
    expect(stop.ok).toBe(true);
    await managed.close();
  });

  it('skips migration when the record was running/starting/stopping before reconciliation', async () => {
    for (const state of ['running', 'starting', 'stopping'] as const) {
      const { dataRoot, paths, env } = buildEnvironment(state);
      const managed = await openService(dataRoot, 'no-process');
      await managed.recover();
      expect(existsSync(paths.legacyHomeDirectory)).toBe(true);
      expect(existsSync(env.homeDirectory)).toBe(false);
      await managed.close();
    }
  });

  it('skips migration when a process cannot be proven stopped (adopted/unverifiable)', async () => {
    for (const resolution of ['adopted', 'unverifiable'] as const) {
      const { dataRoot, paths, env } = buildEnvironment('stopped');
      const managed = await openService(dataRoot, resolution);
      await managed.recover();
      expect(existsSync(paths.legacyHomeDirectory)).toBe(true);
      expect(existsSync(env.homeDirectory)).toBe(false);
      await managed.close();
    }
  });

  it('migrates when no process is owned and the environment is stopped', async () => {
    const { dataRoot, paths, env } = buildEnvironment('stopped');
    const managed = await openService(dataRoot, 'no-process');
    await managed.recover();
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(false);
    await managed.close();
  });

  it('records a path- and secret-free recovery detail on a migration conflict', async () => {    const { dataRoot, paths, env } = buildEnvironment('stopped');
    // Foreign pre-existing target: migration must fail closed and be explained.
    mkdirSync(join(env.homeDirectory, 'sessions'), { recursive: true });
    writeFileSync(join(env.homeDirectory, 'sessions', 'newer.json'), '{"newer":true}');

    const managed = await openService(dataRoot, 'no-process');
    const report = await managed.recover();
    const conflict = report.details.find((detail) =>
      detail.reason?.startsWith('home-migration-conflict'),
    );
    expect(conflict).toBeDefined();
    expect(conflict?.resolution).toBe('failed');
    expect(JSON.stringify(report.details)).not.toContain(dataRoot);
    expect(existsSync(paths.legacyHomeDirectory)).toBe(true);
    await managed.close();
  });

  it('does not auto-GC any managed-namespace profile during recover (MF1)', async () => {
    const { dataRoot, layout } = buildEnvironment('stopped');
    const managed = await openService(dataRoot, 'no-process');
    await managed.recover();
    const profiles = environmentPaths(layout, ENVIRONMENT_ID).profilesDirectory;
    mkdirSync(join(profiles, 'hdsl-foreign'), { recursive: true });
    mkdirSync(join(profiles, managedProfileName(GENERATION_ID)), { recursive: true });

    await managed.recover();
    // No prefix/retain inference: unrelated and just-created managed profiles stay.
    expect(existsSync(join(profiles, 'hdsl-foreign'))).toBe(true);
    expect(existsSync(join(profiles, managedProfileName(GENERATION_ID)))).toBe(true);
    await managed.close();
  });
});
