/**
 * Synthetic (network-free) catalog artifacts for installer boundary tests.
 *
 * These are explicitly fixtures: the opt-in real-install evidence test uses the
 * audited `VERIFIED_COMBINATIONS` instead.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeCombinationSchema, type Arch, type Platform, type RuntimeCombination } from '@hdsl/contracts';
import { combinationId } from '@hdsl/runtime';
import { buildTarGz } from './tar-builder.js';

export const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

export const syntheticNodeTarball = (version: string): Buffer =>
  buildTarGz([
    { name: `node-v${version}-darwin-arm64/`, type: 'dir', mode: 0o755 },
    { name: `node-v${version}-darwin-arm64/bin/`, type: 'dir', mode: 0o755 },
    {
      name: `node-v${version}-darwin-arm64/bin/node`,
      type: 'file',
      mode: 0o755,
      content: `#!/bin/sh\necho v${version}\n`,
    },
  ]);

export const syntheticDshTarball = (version: string): Buffer =>
  buildTarGz([
    { name: 'package/', type: 'dir', mode: 0o755 },
    { name: 'package/lib/', type: 'dir', mode: 0o755 },
    {
      name: 'package/package.json',
      type: 'file',
      content: `${JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }, null, 2)}\n`,
    },
    {
      name: 'package/lib/bin.js',
      type: 'file',
      mode: 0o755,
      content: `#!/usr/bin/env node\nconsole.log('${version}');\n`,
    },
  ]);

export interface SyntheticCombinationInput {
  readonly nodeVersion: string;
  readonly nodeTarball: Buffer;
  readonly dshVersion: string;
  readonly dshTarball: Buffer;
  readonly id?: string;
  readonly nodeSha256Override?: string;
  readonly platform?: Platform;
  readonly arch?: Arch;
  readonly compatibility?: 'verified' | 'unverified';
  /** Replaces `https://fixture.invalid` so tests can point at a local server. */
  readonly urlBase?: string;
}

export const syntheticCombination = (input: SyntheticCombinationInput): RuntimeCombination => {
  const platform = input.platform ?? 'darwin';
  const arch = input.arch ?? 'arm64';
  const nodeSha = input.nodeSha256Override ?? sha256(input.nodeTarball);
  const dshSha = sha256(input.dshTarball);
  const urlBase = input.urlBase ?? 'https://fixture.invalid';
  const combination: RuntimeCombination = {
    id: input.id ?? combinationId(platform, arch, input.nodeVersion, input.dshVersion),
    platform,
    arch,
    node: { version: input.nodeVersion, platform, arch, sha256: nodeSha },
    dsh: { version: input.dshVersion, platform, arch, sha256: dshSha },
    compatibility: { status: input.compatibility ?? 'verified', evidenceRef: 'tests/install/fixture' },
    artifactLocations: {
      node: {
        version: input.nodeVersion,
        platform,
        arch,
        url: `${urlBase}/node-${nodeSha}.tgz`,
        sha256: nodeSha,
      },
      dsh: {
        version: input.dshVersion,
        platform,
        arch,
        url: `${urlBase}/dsh-${dshSha}.tgz`,
        sha256: dshSha,
      },
    },
  };
  const issues: import('@hdsl/contracts').ValidationIssue[] = [];
  const parsed = runtimeCombinationSchema(combination, 'combination', issues);
  if (parsed === undefined) {
    throw new Error(`synthetic combination is invalid: ${JSON.stringify(issues)}`);
  }
  return parsed;
};

/** Writes `<root>/<sha256>/<name>` for the `localArtifactDirectory` option. */
export const writeLocalArtifact = (
  root: string,
  digest: string,
  tarball: Buffer,
  name = 'artifact.tgz',
): string => {
  const directory = join(root, digest);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, tarball);
  return path;
};
