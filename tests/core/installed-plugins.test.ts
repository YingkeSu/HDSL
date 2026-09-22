/**
 * #77 S3: the `plugins.installed` read-only view is bound to the ACTIVE
 * generation's recorded composition (revision/generationId/plugins same-source)
 * and resolves `isBuiltin` from the injected in-box resolver, never from the
 * client or a same-name profile dependency. No state guard: running is allowed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvironmentStore,
  InstalledPluginsService,
  ensureLayout,
  generationPaths,
  resolveLayout,
  type EnvironmentRecord,
} from '@hdsl/core';
import type { CompositionLock } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const GENERATION_ID = 'gen-0000000000000001';

const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value));

const build = (options: { state?: EnvironmentRecord['state']; activeGenerationId?: string | null; inBoxFailure?: boolean } = {}) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-installed-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environments = new EnvironmentStore(layout);
  environments.write({
    schemaVersion: '1',
    id: ENVIRONMENT_ID,
    name: 'installed-env',
    revision: 5,
    stateVersion: 2,
    state: options.state ?? 'stopped',
    activeGenerationId:
      options.activeGenerationId === undefined ? GENERATION_ID : options.activeGenerationId,
    compositionDigest: '0'.repeat(64),
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  });
  if (options.activeGenerationId !== null) {
    const paths = generationPaths(layout, ENVIRONMENT_ID, GENERATION_ID);
    mkdirSync(join(paths.generationDirectory, 'profile'), { recursive: true });
    mkdirSync(paths.dshDirectory, { recursive: true });
    const lock: CompositionLock = {
      schemaVersion: '1',
      node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
      dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
      plugins: [
        { id: '@deepseek-ai/dsh-base', version: '0.1.5-rc.2', sha256: 'd'.repeat(64) },
        { id: 'hdsl-plugin-e2e-fixture', version: '0.0.1', sha256: 'e'.repeat(64) },
      ],
      sources: {
        node: { url: 'https://fixture.invalid/n', sha256: 'a'.repeat(64) },
        dsh: { url: 'https://fixture.invalid/d', sha256: 'b'.repeat(64) },
      },
      pluginSources: {
        'hdsl-plugin-e2e-fixture': {
          sourceKind: 'github',
          repository: { owner: 'YingkeSu', name: 'hdsl-plugin-e2e-fixture' },
          commitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838',
          ref: null,
          packageName: 'hdsl-plugin-e2e-fixture',
          packageVersion: '0.0.1',
          manifestSha256: 'f'.repeat(64),
          closureLockSha256: null,
          isBuiltin: false,
          buildAuthorization: null,
          executor: null,
        },
      },
    };
    writeJson(paths.lockPath, lock);
    writeJson(join(paths.generationDirectory, 'profile', 'package.json'), {
      name: 'dsh-profile-web',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'hdsl-plugin-e2e-fixture'] } },
    });
  }
  const service = new InstalledPluginsService({
    layout,
    environments,
    inBox: {
      resolveInBoxBundles: () =>
        options.inBoxFailure === true ? undefined : [{ name: '@deepseek-ai/dsh-base', version: '0.1.5-rc.2' }],
    },
  });
  return { layout, environments, service };
};

describe('plugins.installed (active-generation composition view)', () => {
  it('lists the active generation composition with in-box/enabled flags and source identity', () => {
    const outcome = build().service.list(ENVIRONMENT_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({ environmentId: ENVIRONMENT_ID, revision: 5, generationId: GENERATION_ID });
    expect(outcome.value.plugins[0]).toMatchObject({ id: '@deepseek-ai/dsh-base', isBuiltin: true, enabledBundle: true, source: null });
    expect(outcome.value.plugins[1]).toMatchObject({
      id: 'hdsl-plugin-e2e-fixture',
      isBuiltin: false,
      enabledBundle: true,
      source: { owner: 'YingkeSu', name: 'hdsl-plugin-e2e-fixture', commitSha: 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838' },
    });
  });

  it('never reports ENVIRONMENT_BUSY: a running environment is still listable', () => {
    const outcome = build({ state: 'running' }).service.list(ENVIRONMENT_ID);
    expect(outcome.ok).toBe(true);
  });

  it('returns an empty view (no fabricated generation id) before any generation is committed', () => {
    const outcome = build({ activeGenerationId: null }).service.list(ENVIRONMENT_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({ environmentId: ENVIRONMENT_ID, revision: 5, generationId: null, plugins: [] });
  });

  it('fails closed when the in-box set cannot be proven, and NOT_FOUND for an unknown environment', () => {
    const unavailable = build({ inBoxFailure: true }).service.list(ENVIRONMENT_ID);
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.code).toBe('INTERNAL_ERROR');

    const unknown = build().service.list('env-ffffffffffffffff');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('NOT_FOUND');
  });
});
