/**
 * #78 S4 preview-side closure enumeration: the resolving preview must materialise
 * the target profile with DEFAULT DENY and non-executingly enumerate the
 * dependency closure, so a source WITH dependencies is authorizable. No script is
 * executed and no fixture runs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorIdentity, PluginSourceSelector } from '@hdsl/contracts';
import { createResolvingPreviewPort, type GitProvider, type PluginExecutorPort } from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const COMMIT = 'e'.repeat(40);
const SOURCE: PluginSourceSelector = { owner: 'octo', name: 'hdsl-plugin-demo', ref: 'main' };
const EXECUTOR: ExecutorIdentity = {
  id: 'pnpm',
  version: '11.7.0',
  sha256: '1'.repeat(64),
  entrySha256: '2'.repeat(64),
  treeSha256: '3'.repeat(64),
};
const LOCK_TEXT = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      hdsl-plugin-demo:',
  `        version: hdsl-plugin-demo@https://codeload.github.com/octo/hdsl-plugin-demo/tar.gz/${COMMIT}`,
  'packages:',
  `  hdsl-plugin-demo@https://codeload.github.com/octo/hdsl-plugin-demo/tar.gz/${COMMIT}:`,
  '    version: 1.0.0',
  '  shared-dep@1.2.3:',
  '    version: 1.2.3',
  'snapshots:',
  '  shared-dep@1.2.3: {}',
].join('\n');
const MANIFEST = JSON.stringify({
  name: 'hdsl-plugin-demo',
  version: '1.0.0',
  dependencies: { 'shared-dep': '1.2.3' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  scripts: { preinstall: 'node p.js', install: 'node i.js', postinstall: 'node po.js', prepare: 'node pr.js' },
});

const harness = (options: { failMaterialize?: boolean } = {}) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-preview-enum-'));
  roots.push(dataRoot);
  const declarationDirectory = join(dataRoot, 'declaration');
  mkdirSync(declarationDirectory, { recursive: true });
  writeFileSync(
    join(declarationDirectory, 'package.json'),
    JSON.stringify({ name: 'hdsl-profile', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }),
  );
  // A HISTORICAL build-permission config must never be inherited into the
  // default-deny materialisation.
  writeFileSync(
    join(declarationDirectory, 'pnpm-workspace.yaml'),
    'allowBuilds:\n  historical@1.0.0: true\nonlyBuiltDependencies:\n  - historical\n',
  );
  const nodeExecutable = join(dataRoot, 'node');
  writeFileSync(nodeExecutable, '#!/bin/sh\n');

  const calls: { args: readonly string[] }[] = [];
  let materializeWorkspace: string | null = null;
  const provider: GitProvider = {
    resolveManifest: async () => ({ ok: true, value: { commitSha: COMMIT, manifestText: MANIFEST, lockText: null } }),
  };
  const executor: PluginExecutorPort = {
    identity: async () => ({ ok: true, value: EXECUTOR }),
    run: async (request) => {
      calls.push({ args: request.args });
      if (request.args.includes('--lockfile-only')) {
        writeFileSync(join(request.cwd, 'pnpm-lock.yaml'), LOCK_TEXT);
        return { ok: true, value: { executor: EXECUTOR, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
      }
      if (options.failMaterialize === true) {
        return { ok: true, value: { executor: EXECUTOR, exitCode: 1, stdout: '', stderr: 'materialise failed', executedInstallScripts: [] } };
      }
      mkdirSync(join(request.cwd, 'node_modules', 'shared-dep'), { recursive: true });
      writeFileSync(
        join(request.cwd, 'node_modules', 'shared-dep', 'package.json'),
        JSON.stringify({ name: 'shared-dep', version: '1.2.3', scripts: { postinstall: 'node dep.js' } }),
      );
      const workspacePath = join(request.cwd, 'pnpm-workspace.yaml');
      materializeWorkspace = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : null;
      // The default-deny materialisation must never create an allowBuilds config.
      expect(request.args).toEqual(['install', '--frozen-lockfile', '--ignore-scripts']);
      return { ok: true, value: { executor: EXECUTOR, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
    },
  };
  const port = createResolvingPreviewPort({ gitProvider: provider, executor, executorIdentity: EXECUTOR });
  const context = {
    declarationDirectory,
    stagingDirectory: join(dataRoot, 'staging'),
    nodeExecutable,
  };
  return { port, context, calls, materializeWorkspace: () => materializeWorkspace };
};

describe('S4 preview closure enumeration', () => {
  it('materialises with default deny and merges root + closure scripts into the preview', async () => {
    const h = harness();
    const outcome = await h.port.previewSource(SOURCE, new AbortController().signal, h.context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const resolution = outcome.value;
    expect(resolution.dependencyClosureEnumerated).toBe(true);
    expect(resolution.scriptAssessment).toBe('detected');
    expect(resolution.requiresBuildAuthorization).toBe(true);
    expect(resolution.scripts).toHaveLength(5);
    expect(resolution.scripts.filter((entry) => entry.source === 'root')).toHaveLength(4);
    expect(resolution.scripts.filter((entry) => entry.source === 'dependency')).toEqual([
      { packageName: 'shared-dep', packageVersion: '1.2.3', script: 'postinstall', source: 'dependency' },
    ]);
    // Default-deny materialisation + the earlier lock-only resolution only.
    expect(h.calls.map((call) => call.args)).toEqual([
      ['install', '--lockfile-only', '--ignore-scripts'],
      ['install', '--frozen-lockfile', '--ignore-scripts'],
    ]);
    // The isolated materialisation staging is cleaned.
    expect(existsSync(`${h.context.stagingDirectory}-materialize`)).toBe(false);
    // No historical build-permission config was inherited into the materialisation.
    const workspace = h.materializeWorkspace();
    expect(workspace === null || !workspace.includes('allowBuilds')).toBe(true);
    expect(workspace === null || !workspace.includes('onlyBuiltDependencies')).toBe(true);
  });

  it('keeps a source with an un-enumerable closure as unknown (never authorizable)', async () => {
    const h = harness({ failMaterialize: true });
    const outcome = await h.port.previewSource(SOURCE, new AbortController().signal, h.context);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.dependencyClosureEnumerated).toBe(false);
    expect(outcome.value.scriptAssessment).toBe('unknown');
    expect(outcome.value.requiresBuildAuthorization).toBe(true);
  });
});
