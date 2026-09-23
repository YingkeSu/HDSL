/**
 * #135 E1-T1: core desired-config entry patch service.
 *
 * It proves the core-owned routing and guards against a REAL temporary data
 * root and the REAL runtime adapter: the write target is the environment-shared
 * home patch, the published profile's immutable declaration source is byte-for-
 * byte unchanged (its fingerprint is part of the generation identity), the
 * result is never an ACTIVE claim, `starting`/`stopping` are refused, a running
 * environment is allowed, and a reentrant edit is rejected rather than allowed
 * to read a stale pre-edit document.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { portOk, type EntryPatchResult } from '@hdsl/contracts';
import { createEntryPatchPort } from '@hdsl/runtime';
import {
  ensureLayout,
  environmentPaths,
  EnvironmentStore,
  EntryPatchService,
  generationPaths,
  profileDeclarationFingerprint,
  resolveLayout,
  type EntryPatchPort,
  type EntryPatchRequest,
} from '@hdsl/core';

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const ENV = 'env-entry-0001';
const GEN = 'gen-entry-0001';
const PROFILE = `hdsl-${GEN}`;

interface Fixture {
  readonly layout: ReturnType<typeof resolveLayout>;
  readonly store: EnvironmentStore;
  readonly home: string;
  readonly patchPath: string;
  readonly profileDirectory: string;
}

const makeFixture = (
  options: { readonly state?: 'stopped' | 'running' | 'starting' | 'stopping'; readonly activeGeneration?: boolean } = {},
): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-entry-core-'));
  cleanup.push(root);
  const layout = resolveLayout(root);
  ensureLayout(layout);
  const store = new EnvironmentStore(layout);
  const activeGeneration = options.activeGeneration ?? true;
  store.write({
    schemaVersion: '1',
    id: ENV,
    name: 'Entry',
    revision: 1,
    stateVersion: 1,
    state: options.state ?? 'stopped',
    activeGenerationId: activeGeneration ? GEN : null,
    compositionDigest: activeGeneration ? 'a'.repeat(64) : null,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  });
  const paths = environmentPaths(layout, ENV);
  const profilesDirectory = paths.profilesDirectory;
  const profileDirectory = join(profilesDirectory, PROFILE);
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(
    join(profileDirectory, 'package.json'),
    JSON.stringify({ dsh: { profile: { patchReload: 'live' } } }),
  );
  writeFileSync(join(profileDirectory, 'cordis.patch.yml'), '- insert:\n    - id: base\n');
  if (activeGeneration) {
    mkdirSync(generationPaths(layout, ENV, GEN).generationDirectory, { recursive: true });
    writeFileSync(
      join(paths.environmentDirectory, 'generations', GEN, 'generation.json'),
      JSON.stringify({ schemaVersion: '1', profileName: PROFILE }),
    );
  }
  const home = paths.homeDirectory;
  return { layout, store, home, patchPath: join(home, 'cordis.patch.yml'), profileDirectory };
};

describe('EntryPatchService', () => {
  it('writes the home user patch (missing file = []) and leaves the profile declaration source untouched', () => {
    const fixture = makeFixture();
    const profileBefore = profileDeclarationFingerprint(fixture.profileDirectory);
    const profilePackageBefore = readFileSync(join(fixture.profileDirectory, 'package.json'), 'utf8');
    expect(existsSync(fixture.patchPath)).toBe(false);

    const service = new EntryPatchService({
      layout: fixture.layout,
      environments: fixture.store,
      port: createEntryPatchPort(),
    });
    const outcome = service.patchEntry({
      requestId: 'req-entry-1',
      environmentId: ENV,
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result: EntryPatchResult = outcome.value;
    expect(result.environmentId).toBe(ENV);
    expect(result.saved).toBe(true);
    expect(result.runtime).toBe('pending');
    expect(result.runtimeVerification).toBe('unavailable');
    // The published profile declares patchReload=live -> unverified, not ACTIVE.
    expect(result.reloadMode).toBe('live');
    expect(result.activation).toBe('live-reload-unverified');
    expect(result.restartRequired).toBe(false);
    expect(result.rows.some((row) => row.id === 'timer' && row.disabled === true)).toBe(true);

    // Written ONLY to the environment-shared home, never the profile source.
    expect(existsSync(fixture.patchPath)).toBe(true);
    expect(readFileSync(fixture.patchPath, 'utf8')).toContain('timer');
    expect(profileDeclarationFingerprint(fixture.profileDirectory)).toBe(profileBefore);
    expect(readFileSync(join(fixture.profileDirectory, 'package.json'), 'utf8')).toBe(profilePackageBefore);
  });

  it('reports restart-required when the profile declares startup reload', () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.profileDirectory, 'package.json'),
      JSON.stringify({ dsh: { profile: { patchReload: 'startup' } } }),
    );
    const service = new EntryPatchService({
      layout: fixture.layout,
      environments: fixture.store,
      port: createEntryPatchPort(),
    });
    const outcome = service.patchEntry({
      requestId: 'req-entry-2',
      environmentId: ENV,
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.activation).toBe('restart-required');
    expect(outcome.value.restartRequired).toBe(true);
  });

  it('allows editing a running environment', () => {
    const fixture = makeFixture({ state: 'running' });
    const service = new EntryPatchService({
      layout: fixture.layout,
      environments: fixture.store,
      port: createEntryPatchPort(),
    });
    const outcome = service.patchEntry({
      requestId: 'req-entry-3',
      environmentId: ENV,
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(outcome.ok).toBe(true);
  });

  it.each(['starting', 'stopping'] as const)('refuses a %s environment with ENVIRONMENT_BUSY', (state) => {
    const fixture = makeFixture({ state });
    const service = new EntryPatchService({
      layout: fixture.layout,
      environments: fixture.store,
      port: createEntryPatchPort(),
    });
    const outcome = service.patchEntry({
      requestId: 'req-entry-busy',
      environmentId: ENV,
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ENVIRONMENT_BUSY');
    expect(existsSync(fixture.patchPath)).toBe(false);
  });

  it('returns NOT_FOUND for an unknown environment or one without an active generation', () => {
    const fixture = makeFixture();
    const service = new EntryPatchService({
      layout: fixture.layout,
      environments: fixture.store,
      port: createEntryPatchPort(),
    });
    const unknown = service.patchEntry({
      requestId: 'req-entry-unknown',
      environmentId: 'env-does-not-exist',
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('NOT_FOUND');

    const empty = makeFixture({ activeGeneration: false });
    const emptyService = new EntryPatchService({
      layout: empty.layout,
      environments: empty.store,
      port: createEntryPatchPort(),
    });
    const noGeneration = emptyService.patchEntry({
      requestId: 'req-entry-nogen',
      environmentId: ENV,
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(noGeneration.ok).toBe(false);
    if (!noGeneration.ok) expect(noGeneration.code).toBe('NOT_FOUND');
  });

  it('passes the environment home root, patch path and reloadMode to the port, and rejects a reentrant edit', () => {
    const fixture = makeFixture();
    const requests: EntryPatchRequest[] = [];
    let service: EntryPatchService;
    const port: EntryPatchPort = {
      applyPatch(request) {
        requests.push(request);
        const nested = service.patchEntry({
          requestId: 'req-entry-nested',
          environmentId: ENV,
          operation: { kind: 'enable', rowId: 'timer' },
        });
        expect(nested.ok).toBe(false);
        if (!nested.ok) expect(nested.code).toBe('ENVIRONMENT_BUSY');
        return portOk({
          operation: request.operation.kind,
          saved: true,
          runtime: 'pending',
          runtimeVerification: 'unavailable',
          activation: 'restart-required',
          restartRequired: true,
          reloadMode: request.reloadMode,
          rows: [],
          diagnostics: [],
        });
      },
    };
    service = new EntryPatchService({
      layout: fixture.layout,
      environments: fixture.store,
      port,
    });
    const outcome = service.patchEntry({
      requestId: 'req-entry-nested-outer',
      environmentId: ENV,
      operation: { kind: 'disable', rowId: 'timer' },
    });
    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.homeRoot).toBe(fixture.home);
    expect(request?.patchPath).toBe(join(fixture.home, 'cordis.patch.yml'));
    expect(request?.reloadMode).toBe('live');
    expect(request?.text).toBe('[]');
  });
});
