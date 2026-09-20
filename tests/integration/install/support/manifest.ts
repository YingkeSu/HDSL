/**
 * Install-manifest assertions against the real T004 shape.
 *
 * The manifest is the observable proof of install completeness: which root
 * tarball digests were installed, which closure lock and npm ran, and which
 * preflight checks passed. QA asserts these fields directly instead of
 * inferring success from file existence or phase strings (orchestrator,
 * 2026-09-20).
 */
import assert from 'node:assert/strict';

import type { EnvironmentService, InstallManifest, RuntimeCombination } from './managed-install-api.js';

export const readManifest = (
  service: EnvironmentService,
  environmentId: string,
): InstallManifest => service.readInstallManifest(environmentId);

const SHA256 = /^[0-9a-f]{64}$/;

const assertRootBinding = (manifest: InstallManifest, combination: RuntimeCombination): void => {
  assert.equal(
    manifest.node.version,
    combination.node.version,
    'managed Node version must equal the catalog lock',
  );
  assert.equal(
    manifest.dsh.version,
    combination.dsh.version,
    'managed DSH version must equal the catalog lock',
  );
  assert.equal(
    manifest.node.sha256,
    combination.node.sha256,
    'managed Node must be bound to the verified root tarball digest',
  );
  assert.equal(
    manifest.dsh.sha256,
    combination.dsh.sha256,
    'managed DSH must be bound to the verified root tarball digest',
  );
  assert.ok(manifest.node.executable.length > 0, 'manifest must record the managed executable');
  assert.ok(manifest.dsh.entrypoint.length > 0, 'manifest must record the DSH entrypoint');
  assert.match(manifest.dsh.treeDigest, SHA256, 'manifest must record the extracted DSH tree digest');
  assert.match(manifest.compositionDigest, SHA256, 'manifest must record the composition digest');
  assert.ok(manifest.catalogRevision.length > 0, 'manifest must record the catalog revision');
  assert.ok(manifest.installedAt.length > 0, 'manifest must record installedAt');
};

/** Synthetic fixtures: explicitly artifacts-only, never claimed as complete. */
export const assertManifestArtifactsOnly = (
  manifest: InstallManifest,
  combination: RuntimeCombination,
): void => {
  assert.equal(manifest.installMode, 'artifacts-only');
  assertRootBinding(manifest, combination);
  assert.equal(
    manifest.preflight.skipped,
    true,
    'artifacts-only fixture installs must record preflight.skipped=true',
  );
  assert.ok(
    manifest.closure === null || manifest.closure.installed === false,
    'artifacts-only manifest must not claim an installed closure',
  );
};

/** Real closure: authenticated npm-ci install with a passing preflight. */
export const assertManifestRealClosure = (
  manifest: InstallManifest,
  combination: RuntimeCombination,
): void => {
  assert.equal(manifest.installMode, 'npm-ci', 'a production-real install must use npm-ci');
  assertRootBinding(manifest, combination);
  assert.notEqual(manifest.closure, null, 'npm-ci manifest must record the closure');
  const closure = manifest.closure;
  if (closure === null) {
    throw new Error('unreachable: closure null after assert');
  }
  assert.equal(closure.installed, true, 'closure.installed must be true');
  assert.match(closure.lockSha256, SHA256, 'closure.lockSha256 must be SHA-256');
  assert.ok(closure.packageCount > 0, 'closure.packageCount must be positive');
  assert.ok(closure.npmVersion.length > 0, 'closure.npmVersion must be recorded');
  assert.equal(closure.nodeVersion, combination.node.version, 'closure.nodeVersion must match');
  assert.ok(closure.lockAsset.length > 0, 'closure.lockAsset must be recorded');
  assert.ok(closure.rootIntegritySha512.length > 0, 'closure.rootIntegritySha512 must be recorded');

  assert.equal(manifest.preflight.skipped, false, 'npm-ci install must not skip preflight');
  assert.equal(manifest.preflight.passed, true, 'preflight must pass for a complete install');
  assert.ok(manifest.preflight.checks.length > 0, 'preflight must record at least one check');
  for (const check of manifest.preflight.checks) {
    assert.equal(check.exitCode, 0, `preflight ${check.name} failed: ${check.stdout}`);
  }
  const stdout = manifest.preflight.checks.map((check) => check.stdout).join('\n');
  assert.ok(stdout.includes(combination.node.version), 'preflight must report the managed Node version');
  assert.ok(stdout.includes(combination.dsh.version), 'preflight must report the managed DSH version');
};
