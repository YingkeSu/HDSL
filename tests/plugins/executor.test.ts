/**
 * Managed pnpm executor: verified artifact + extraction binds + explicit
 * invocation (ADR 0005 D14). Offline: synthetic tarball + recording execute seam.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManagedPnpmExecutor, executorTreeDigest, type PluginExecutorRunRequest, type PnpmExecutorSpec } from '@hdsl/runtime';
import { buildTarGz } from '../install/tar-builder.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PACKAGE_JSON = JSON.stringify({ name: 'pnpm', version: '11.7.0' });
const ENTRY = '#!/usr/bin/env node\n';

const pnpmTarball = (withEntry = true): Buffer =>
  buildTarGz([
    { name: 'package/', type: 'dir' as const, mode: 0o755 },
    { name: 'package/bin/', type: 'dir' as const, mode: 0o755 },
    { name: 'package/package.json', type: 'file' as const, content: PACKAGE_JSON },
    ...(withEntry ? [{ name: 'package/bin/pnpm.mjs', type: 'file' as const, mode: 0o755, content: ENTRY }] : []),
  ]);

const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const sha256Of = (value: string): string => createHash('sha256').update(value).digest('hex');

const specFor = (bytes: Buffer, overrides: Partial<PnpmExecutorSpec> = {}): PnpmExecutorSpec => {
  // The extracted tree (stripComponents:1) is reproduced directly to compute the
  // expected entry/tree digests, matching the executor's digest scheme.
  const stage = mkdtempSync(join(tmpdir(), 'hdsl-executor-stage-'));
  try {
    mkdirSync(join(stage, 'bin'), { recursive: true });
    writeFileSync(join(stage, 'package.json'), PACKAGE_JSON);
    writeFileSync(join(stage, 'bin', 'pnpm.mjs'), ENTRY);
    return {
      id: 'pnpm',
      version: '11.7.0',
      url: 'https://registry.invalid/pnpm.tgz',
      sha512: integrity(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      entryPath: 'bin/pnpm.mjs',
      entrySha256: sha256Of(ENTRY),
      treeSha256: executorTreeDigest(stage),
      ...overrides,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

const fakeFetch = (bytes: Buffer) => async (): Promise<Response> =>
  new Response(new Uint8Array(bytes), { status: 200 });

const request = (cwd: string): PluginExecutorRunRequest => ({
  cwd,
  homeDirectory: cwd,
  nodeExecutable: join(cwd, 'node', 'bin', 'node'),
  args: ['install', '--ignore-scripts'],
});

describe('managed pnpm executor', () => {
  it('verifies artifact + extraction binds and runs with explicit argv/env (no host PATH)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hdsl-executor-'));
    roots.push(cwd);
    const tarball = pnpmTarball();
    const calls: { args: readonly string[]; cwd: string; env: Record<string, string> }[] = [];
    const executor = createManagedPnpmExecutor({
      spec: specFor(tarball),
      cacheDirectory: join(cwd, 'cache'),
      fetch: fakeFetch(tarball),
      execute: async (_executable, args, options) => {
        calls.push({ args, cwd: options.cwd, env: options.env as Record<string, string> });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });

    const identity = await executor.identity(new AbortController().signal);
    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.value.entrySha256).toBe(sha256Of(ENTRY));
      expect(identity.value.treeSha256).toHaveLength(64);
    }

    const outcome = await executor.run(request(cwd), new AbortController().signal);
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.args[0]?.endsWith('bin/pnpm.mjs')).toBe(true);
    expect(calls[0]?.args.slice(1)).toEqual(['install', '--ignore-scripts']);
    expect(calls[0]?.env['PATH']).toBe(`${join(cwd, 'node', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(calls[0]?.env['npm_config_registry']).toBe('https://registry.npmjs.org');
  });

  it('runs the caller-provided managed Node with a bounded timeout (never process.execPath)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hdsl-executor-timeout-'));
    roots.push(cwd);
    const tarball = pnpmTarball();
    const calls: { executable: string; timeoutMs: number }[] = [];
    const executor = createManagedPnpmExecutor({
      spec: specFor(tarball),
      cacheDirectory: join(cwd, 'cache'),
      fetch: fakeFetch(tarball),
      execute: async (executable, _args, options) => {
        calls.push({ executable, timeoutMs: options.timeoutMs });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });

    // Regression (QA33 real desktop hang): the child must run under the managed
    // Node from the request, never the host process binary. Inside Electron
    // `process.execPath` is Electron and never exits.
    const managedNode = join(cwd, 'generation', 'node', 'bin', 'node');
    const bounded = await executor.run(
      { ...request(cwd), nodeExecutable: managedNode, timeoutMs: 1_234 },
      new AbortController().signal,
    );
    expect(bounded.ok).toBe(true);
    expect(calls[0]?.executable).toBe(managedNode);
    expect(calls[0]?.executable).not.toBe(process.execPath);
    expect(calls[0]?.timeoutMs).toBe(1_234);

    // A caller that does not pass one still gets the executor's own bound.
    await executor.run({ ...request(cwd), nodeExecutable: managedNode }, new AbortController().signal);
    expect(calls[1]?.timeoutMs).toBeGreaterThan(0);
  });

  it('fails closed on an artifact integrity mismatch without executing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hdsl-executor-'));
    roots.push(cwd);
    let executed = 0;
    const executor = createManagedPnpmExecutor({
      spec: specFor(pnpmTarball(), { sha512: integrity(Buffer.from('other')), sha256: '0'.repeat(64) }),
      cacheDirectory: join(cwd, 'cache'),
      fetch: fakeFetch(pnpmTarball()),
      execute: async () => {
        executed += 1;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    const outcome = await executor.run(request(cwd), new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('EXECUTOR_UNAVAILABLE');
    }
    expect(executed).toBe(0);
  });

  it('fails closed when the extracted entry/tree does not match the pinned digests', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hdsl-executor-'));
    roots.push(cwd);
    const tarball = pnpmTarball();
    const executor = createManagedPnpmExecutor({
      spec: specFor(tarball, { entrySha256: 'a'.repeat(64) }),
      cacheDirectory: join(cwd, 'cache'),
      fetch: fakeFetch(tarball),
    });
    const outcome = await executor.identity(new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('EXECUTOR_UNAVAILABLE');
    }
  });

  it('detects a tampered cached extraction and refuses to execute it (tamper negative control)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hdsl-executor-'));
    roots.push(cwd);
    const tarball = pnpmTarball();
    const spec = specFor(tarball);
    const cacheDirectory = join(cwd, 'cache');
    let executed = 0;
    const executor = createManagedPnpmExecutor({
      spec,
      cacheDirectory,
      fetch: fakeFetch(tarball),
      execute: async () => {
        executed += 1;
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    expect((await executor.identity(new AbortController().signal)).ok).toBe(true);

    // Tamper with the cached entry only (archive stays authentic): the executor
    // must re-extract from the verified archive, not trust the cached tree.
    const entry = join(cacheDirectory, 'pnpm', spec.version, spec.sha256, 'package', 'bin', 'pnpm.mjs');
    writeFileSync(entry, '#!/usr/bin/env node\nrequire("child_process");\n');

    const outcome = await executor.run(request(cwd), new AbortController().signal);
    expect(outcome.ok).toBe(true);
    expect(executed).toBe(1);
    // The executed entry is the authentic one again.
    const { readFileSync } = await import('node:fs');
    expect(createHash('sha256').update(readFileSync(entry)).digest('hex')).toBe(spec.entrySha256);
  });
});
