/**
 * OPT-IN real managed-install evidence.
 *
 * Not part of the default unit run: it downloads the official Node and DSH
 * artifacts from the audited sources, installs the full DSH dependency closure
 * with the managed Node's npm, and runs the version/help preflight.
 *
 * Run explicitly:
 *
 * ```sh
 * HDSL_REAL_INSTALL=1 pnpm exec vitest run tests/install/real-install.evidence.test.ts --reporter=verbose
 * ```
 *
 * This is T004 install evidence only. It does not start the WebUI, does not test
 * readiness and does not touch credentials — that is T005.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_VERSION, createContractRuntime } from '@hdsl/contracts';
import { createManagedInstall, resolveLayout } from '@hdsl/core';
import { VERIFIED_COMBINATIONS, createRuntimePort, readDependencyClosure } from '@hdsl/runtime';

const enabled = process.env['HDSL_REAL_INSTALL'] === '1';
const keep = process.env['HDSL_EVIDENCE_KEEP'] === '1';
const dataRoot =
  process.env['HDSL_EVIDENCE_DATA_ROOT'] ?? mkdtempSync(join(tmpdir(), 'hdsl-t004-evidence-'));

const snapshotHome = (): string[] => {
  const dshHome = join(homedir(), '.dsh');
  if (!existsSync(dshHome)) {
    return [];
  }
  return readdirSync(dshHome).sort();
};

describe.skipIf(!enabled)('real managed install (opt-in evidence)', () => {
  it(
    'installs both audited macOS ARM64 compositions with the full closure and preflight',
    async () => {
      const homeBefore = snapshotHome();
      const managed = await createManagedInstall({
        dataRoot,
        catalog: VERIFIED_COMBINATIONS,
        runtime: createRuntimePort(),
        operationTimeoutMs: 30 * 60_000,
      });
      const contract = createContractRuntime({ port: managed.port });
      const results: unknown[] = [];

      for (const [index, combination] of VERIFIED_COMBINATIONS.entries()) {
        const environmentName = `evidence-${combination.dsh.version}-${combination.node.version}`;
        const created = contract.dispatch({
          apiVersion: API_VERSION,
          method: 'environments.create',
          input: {
            requestId: `evidence-create-${String(index)}`,
            name: environmentName,
            catalogCombinationId: combination.id,
          },
        });
        expect(created.ok).toBe(true);
        if (!created.ok) {
          return;
        }
        const operationId = (created.value as { operationId: string }).operationId;
        const snapshot = await managed.waitForOperation(operationId, { timeoutMs: 30 * 60_000 });
        expect(snapshot.status, JSON.stringify(snapshot)).toBe('succeeded');

        const environments = contract.dispatch({
          apiVersion: API_VERSION,
          method: 'environments.list',
          input: {},
        });
        expect(environments.ok).toBe(true);
        if (!environments.ok) {
          return;
        }
        const environment = (
          environments.value as Array<{ id: string; name: string; activeGenerationId: string | null }>
        ).find((entry) => entry.name === environmentName);
        expect(environment).toBeDefined();
        if (environment === undefined) {
          return;
        }
        const manifest = managed.service.readInstallManifest(environment.id);
        expect(manifest.installMode).toBe('npm-ci');
        expect(manifest.preflight.skipped).toBe(false);
        expect(manifest.preflight.passed).toBe(true);
        expect(manifest.closure).not.toBeNull();
        const supportedClosure = readDependencyClosure(combination.dsh.version);
        expect(supportedClosure).toBeDefined();
        expect(manifest.closure?.packageCount).toBe(supportedClosure?.packageCount);
        expect(manifest.node.version).toBe(combination.node.version);
        expect(manifest.dsh.version).toBe(combination.dsh.version);

        const paths = resolveLayout(dataRoot);
        const generationDirectory = join(
          paths.environments,
          environment.id,
          'generations',
          environment.activeGenerationId as string,
        );
        const nodeVersion = execFileSync(join(generationDirectory, 'node', 'bin', 'node'), ['--version'], {
          encoding: 'utf8',
        }).trim();
        expect(nodeVersion).toBe(`v${combination.node.version}`);
        const dshVersion = execFileSync(
          join(generationDirectory, 'node', 'bin', 'node'),
          [join(generationDirectory, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version'],
          { encoding: 'utf8', env: { HOME: join(generationDirectory, 'home'), DSH_HOME: join(generationDirectory, 'home'), PATH: `${join(generationDirectory, 'node', 'bin')}:/usr/bin:/bin` } },
        ).trim();
        expect(dshVersion).toBe(combination.dsh.version);
        const lock = JSON.parse(
          readFileSync(join(generationDirectory, 'composition.lock.json'), 'utf8'),
        ) as { node: { sha256: string }; dsh: { sha256: string } };
        expect(lock.node.sha256).toBe(combination.node.sha256);
        expect(lock.dsh.sha256).toBe(combination.dsh.sha256);

        results.push({
          combinationId: combination.id,
          nodeVersion: manifest.node.version,
          dshVersion: manifest.dsh.version,
          installMode: manifest.installMode,
          lockSha256: manifest.closure?.lockSha256,
          packageCount: manifest.closure?.packageCount,
          npmVersion: manifest.closure?.npmVersion,
          treeDigest: manifest.dsh.treeDigest,
          preflight: manifest.preflight.checks,
          homeUntouched: JSON.stringify(homeBefore) === JSON.stringify(snapshotHome()),
        });
      }

      // eslint-disable-next-line no-console
      console.log(`HDSL_REAL_INSTALL_EVIDENCE ${JSON.stringify({ dataRoot, results }, null, 2)}`);
      expect(results).toHaveLength(VERIFIED_COMBINATIONS.length);
      expect(snapshotHome()).toEqual(homeBefore);
      await managed.close();
      if (!keep) {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    3_600_000,
  );
});
