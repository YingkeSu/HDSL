/**
 * #77 S3: full core remove preview -> apply transaction against the REAL runtime
 * removal port (isolated pruned-lock recompute + default-deny frozen install).
 *
 * Covers the three deterministic branches (remove / retention / blocked), the
 * builtin negative control with a REAL in-box bundle name, preview->apply binding
 * drift, commit-point revision re-validation, and crash recovery roll-back. The
 * runtime copy, profile publish, pointer switch, journal, revision and ledger
 * paths are the SAME ones the install slice uses.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangeApplyService,
  ChangePreviewService,
  EnvironmentStore,
  OperationStore,
  ensureLayout,
  environmentPaths,
  generationPaths,
  managedProfileName,
  resolveLayout,
  toOperationSnapshot,
  type EnvironmentRecord,
  type PluginRemovalPort,
} from '@hdsl/core';
import {
  computeCompositionDigest,
  createPluginRemovalPort,
  createGenerationRuntimeVerifier,
  sha256TreeDigestSync,
  type PluginExecutorPort,
} from '@hdsl/runtime';
import type { ChangePlan, CompositionLock, OperationSnapshot } from '@hdsl/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0000000000000001';
const OLD_GENERATION = 'gen-0000000000000001';
const FIXTURE = 'hdsl-plugin-e2e-fixture';
const FIXTURE_COMMIT = 'e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838';
const FIXTURE_MANIFEST_SHA = 'ee613a2eb425a24bc44e946d84e36b7ceb2f594f1214913ff34dd0d0e450ba5c';
const DSH_SHA = 'f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480';
const REVIEWED_MANIFEST_B64 =
  'ewogICJuYW1lIjogImhkc2wtcGx1Z2luLWUyZS1maXh0dXJlIiwKICAidmVyc2lvbiI6ICIwLjAuMSIsCiAgInByaXZhdGUiOiBmYWxzZSwKICAiZGVzY3JpcHRpb24iOiAiSERTTCBjb250cm9sbGVkIGVuZC10by1lbmQgdGVzdCBmaXh0dXJlOiBhIG1pbmltYWwsIHJldmlld2VkIERTSCBidW5kbGUgd2l0aCBhIGxvYWQgbWFya2VyLiBObyBpbnN0YWxsLXRpbWUgc2NyaXB0cywgbm8gdGhpcmQtcGFydHkgZGVwZW5kZW5jaWVzLiIsCiAgInR5cGUiOiAibW9kdWxlIiwKICAibWFpbiI6ICJsaWIvaW5kZXgubWpzIiwKICAiZXhwb3J0cyI6IHsKICAgICIuIjogIi4vbGliL2luZGV4Lm1qcyIsCiAgICAiLi9jb3JkaXMucGF0Y2gueW1sIjogIi4vY29yZGlzLnBhdGNoLnltbCIsCiAgICAiLi9wYWNrYWdlLmpzb24iOiAiLi9wYWNrYWdlLmpzb24iCiAgfSwKICAiZmlsZXMiOiBbCiAgICAibGliL2luZGV4Lm1qcyIsCiAgICAiY29yZGlzLnBhdGNoLnltbCIsCiAgICAiUkVBRE1FLm1kIgogIF0sCiAgImxpY2Vuc2UiOiAiTUlUIiwKICAiZHNoIjogewogICAgImJ1bmRsZSI6IHsKICAgICAgInBhdGNoIjogIi4vY29yZGlzLnBhdGNoLnltbCIKICAgIH0KICB9Cn0K';

const currentLockFor = (pluginId: string): string =>
  [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    `      ${pluginId}:`,
    '        specifier: github:octo/demo',
    '        version: 1.0.0',
    '      shared-dep:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    'packages:',
    `  ${pluginId}@1.0.0:`,
    '    resolution: {integrity: sha512-x}',
    '  shared-dep@1.0.0:',
    '    resolution: {integrity: sha512-y}',
    'snapshots:',
    `  ${pluginId}@1.0.0: {}`,
    '  shared-dep@1.0.0: {}',
  ].join('\n');

const prunedLock = (): string =>
  [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      shared-dep:',
    '        specifier: 1.0.0',
    '        version: 1.0.0',
    'packages:',
    '  shared-dep@1.0.0:',
    '    resolution: {integrity: sha512-y}',
    'snapshots:',
    '  shared-dep@1.0.0: {}',
  ].join('\n');

/** Retention: the target stays reachable because retained `b` depends on it. */
const retainedViaOtherLock = (pluginId: string): string =>
  [
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
    `  ${pluginId}@1.0.0:`,
    '    resolution: {integrity: sha512-x}',
    'snapshots:',
    '  b@1.0.0:',
    '    dependencies:',
    `      ${pluginId}: 1.0.0`,
    `  ${pluginId}@1.0.0: {}`,
  ].join('\n');

const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value));

const executor = (writtenLock: () => string): PluginExecutorPort => ({
  identity: async () => ({
    ok: true,
    value: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) },
  }),
  run: async (request) => {
    if (request.args.includes('--lockfile-only')) {
      writeFileSync(join(request.cwd, 'pnpm-lock.yaml'), writtenLock());
    } else {
      // frozen install: the lock must stay byte-identical to the plan binding.
      writeFileSync(join(request.cwd, 'pnpm-lock.yaml'), writtenLock());
      writeFileSync(join(request.cwd, 'node_modules.stamp'), 'installed\n');
    }
    return {
      ok: true,
      value: {
        executor: { id: 'pnpm', version: '11.7.0', sha256: '1'.repeat(64), entrySha256: '2'.repeat(64), treeSha256: '3'.repeat(64) },
        exitCode: 0,
        stdout: '',
        stderr: '',
        executedInstallScripts: [],
      },
    };
  },
});

interface FixtureOptions {
  readonly pluginId?: string;
  readonly installedViaB?: boolean;
  readonly userPatch?: string | null;
}

const build = (options: FixtureOptions = {}) => {
  const pluginId = options.pluginId ?? FIXTURE;
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-removal-apply-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  ensureLayout(layout);
  const environmentRoot = environmentPaths(layout, ENVIRONMENT_ID);
  const generation = generationPaths(layout, ENVIRONMENT_ID, OLD_GENERATION);
  const now = '2026-09-22T00:05:00.000Z';

  const environments = new EnvironmentStore(layout);
  environments.write({
    schemaVersion: '1',
    id: ENVIRONMENT_ID,
    name: 'removal-env',
    revision: 3,
    stateVersion: 1,
    state: 'stopped',
    activeGenerationId: OLD_GENERATION,
    compositionDigest: '0'.repeat(64),
    createdAt: now,
    updatedAt: now,
  } satisfies EnvironmentRecord);

  // --- managed runtime tree (node + dsh + in-box bundles + cordis/loader) ---
  mkdirSync(join(generation.nodeDirectory, 'bin'), { recursive: true });
  writeFileSync(join(generation.nodeDirectory, 'bin', 'node'), '#!/bin/sh\n');
  const scope = join(generation.dshDirectory, 'node_modules', '@deepseek-ai');
  mkdirSync(join(scope, 'dsh'), { recursive: true });
  writeFileSync(join(scope, 'dsh', 'bin.js'), '// dsh\n');
  for (const name of ['dsh-base', 'dsh-web-app']) {
    mkdirSync(join(scope, name), { recursive: true });
    writeJson(join(scope, name, 'package.json'), {
      name: `@deepseek-ai/${name}`,
      version: '0.1.5-rc.2',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    });
  }
  mkdirSync(join(scope, 'cordis'), { recursive: true });
  mkdirSync(join(scope, 'cordis-plugin-loader'), { recursive: true });
  writeJson(join(scope, 'cordis', 'package.json'), { name: '@deepseek-ai/cordis', version: '4.0.2' });
  writeJson(join(scope, 'cordis-plugin-loader', 'package.json'), { name: '@deepseek-ai/cordis-plugin-loader', version: '1.0.3' });
  writeJson(generation.manifestPath, {
    schemaVersion: '1',
    installMode: 'npm-ci',
    node: { version: '22.19.0', treeDigest: sha256TreeDigestSync(generation.nodeDirectory) },
    dsh: { version: '0.1.5-rc.2', sha256: DSH_SHA, treeDigest: sha256TreeDigestSync(join(scope, 'dsh')) },
  });

  // --- composition lock with recorded source identity ---
  const lock: CompositionLock = {
    schemaVersion: '1',
    node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
    dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
    plugins: [{ id: pluginId, version: '1.0.0', sha256: 'c'.repeat(64) }],
    sources: {
      node: { url: 'https://fixture.invalid/n', sha256: 'a'.repeat(64) },
      dsh: { url: 'https://fixture.invalid/d', sha256: 'b'.repeat(64) },
    },
    pluginSources: {
      [pluginId]: {
        sourceKind: 'github',
        repository: { owner: 'YingkeSu', name: 'hdsl-plugin-e2e-fixture' },
        commitSha: FIXTURE_COMMIT,
        ref: null,
        packageName: pluginId,
        packageVersion: '1.0.0',
        manifestSha256: FIXTURE_MANIFEST_SHA,
        closureLockSha256: null,
        isBuiltin: false,
        buildAuthorization: null,
        executor: null,
      },
    },
  };
  writeJson(generation.lockPath, lock);
  writeJson(generation.generationRecordPath, {
    id: OLD_GENERATION,
    environmentId: ENVIRONMENT_ID,
    compositionDigest: '0'.repeat(64),
    createdAt: now,
    profileName: managedProfileName(OLD_GENERATION),
  });

  // --- immutable declaration source + current lock ---
  const declaration = {
    name: 'dsh-profile-web',
    dependencies: { [pluginId]: 'github:octo/demo#main', 'shared-dep': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pluginId] } },
  };
  const declarationText = JSON.stringify(declaration);
  mkdirSync(join(generation.generationDirectory, 'profile'), { recursive: true });
  writeFileSync(join(generation.generationDirectory, 'profile', 'package.json'), declarationText);
  writeFileSync(join(generation.generationDirectory, 'profile', 'pnpm-lock.yaml'), currentLockFor(pluginId));

  // --- published profile (byte-identical declaration) + patches ---
  const published = join(environmentRoot.profilesDirectory, managedProfileName(OLD_GENERATION));
  mkdirSync(join(published, 'node_modules', pluginId), { recursive: true });
  mkdirSync(join(published, 'node_modules', '@deepseek-ai', 'dsh-base'), { recursive: true });
  writeFileSync(join(published, 'package.json'), declarationText);
  writeFileSync(
    join(published, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'),
    '- insert:\n    - id: other\n      name: other-plugin\n- id: system-prompt\n  config:\n    inject: [webStartup]\n',
  );
  writeFileSync(
    join(published, 'node_modules', pluginId, 'cordis.patch.yml'),
    `- insert:\n    - id: demo-row\n      name: ${pluginId}\n`,
  );
  if (pluginId === FIXTURE) {
    writeFileSync(join(published, 'node_modules', pluginId, 'package.json'), Buffer.from(REVIEWED_MANIFEST_B64, 'base64'));
  }

  // --- environment home: user patch (read-only) ---
  mkdirSync(environmentRoot.homeDirectory, { recursive: true });
  if (options.userPatch !== null) {
    writeFileSync(join(environmentRoot.homeDirectory, 'cordis.patch.yml'), options.userPatch ?? '- id: untouched\n  config:\n    note: stable\n');
  }

  const writtenLock = options.installedViaB === true ? () => retainedViaOtherLock(pluginId) : () => prunedLock();
  const removalPort = createPluginRemovalPort({ executor: executor(writtenLock) });
  const preview = new ChangePreviewService({
    layout,
    removalPort,
    findEnvironment: (environmentId) => environments.read(environmentId),
    now: () => new Date(now),
  });
  const operations = new OperationStore(layout);
  const apply = (port: PluginRemovalPort) =>
    new ChangeApplyService({
      layout,
      plans: preview.plans,
      environments,
      operations,
      compositionDigest: computeCompositionDigest,
      removalPort: port,
      verifyGenerationRuntime: createGenerationRuntimeVerifier(),
      now: () => new Date(now),
    });
  return { layout, environments, operations, preview, apply, removalPort, generation, environmentRoot, pluginId };
};

const waitOperation = async (
  find: (id: string) => OperationSnapshot | undefined,
  operationId: string,
): Promise<OperationSnapshot> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const snapshot = find(operationId);
    if (snapshot !== undefined && ['succeeded', 'failed', 'cancelled'].includes(snapshot.status)) {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error('operation did not reach a terminal state');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const previewRemoval = async (
  fixture: ReturnType<typeof build>,
  pluginId: string,
  revision = 3,
): Promise<OperationSnapshot> => {
  const started = fixture.preview.previewChange({
    requestId: 'req-preview-remove',
    environmentId: ENVIRONMENT_ID,
    expectedRevision: revision,
    action: { kind: 'remove', pluginId },
  });
  if (!started.ok) {
    throw new Error(`preview did not start: ${started.code}`);
  }
  return waitOperation((id) => {
    const outcome = fixture.preview.findOperation(id);
    return outcome?.ok ? outcome.value : undefined;
  }, started.value.operationId);
};

const applyPlan = async (fixture: ReturnType<typeof build>, plan: ChangePlan, port?: PluginRemovalPort) => {
  const service = fixture.apply(port ?? fixture.removalPort);
  const started = service.applyChange({
    requestId: 'req-apply-remove',
    environmentId: ENVIRONMENT_ID,
    expectedRevision: plan.baseRevision,
    planId: plan.planId,
    buildAuthorization: null,
  });
  if (!started.ok) {
    throw new Error(`apply did not start: ${started.code}`);
  }
  return waitOperation((id) => {
    const record = fixture.operations.read(id);
    return record === undefined ? undefined : toOperationSnapshot(record);
  }, started.value.operationId);
};

describe('#77 remove preview -> apply transaction (real runtime removal port)', () => {
  it('removes the direct dependency and enabled reference, commits a new generation and retains shared deps', async () => {
    const fixture = build();
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    expect(plan.action).toEqual({ kind: 'remove', pluginId: FIXTURE });
    expect(plan.sourceLock).toBeNull();
    expect(plan.blockingReferences).toEqual([]);
    expect(plan.removals.some((entry) => entry.includes('dependency entry'))).toBe(true);
    expect(plan.removals.some((entry) => entry.includes('enabled bundle reference'))).toBe(true);
    expect(plan.retention).toContain('direct dependency shared-dep');
    expect(plan.retention).toContain('user patch layer (home cordis.patch.yml)');

    const applied = await applyPlan(fixture, plan);
    expect(applied.status).toBe('succeeded');
    const environment = fixture.environments.read(ENVIRONMENT_ID)!;
    expect(environment.activeGenerationId).not.toBe(OLD_GENERATION);
    expect(environment.revision).toBe(4);
    const newPaths = generationPaths(fixture.layout, ENVIRONMENT_ID, environment.activeGenerationId!);
    const newLock = JSON.parse(readFileSync(newPaths.lockPath, 'utf8')) as CompositionLock;
    expect(newLock.plugins).toEqual([]);
    expect(newLock.pluginSources?.[FIXTURE]).toBeUndefined();
    expect(newLock.sources.node.sha256).toBe('a'.repeat(64));
    // Old generation and the user patch layer are untouched.
    expect(readFileSync(join(fixture.generation.lockPath), 'utf8')).toContain(FIXTURE);
    expect(readFileSync(join(fixture.environmentRoot.homeDirectory, 'cordis.patch.yml'), 'utf8')).toContain('stable');
    // Published profile of the new generation has the pruned declaration.
    const publishedDeclaration = JSON.parse(
      readFileSync(join(fixture.environmentRoot.profilesDirectory, managedProfileName(environment.activeGenerationId!), 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } };
    expect(publishedDeclaration.dependencies[FIXTURE]).toBeUndefined();
    expect(publishedDeclaration.dsh.profile.bundles).not.toContain(FIXTURE);
  });

  it('legitimately retains a package that a retained dependency still resolves (A via B)', async () => {
    const fixture = build({ installedViaB: true });
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    expect(plan.blockingReferences).toEqual([]);
    expect(plan.retention.some((entry) => entry.includes('remains reachable in the pruned lock closure'))).toBe(true);
    const applied = await applyPlan(fixture, plan);
    expect(applied.status).toBe('succeeded');
    const environment = fixture.environments.read(ENVIRONMENT_ID)!;
    const newLock = JSON.parse(
      readFileSync(generationPaths(fixture.layout, ENVIRONMENT_ID, environment.activeGenerationId!).lockPath, 'utf8'),
    ) as CompositionLock;
    // Dropped from the ENABLED set even though the lock closure still reaches it.
    expect(newLock.plugins).toEqual([]);
  });

  it('blocks a removal whose service dependencies are not verified, with no side effect', async () => {
    const fixture = build({ pluginId: 'demo-plugin' });
    const snapshot = await previewRemoval(fixture, 'demo-plugin');
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    expect(plan.blockingReferences.length).toBeGreaterThanOrEqual(1);
    expect(plan.blockingReferences.some((entry) => entry.detail.includes('service dependencies for this plugin are not verified'))).toBe(true);

    // A programmatic caller that bypasses the UI must get the REAL reason
    // (`REFERENCED_BY_OTHER`), never the misleading cache-miss `PLAN_STALE`.
    let applyCalls = 0;
    const countingPort: PluginRemovalPort = {
      ...fixture.removalPort,
      applyRemoval: async (input, signal) => {
        applyCalls += 1;
        return fixture.removalPort.applyRemoval(input, signal);
      },
    };
    const service = fixture.apply(countingPort);
    const rejected = service.applyChange({
      requestId: 'req-apply-blocked',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: plan.baseRevision,
      planId: plan.planId,
      buildAuthorization: null,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('REFERENCED_BY_OTHER');
    // No executor run, no plan consumption, no environment change.
    expect(applyCalls).toBe(0);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
    expect(fixture.preview.plans.read(plan.planId)?.consumedBy).toBeNull();
  });

  it('rejects a source-identity drift at apply even when the pruned declaration and lock are unchanged', async () => {
    const fixture = build();
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    // Controlled drift of the recorded source identity in OUR temp generation lock
    // (the pruned declaration+lock bytes the plan bound are untouched).
    const lockText = readFileSync(fixture.generation.lockPath, 'utf8');
    const drifted = JSON.parse(lockText) as { pluginSources: Record<string, { commitSha: string }> };
    drifted.pluginSources[FIXTURE]!.commitSha = 'f'.repeat(40);
    writeFileSync(fixture.generation.lockPath, `${JSON.stringify(drifted)}\n`);
    const applied = await applyPlan(fixture, plan);
    expect(applied.status).toBe('failed');
    expect(applied.error?.code).toBe('PLAN_STALE');
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(fixture.preview.plans.read(plan.planId)?.consumedBy).toBeNull();
  });

  it('protects a REAL in-box bundle of the managed install even when it is not a profile-lock dependency', async () => {
    // The composition records a DIFFERENT plugin, while the in-box bundle is only
    // an enabled profile bundle (the real shape). The preview must still fail with
    // BUILTIN_BUNDLE_PROTECTED rather than a generic internal error.
    const fixture = build({ pluginId: 'demo-plugin' });
    const snapshot = await previewRemoval(fixture, '@deepseek-ai/dsh-base');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error?.code).toBe('BUILTIN_BUNDLE_PROTECTED');
    // No plan and no environment side effect.
    expect(fixture.preview.plans.read('plan-0000000000000000')).toBeUndefined();
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
  });

  it('treats a pre-S3 generation without a recorded source binding as unknown (blocked, not INTERNAL_ERROR)', async () => {
    // Existing-generation compatibility (ADR 0005 D21.7): a composition without
    // `pluginSources` has an unknown service axis and MUST be blocked with an
    // explainable plan, never a generic internal error.
    const fixture = build();
    const lock = JSON.parse(readFileSync(fixture.generation.lockPath, 'utf8')) as Record<string, unknown>;
    delete lock['pluginSources'];
    writeFileSync(fixture.generation.lockPath, JSON.stringify(lock));
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    expect(plan.blockingReferences.some((entry) => entry.detail.includes('service dependencies for this plugin are not verified'))).toBe(true);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
  });

  it('re-verifies references at apply time: a user patch that starts referencing the plugin blocks it', async () => {
    const fixture = build();
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    // Drift AFTER the preview: the user patch now inserts the removed plugin.
    writeFileSync(
      join(fixture.environmentRoot.homeDirectory, 'cordis.patch.yml'),
      `- insert:\n    - id: late-row\n      name: ${FIXTURE}\n`,
    );
    const applied = await applyPlan(fixture, plan);
    expect(applied.status).toBe('failed');
    expect(['REFERENCED_BY_OTHER', 'PLAN_STALE']).toContain(applied.error?.code);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
  });

  it('refuses to overwrite a concurrent pointer move at the commit point', async () => {
    const fixture = build();
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    const driftingPort: PluginRemovalPort = {
      ...fixture.removalPort,
      applyRemoval: async (input, signal) => {
        const result = await fixture.removalPort.applyRemoval(input, signal);
        if (result.ok) {
          const current = fixture.environments.read(ENVIRONMENT_ID)!;
          fixture.environments.write({
            ...current,
            revision: current.revision + 1,
            activeGenerationId: 'gen-0000000000000009',
            compositionDigest: '9'.repeat(64),
          });
        }
        return result;
      },
    };
    const applied = await applyPlan(fixture, plan, driftingPort);
    expect(applied.status).toBe('failed');
    expect(applied.error?.code).toBe('REVISION_CONFLICT');
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe('gen-0000000000000009');
    expect(fixture.environments.read(ENVIRONMENT_ID)?.revision).toBe(4);
  });

  it('rolls a crashed pre-commit removal back to the old generation without consuming the plan', async () => {
    const fixture = build();
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    const service = new ChangeApplyService({
      layout: fixture.layout,
      plans: fixture.preview.plans,
      environments: fixture.environments,
      operations: fixture.operations,
      compositionDigest: computeCompositionDigest,
      removalPort: fixture.removalPort,
      verifyGenerationRuntime: createGenerationRuntimeVerifier(),
      now: () => new Date('2026-09-22T00:05:00.000Z'),
      faults: { pauseAt: 'verified' },
    });
    const started = service.applyChange({
      requestId: 'req-apply-crash',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      planId: plan.planId,
      buildAuthorization: null,
    });
    expect(started.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const report = service.recover();
    expect(report.rolledBack).toBe(1);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
    expect(fixture.preview.plans.read(plan.planId)?.consumedBy).toBeNull();
  });

  it('cancels a removal preview as a terminal cancelled operation with no plan and no side effect', async () => {
    const fixture = build();
    const blockingPort: PluginRemovalPort = {
      ...fixture.removalPort,
      resolveRemoval: (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ ok: false, code: 'INTERNAL_ERROR', message: 'aborted before resolution' }),
            { once: true },
          );
        }),
    };
    const service = new ChangePreviewService({
      layout: fixture.layout,
      removalPort: blockingPort,
      findEnvironment: (id) => fixture.environments.read(id),
      now: () => new Date('2026-09-22T00:05:00.000Z'),
    });
    const started = service.previewChange({
      requestId: 'req-cancel-preview',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      action: { kind: 'remove', pluginId: FIXTURE },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const cancelled = service.cancelOperation(started.value.operationId);
    expect(cancelled?.ok).toBe(true);
    const operation = service.findOperation(started.value.operationId);
    expect(operation?.ok ? operation.value.status : undefined).toBe('cancelled');
    // No plan, no pointer/revision change (cancellation is terminal, no effect).
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
  });

  it('cancels a removal apply before the commit point and keeps the old generation active', async () => {
    const fixture = build();
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    const abortingPort: PluginRemovalPort = {
      ...fixture.removalPort,
      applyRemoval: (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ ok: false, code: 'INTERNAL_ERROR', message: 'aborted before commit' }),
            { once: true },
          );
        }),
    };
    const service = fixture.apply(abortingPort);
    const started = service.applyChange({
      requestId: 'req-cancel-apply',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      planId: plan.planId,
      buildAuthorization: null,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const cancelled = service.cancelOperation(started.value.operationId);
    expect(cancelled?.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fixture.operations.read(started.value.operationId)?.status).toBe('cancelled');
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
    expect(fixture.preview.plans.read(plan.planId)?.consumedBy).toBeNull();
  });

  it('fails a removal preview controllably when the managed executor is unavailable (no plan, no effect)', async () => {
    const fixture = build();
    const failingPort: PluginRemovalPort = {
      ...fixture.removalPort,
      resolveRemoval: async () => ({ ok: false, code: 'EXECUTOR_UNAVAILABLE', message: 'managed executor unavailable' }),
    };
    const service = new ChangePreviewService({
      layout: fixture.layout,
      removalPort: failingPort,
      findEnvironment: (id) => fixture.environments.read(id),
      now: () => new Date('2026-09-22T00:05:00.000Z'),
    });
    const started = service.previewChange({
      requestId: 'req-exec-fail-preview',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 3,
      action: { kind: 'remove', pluginId: FIXTURE },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const operation = await waitOperation(
      (id) => {
        const outcome = service.findOperation(id);
        return outcome?.ok ? outcome.value : undefined;
      },
      started.value.operationId,
    );
    expect(operation.status).toBe('failed');
    expect(operation.error?.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
  });

  it('fails a removal apply controllably when the managed executor is unavailable and keeps the composition unchanged', async () => {
    const fixture = build();
    const snapshot = await previewRemoval(fixture, FIXTURE);
    expect(snapshot.status).toBe('succeeded');
    const plan = snapshot.output as ChangePlan;
    const failingPort: PluginRemovalPort = {
      ...fixture.removalPort,
      applyRemoval: async () => ({ ok: false, code: 'EXECUTOR_UNAVAILABLE', message: 'managed executor unavailable' }),
    };
    const applied = await applyPlan(fixture, plan, failingPort);
    expect(applied.status).toBe('failed');
    expect(applied.error?.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(fixture.environments.read(ENVIRONMENT_ID)?.activeGenerationId).toBe(OLD_GENERATION);
    expect(fixture.environments.read(ENVIRONMENT_ID)?.revision).toBe(3);
    expect(fixture.preview.plans.read(plan.planId)?.consumedBy).toBeNull();
  });
});
