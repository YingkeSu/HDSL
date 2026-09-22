/**
 * #92-adjacent S5 slice: managed-pnpm NON-ZERO classification for the plugin
 * INSTALL apply boundary (issue Refs #79).
 *
 * The three install phases of `createPluginApplyPort` (default-deny
 * materialisation for enumeration, authorized install, regular default-deny
 * install) must reuse the SINGLE frozen classification used by removal, never a
 * second drifting rule set. A fake managed executor returns a non-zero exit with
 * a chosen stderr; only the injected executor is fake.
 *
 * Asserted per phase: pre-connect -> `NETWORK_UNAVAILABLE`, established-transfer
 * failure -> `DOWNLOAD_FAILED`, unreliable/403/429/unknown -> sanitized
 * non-retryable `INTERNAL_ERROR`, and NO stderr text (canary) leaks into the
 * error message.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildAuthorization, CompositionLock, ExecutorIdentity, PluginSourceSelector } from '@hdsl/contracts';
import {
  buildPreviewResolution,
  createPluginApplyPort,
  type GitProvider,
  type PluginExecutorPort,
} from '@hdsl/runtime';

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
const CANARY = 'hdsl-canary-9f2c-secret';
const PLUGIN_KEY = `hdsl-plugin-demo@https://codeload.github.com/octo/hdsl-plugin-demo/tar.gz/${COMMIT}`;
const LOCK_TEXT = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    dependencies:',
  '      hdsl-plugin-demo:',
  '        specifier: github:octo/hdsl-plugin-demo',
  `        version: ${PLUGIN_KEY.slice(PLUGIN_KEY.indexOf('@') + 1)}`,
  'packages:',
  `  ${PLUGIN_KEY}:`,
  '    version: 1.0.0',
  '  shared-dep@1.2.3:',
  '    version: 1.2.3',
  'snapshots:',
  `  ${PLUGIN_KEY}:`,
  '    dependencies:',
  '      shared-dep: 1.2.3',
  '  shared-dep@1.2.3: {}',
].join('\n');
const LOCK_SHA = createHash('sha256').update(LOCK_TEXT, 'utf8').digest('hex');
const MANIFEST_WITH_SCRIPTS = JSON.stringify({
  name: 'hdsl-plugin-demo',
  version: '1.0.0',
  dependencies: { 'shared-dep': '1.2.3' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  scripts: { preinstall: 'node p.js', install: 'node i.js', postinstall: 'node po.js', prepare: 'node pr.js' },
});
const MANIFEST_PLAIN = JSON.stringify({
  name: 'hdsl-plugin-demo',
  version: '1.0.0',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
});
const CURRENT_LOCK: CompositionLock = {
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [],
  sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } },
};
const TARGET_PROFILE = {
  lockText: LOCK_TEXT,
  declarationText: JSON.stringify({
    name: 'hdsl-profile',
    private: true,
    dependencies: { 'hdsl-plugin-demo': `github:octo/hdsl-plugin-demo#${COMMIT}` },
    dsh: { profile: { bundles: ['hdsl-plugin-demo'] } },
  }),
  workspaceText: null,
};

const harness = (options: { manifest: string; failAtIndex?: number; stderr?: string }) => {
  const runCalls: string[][] = [];
  const provider: GitProvider = {
    resolveManifest: async () => ({ ok: true, value: { commitSha: COMMIT, manifestText: options.manifest, lockText: null } }),
  };
  const executor: PluginExecutorPort = {
    identity: async () => ({ ok: true, value: EXECUTOR }),
    run: async (request) => {
      const index = runCalls.length;
      runCalls.push([...request.args]);
      if (options.failAtIndex === index && options.stderr !== undefined) {
        return {
          ok: true,
          value: { executor: EXECUTOR, exitCode: 1, stdout: '', stderr: options.stderr, executedInstallScripts: [] },
        };
      }
      // Successful default-deny materialisation: create the read-only installed
      // tree so the closure can be enumerated without executing anything.
      if (!request.args.includes('--ignore-scripts=false')) {
        mkdirSync(join(request.cwd, 'node_modules', 'shared-dep'), { recursive: true });
        writeFileSync(
          join(request.cwd, 'node_modules', 'shared-dep', 'package.json'),
          JSON.stringify({ name: 'shared-dep', version: '1.2.3', scripts: { postinstall: 'node dep.js' } }),
        );
        mkdirSync(join(request.cwd, 'node_modules', 'hdsl-plugin-demo'), { recursive: true });
        writeFileSync(
          join(request.cwd, 'node_modules', 'hdsl-plugin-demo', 'package.json'),
          JSON.stringify({ name: 'hdsl-plugin-demo', version: '1.0.0', scripts: JSON.parse(options.manifest).scripts ?? {} }),
        );
      }
      return { ok: true, value: { executor: EXECUTOR, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
    },
  };
  const built = buildPreviewResolution({
    source: SOURCE,
    resolved: { commitSha: COMMIT, manifestText: options.manifest, lockText: null },
    executor: EXECUTOR,
  });
  if (!built.ok) throw new Error('fixture resolution failed');
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-install-class-'));
  roots.push(dataRoot);
  const generationDirectory = join(dataRoot, 'gen');
  const port = createPluginApplyPort({ gitProvider: provider, executor });
  const plan = {
    planId: 'plan-0000000000000001',
    environmentId: 'env-0000000000000001',
    baseRevision: 1,
    action: { kind: 'install' as const, source: SOURCE },
    createdAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-22T01:00:00.000Z',
    sourceLock: { ...built.value.sourceLock, closureLockSha256: LOCK_SHA },
    scriptAssessment: built.value.scriptAssessment,
    scripts: [...built.value.scripts],
    requiresBuildAuthorization: built.value.requiresBuildAuthorization,
    riskItems: [...built.value.riskItems],
    removals: [],
    retention: [],
    blockingReferences: [],
    executor: built.value.executor,
    planInputsDigest: built.value.planInputsDigest,
  };
  const authorization = (): BuildAuthorization => ({
    commitSha: COMMIT,
    scripts: [...built.value.scripts, { packageName: 'shared-dep', packageVersion: '1.2.3', script: 'postinstall', source: 'dependency' }],
  });
  const stage = (buildAuthorization: BuildAuthorization | null) =>
    port.stage(
      {
        environmentId: 'env-0000000000000001',
        generationId: 'gen-0000000000000001',
        generationDirectory,
        environmentDirectory: join(generationDirectory, 'env'),
        homeDirectory: join(generationDirectory, 'home'),
        nodeExecutable: '/fixture/node',
        currentLock: CURRENT_LOCK,
        plan,
        targetProfile: TARGET_PROFILE,
        buildAuthorization,
      },
      new AbortController().signal,
    );
  return { stage, authorization, runCalls };
};

const CASES = [
  { label: 'pre-connect ENOTFOUND', stderr: `npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org (${CANARY})`, code: 'NETWORK_UNAVAILABLE' },
  { label: 'pre-connect ECONNREFUSED', stderr: `connect ECONNREFUSED 127.0.0.1:443 (${CANARY})`, code: 'NETWORK_UNAVAILABLE' },
  { label: 'pre-connect EAI_AGAIN', stderr: `getaddrinfo EAI_AGAIN registry.npmjs.org (${CANARY})`, code: 'NETWORK_UNAVAILABLE' },
  { label: 'transfer ECONNRESET', stderr: `socket hang up: ECONNRESET (${CANARY})`, code: 'DOWNLOAD_FAILED' },
  { label: 'transfer integrity', stderr: `ERR_PNPM_TARBALL_INTEGRITY expected sha512 ... (${CANARY})`, code: 'DOWNLOAD_FAILED' },
  { label: 'transfer bad size', stderr: `ERR_PNPM_BAD_TARBALL_SIZE (${CANARY})`, code: 'DOWNLOAD_FAILED' },
  { label: 'http 403 (no reliable rate signal)', stderr: `ERR_PNPM_FETCH_403 Forbidden (${CANARY})`, code: 'INTERNAL_ERROR' },
  { label: 'http 429 (no reliable rate signal)', stderr: `too many requests 429 (${CANARY})`, code: 'INTERNAL_ERROR' },
  { label: 'unknown', stderr: `some unexpected internal failure (${CANARY})`, code: 'INTERNAL_ERROR' },
] as const;

describe('managed-pnpm non-zero classification at the install apply boundary', () => {
  for (const phase of [
    { label: 'default-deny enumeration materialisation', failAtIndex: 0, manifest: MANIFEST_WITH_SCRIPTS, withAuthorization: true, reached: 1 },
    { label: 'authorized install', failAtIndex: 1, manifest: MANIFEST_WITH_SCRIPTS, withAuthorization: true, reached: 2 },
    { label: 'regular default-deny install', failAtIndex: 0, manifest: MANIFEST_PLAIN, withAuthorization: false, reached: 1 },
  ] as const) {
    for (const testCase of CASES) {
      it(`${phase.label}: ${testCase.label} -> ${testCase.code} with no stderr leak`, async () => {
        const harnessed = harness({ manifest: phase.manifest, failAtIndex: phase.failAtIndex, stderr: testCase.stderr });
        const outcome = await harnessed.stage(phase.withAuthorization ? harnessed.authorization() : null);
        expect(harnessed.runCalls).toHaveLength(phase.reached);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe(testCase.code);
        expect(outcome.message).not.toContain(CANARY);
        expect(outcome.message).not.toContain('registry.npmjs.org');
      });
    }
  }
});
