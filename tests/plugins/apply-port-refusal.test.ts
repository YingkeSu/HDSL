/**
 * AC4 default-deny refusal at the production apply boundary: a plugin requiring
 * install-time scripts, or exposing an unenumerated dependency closure, is
 * refused BEFORE the managed executor is ever invoked. No network, no fixture
 * execution: this is the policy assertion; the executed-closure marker evidence
 * is the opt-in `scripts/research/a2-ac4-production-negative-control-probe.mjs`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompositionLock, ExecutorIdentity, PluginSourceSelector } from '@hdsl/contracts';
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
const SOURCE: PluginSourceSelector = { owner: 'octo', name: 'dsh-plugin-demo', ref: 'main' };
const EXECUTOR: ExecutorIdentity = {
  id: 'pnpm',
  version: '11.7.0',
  sha256: '1'.repeat(64),
  entrySha256: '2'.repeat(64),
  treeSha256: '3'.repeat(64),
};

const CURRENT_LOCK: CompositionLock = {
  schemaVersion: '1',
  node: { version: '22.19.0', platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64) },
  dsh: { version: '0.1.5-rc.2', platform: 'darwin', arch: 'arm64', sha256: 'b'.repeat(64) },
  plugins: [],
  sources: { node: { url: 'https://x/n', sha256: 'a'.repeat(64) }, dsh: { url: 'https://x/d', sha256: 'b'.repeat(64) } },
};

const harness = (manifestText: string) => {
  const runCalls: { args: readonly string[] }[] = [];
  const provider: GitProvider = {
    resolveManifest: async () => ({ ok: true, value: { commitSha: COMMIT, manifestText, lockText: null } }),
  };
  const executor: PluginExecutorPort = {
    identity: async () => ({ ok: true, value: EXECUTOR }),
    run: async (request) => {
      runCalls.push({ args: request.args });
      return { ok: true, value: { executor: EXECUTOR, exitCode: 0, stdout: '', stderr: '', executedInstallScripts: [] } };
    },
  };
  const built = buildPreviewResolution({ source: SOURCE, resolved: { commitSha: COMMIT, manifestText, lockText: null }, executor: EXECUTOR });
  if (!built.ok) throw new Error('fixture resolution failed');
  const port = createPluginApplyPort({ gitProvider: provider, executor });
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-refusal-'));
  roots.push(dataRoot);
  return { port, runCalls, resolution: built.value, generationDirectory: join(dataRoot, 'gen') };
};

const stage = (harnessed: ReturnType<typeof harness>) =>
  harnessed.port.stage(
    {
      environmentId: 'env-0000000000000001',
      generationId: 'gen-0000000000000001',
      generationDirectory: harnessed.generationDirectory,
      environmentDirectory: join(harnessed.generationDirectory, 'env'),
      homeDirectory: join(harnessed.generationDirectory, 'home'),
      nodeExecutable: '/fixture/node',
      currentLock: CURRENT_LOCK,
      plan: {
        planId: 'plan-0000000000000001',
        environmentId: 'env-0000000000000001',
        baseRevision: 1,
        action: { kind: 'install', source: SOURCE },
        createdAt: '2026-09-22T00:00:00.000Z',
        expiresAt: '2026-09-22T01:00:00.000Z',
        sourceLock: harnessed.resolution.sourceLock,
        scriptAssessment: harnessed.resolution.scriptAssessment,
        scripts: [...harnessed.resolution.scripts],
        requiresBuildAuthorization: harnessed.resolution.requiresBuildAuthorization,
        riskItems: [...harnessed.resolution.riskItems],
        removals: [],
        retention: [],
        blockingReferences: [],
        executor: harnessed.resolution.executor,
        planInputsDigest: harnessed.resolution.planInputsDigest,
      },
      buildAuthorization: null,
    },
    new AbortController().signal,
  );

describe('AC4 production apply-boundary refusal', () => {
  it('refuses a root manifest with lifecycle scripts and never invokes the executor', async () => {
    const harnessed = harness(JSON.stringify({ name: 'dsh-plugin-demo', version: '1.0.0', scripts: { postinstall: 'node evil.js' }, dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    expect(harnessed.resolution.scriptAssessment).toBe('detected');
    const outcome = await stage(harnessed);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('BUILD_NOT_AUTHORIZED');
    expect(harnessed.runCalls).toHaveLength(0);
  });

  it('refuses an unenumerated dependency closure and never invokes the executor', async () => {
    const harnessed = harness(JSON.stringify({ name: 'dsh-plugin-demo', version: '1.0.0', dependencies: { 'some-dep': '^1.0.0' }, dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    expect(harnessed.resolution.scriptAssessment).toBe('unknown');
    const outcome = await stage(harnessed);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('BUILD_NOT_AUTHORIZED');
    expect(harnessed.runCalls).toHaveLength(0);
  });
});
