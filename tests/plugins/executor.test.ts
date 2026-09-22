/**
 * Managed pnpm executor: verified identity + explicit invocation (ADR 0005 D14).
 *
 * Offline: a synthetic pnpm tarball is served by a fake fetch and the command
 * execution is a recording seam, so no real pnpm is downloaded or run.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManagedPnpmExecutor, type PluginExecutorRunRequest } from '@hdsl/runtime';
import { buildTarGz } from '../install/tar-builder.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const pnpmTarball = (withEntry = true): Buffer =>
  buildTarGz([
    { name: 'package/', type: 'dir' as const, mode: 0o755 },
    { name: 'package/bin/', type: 'dir' as const, mode: 0o755 },
    { name: 'package/package.json', type: 'file' as const, content: JSON.stringify({ name: 'pnpm', version: '11.7.0' }) },
    ...(withEntry
      ? [{ name: 'package/bin/pnpm.mjs', type: 'file' as const, mode: 0o755, content: '#!/usr/bin/env node\n' }]
      : []),
  ]);

const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

const fakeFetch = (bytes: Buffer): ((url: string, init?: { signal?: AbortSignal }) => Promise<Response>) => {
  return async () => new Response(new Uint8Array(bytes), { status: 200 });
};

const request = (cwd: string): PluginExecutorRunRequest => ({
  cwd,
  homeDirectory: cwd,
  nodeExecutable: join(cwd, 'node', 'bin', 'node'),
  args: ['install', '--ignore-scripts'],
});

describe('managed pnpm executor', () => {
  it('verifies integrity, computes an identity and runs with an explicit argv/env (no host PATH)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hdsl-executor-'));
    roots.push(cwd);
    const tarball = pnpmTarball();
    const calls: { args: readonly string[]; cwd: string; env: Record<string, string> }[] = [];
    const executor = createManagedPnpmExecutor({
      spec: { id: 'pnpm', version: '11.7.0', url: 'https://registry.invalid/pnpm.tgz', sha512: integrity(tarball) },
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
      expect(identity.value).toEqual({
        id: 'pnpm',
        version: '11.7.0',
        sha256: createHash('sha256').update(tarball).digest('hex'),
      });
    }

    const outcome = await executor.run(request(cwd), new AbortController().signal);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.executedInstallScripts).toEqual([]);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }
    expect(call.args[0]?.endsWith('bin/pnpm.mjs')).toBe(true);
    expect(call.args.slice(1)).toEqual(['install', '--ignore-scripts']);
    expect(call.cwd).toBe(cwd);
    expect(call.env['PATH']).toBe(`${join(cwd, 'node', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(call.env['npm_config_registry']).toBe('https://registry.npmjs.org');
    expect(call.env['HOME']).toBe(cwd);
  });

  it('fails closed on an integrity mismatch without running anything', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hdsl-executor-'));
    roots.push(cwd);
    let executed = 0;
    const executor = createManagedPnpmExecutor({
      spec: { id: 'pnpm', version: '11.7.0', url: 'https://registry.invalid/pnpm.tgz', sha512: integrity(Buffer.from('different')) },
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

  it('fails closed when the artifact has no executable entry', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hdsl-executor-'));
    roots.push(cwd);
    const tarball = pnpmTarball(false);
    const executor = createManagedPnpmExecutor({
      spec: { id: 'pnpm', version: '11.7.0', url: 'https://registry.invalid/pnpm.tgz', sha512: integrity(tarball) },
      cacheDirectory: join(cwd, 'cache'),
      fetch: fakeFetch(tarball),
    });
    const outcome = await executor.identity(new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('EXECUTOR_UNAVAILABLE');
    }
  });
});
