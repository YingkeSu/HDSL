/**
 * ADR 0006 / S2 §1.1 first-time home migration: environment-scoped home,
 * crash-safe copy, secret lifecycle, and idempotent resume.
 *
 * Real filesystem, real flag store; the injected faults abort between the
 * durable states a crash could split.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HomeMigrationStore,
  environmentPaths,
  generationPaths,
  migrateEnvironmentHome,
  resolveLayout,
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

const build = (): { layout: ReturnType<typeof resolveLayout>; environmentId: string; generationId: string } => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-home-migration-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  const env = environmentPaths(layout, ENVIRONMENT_ID);
  mkdirSync(env.environmentDirectory, { recursive: true });
  const paths = generationPaths(layout, ENVIRONMENT_ID, GENERATION_ID);
  mkdirSync(paths.generationDirectory, { recursive: true });
  return { layout, environmentId: ENVIRONMENT_ID, generationId: GENERATION_ID };
};

const writeLegacyHome = (layout: ReturnType<typeof resolveLayout>, generationId: string): string => {
  const paths = generationPaths(layout, ENVIRONMENT_ID, generationId);
  mkdirSync(join(paths.legacyHomeDirectory, 'sessions'), { recursive: true });
  mkdirSync(join(paths.legacyHomeDirectory, 'storages'), { recursive: true });
  writeFileSync(join(paths.legacyHomeDirectory, 'sessions', 's.json'), '{"session":1}');
  writeFileSync(join(paths.legacyHomeDirectory, '.credentials.yaml'), SECRET, { mode: 0o600 });
  chmodSync(join(paths.legacyHomeDirectory, '.credentials.yaml'), 0o600);
  return paths.legacyHomeDirectory;
};

const migrate = (layout: ReturnType<typeof resolveLayout>, generationId: string, faults = {}) =>
  migrateEnvironmentHome({ layout, environmentId: ENVIRONMENT_ID, activeGenerationId: generationId, faults });

describe('environment-scoped home migration', () => {
  it('finalizes an empty environment without touching any home', () => {
    const { layout } = build();
    const result = migrateEnvironmentHome({
      layout,
      environmentId: ENVIRONMENT_ID,
      activeGenerationId: null,
    });
    expect(result.state).toBe('finalized');
    expect(new HomeMigrationStore(layout).read(ENVIRONMENT_ID)?.state).toBe('finalized');
    expect(existsSync(environmentPaths(layout, ENVIRONMENT_ID).homeDirectory)).toBe(false);
  });

  it('migrates the legacy home, preserves the secret mode, and removes the legacy copy', () => {
    const { layout, generationId } = build();
    const legacy = writeLegacyHome(layout, generationId);
    const env = environmentPaths(layout, ENVIRONMENT_ID);

    const result = migrate(layout, generationId);
    expect(result.state).toBe('finalized');
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(env.homeDirectory, 'sessions', 's.json'), 'utf8')).toBe('{"session":1}');
    const secretPath = join(env.homeDirectory, '.credentials.yaml');
    expect(readFileSync(secretPath, 'utf8')).toBe(SECRET);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(new HomeMigrationStore(layout).read(ENVIRONMENT_ID)?.state).toBe('finalized');
  });

  it('is idempotent: a second run reports already-finalized and does not re-copy', () => {
    const { layout, generationId } = build();
    writeLegacyHome(layout, generationId);
    migrate(layout, generationId);
    const env = environmentPaths(layout, ENVIRONMENT_ID);
    writeFileSync(join(env.homeDirectory, 'sessions', 'after.json'), '{}');
    const second = migrate(layout, generationId);
    expect(second.state).toBe('already-finalized');
    expect(existsSync(join(env.homeDirectory, 'sessions', 'after.json'))).toBe(true);
  });

  it('recovers a crash after copy but before publish (legacy intact, then finalized)', () => {
    const { layout, generationId } = build();
    const legacy = writeLegacyHome(layout, generationId);
    const env = environmentPaths(layout, ENVIRONMENT_ID);
    const interrupted = migrate(layout, generationId, { failAfterCopy: true });
    expect(interrupted.state).toBe('interrupted');
    // Nothing published yet; the legacy home is still the only source.
    expect(existsSync(env.homeDirectory)).toBe(false);
    expect(existsSync(legacy)).toBe(true);

    const resumed = migrate(layout, generationId);
    expect(resumed.state).toBe('finalized');
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(env.homeDirectory, 'sessions', 's.json'), 'utf8')).toBe('{"session":1}');
  });

  it('recovers a crash after publish (published copy kept, legacy then removed)', () => {
    const { layout, generationId } = build();
    const legacy = writeLegacyHome(layout, generationId);
    const env = environmentPaths(layout, ENVIRONMENT_ID);
    const interrupted = migrate(layout, generationId, { failAfterPublish: true });
    expect(interrupted.state).toBe('interrupted');
    expect(existsSync(env.homeDirectory)).toBe(true);
    expect(existsSync(legacy)).toBe(true);

    const resumed = migrate(layout, generationId);
    expect(resumed.state).toBe('finalized');
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(env.homeDirectory, '.credentials.yaml'), 'utf8')).toBe(SECRET);
  });
});
