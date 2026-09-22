/**
 * A2 slice: generation-scoped managed profile publication, declaration-source
 * identity, and namespace-confined orphan GC (ADR 0006 §2.3 / S2 §1).
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  environmentPaths,
  managedProfileName,
  profileDeclarationFingerprint,
  publishGenerationProfile,
  resolveLayout,
} from '@hdsl/core';
import { profileDeclarationDigest } from '@hdsl/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ENVIRONMENT_ID = 'env-0123456789abcdef';
const GENERATION_ID = 'gen-0123456789abcdef';

const build = () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-gen-profile-'));
  roots.push(dataRoot);
  const layout = resolveLayout(dataRoot);
  const env = environmentPaths(layout, ENVIRONMENT_ID);
  mkdirSync(env.environmentDirectory, { recursive: true });
  return { layout, env };
};

const writeDeclaration = (directory: string, bundles: readonly string[]): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-test', dsh: { profile: { bundles } } }),
  );
  writeFileSync(join(directory, 'cordis.patch.yml'), '# patch\n');
};

describe('generation profile identity and publication', () => {
  it('fingerprints only the declaration source, excluding live derived files', () => {
    const { layout } = build();
    const staged = join(layout.tmp, 'staged-profile');
    writeDeclaration(staged, ['@deepseek-ai/dsh-base']);
    const before = profileDeclarationFingerprint(staged);

    // Live derived state must not change the identity.
    writeFileSync(join(staged, 'cordis.yml'), '[]\n');
    mkdirSync(join(staged, 'node_modules', '@deepseek-ai', 'x'), { recursive: true });
    writeFileSync(join(staged, 'node_modules', '@deepseek-ai', 'x', 'index.js'), 'x');
    expect(profileDeclarationFingerprint(staged)).toBe(before);

    // A declaration-source change does change the identity.
    writeDeclaration(staged, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    expect(profileDeclarationFingerprint(staged)).not.toBe(before);
  });

  it('publishes a staged profile into the managed namespace and preserves the immutable source', () => {
    const { layout, env } = build();
    const staged = join(layout.tmp, 'staged-profile');
    writeDeclaration(staged, ['@deepseek-ai/dsh-base']);
    const fingerprint = profileDeclarationFingerprint(staged);
    const sourceBytes = readFileSync(join(staged, 'package.json'), 'utf8');

    const result = publishGenerationProfile({
      layout,
      environmentId: ENVIRONMENT_ID,
      generationId: GENERATION_ID,
      transactionId: 'txn-test',
      stagedDirectory: staged,
    });
    const target = join(env.profilesDirectory, managedProfileName(GENERATION_ID));
    expect(result.fingerprint).toBe(fingerprint);
    expect(existsSync(target)).toBe(true);
    expect(profileDeclarationFingerprint(target)).toBe(fingerprint);
    // MF2: the staged immutable declaration source is preserved byte-for-byte.
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(join(staged, 'package.json'), 'utf8')).toBe(sourceBytes);
    expect(profileDeclarationFingerprint(staged)).toBe(fingerprint);
  });

  it('leaves the staged source unchanged when publication fails on a mismatching target', () => {
    const { layout, env } = build();
    const target = join(env.profilesDirectory, managedProfileName(GENERATION_ID));
    writeDeclaration(target, ['@deepseek-ai/dsh-base']);
    const staged = join(layout.tmp, 'staged-profile');
    writeDeclaration(staged, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    const sourceBytes = readFileSync(join(staged, 'package.json'), 'utf8');
    const sourceFingerprint = profileDeclarationFingerprint(staged);

    expect(() =>
      publishGenerationProfile({
        layout,
        environmentId: ENVIRONMENT_ID,
        generationId: GENERATION_ID,
        transactionId: 'txn-test',
        stagedDirectory: staged,
      }),
    ).toThrow(/mismatching published profile/);
    // Target untouched and the staged source is intact and unchanged.
    expect(profileDeclarationFingerprint(target)).not.toBe(sourceFingerprint);
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(join(staged, 'package.json'), 'utf8')).toBe(sourceBytes);
    expect(profileDeclarationFingerprint(staged)).toBe(sourceFingerprint);
  });

  it('fails closed when a declaration file is missing or is not a regular file (MF3)', () => {
    const { layout } = build();
    // Missing required package.json => no identity (never an empty digest).
    const bare = join(layout.tmp, 'bare-profile');
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'cordis.patch.yml'), '# patch\n');
    expect(profileDeclarationFingerprint(bare)).toBeUndefined();

    // Symlinked package.json must not be silently followed/hashed.
    const symlinked = join(layout.tmp, 'symlinked-profile');
    writeDeclaration(symlinked, ['@deepseek-ai/dsh-base']);
    const real = join(layout.tmp, 'real-package.json');
    writeFileSync(real, '{"name":"elsewhere"}');
    rmSync(join(symlinked, 'package.json'));
    symlinkSync(real, join(symlinked, 'package.json'));
    expect(lstatSync(join(symlinked, 'package.json')).isSymbolicLink()).toBe(true);
    expect(() => profileDeclarationFingerprint(symlinked)).toThrow(/not a regular file/);

    // A directory where a declaration file is expected also fails closed.
    const directory = join(layout.tmp, 'dir-profile');
    writeDeclaration(directory, ['@deepseek-ai/dsh-base']);
    mkdirSync(join(directory, 'pnpm-lock.yaml'), { recursive: true });
    expect(() => profileDeclarationFingerprint(directory)).toThrow(/not a regular file/);
  });
});

describe('core/runtime declaration digest parity', () => {
  it('agrees for full, partial, missing and illegal declaration sources', () => {
    const { layout } = build();

    const full = join(layout.tmp, 'parity-full');
    writeDeclaration(full, ['@deepseek-ai/dsh-base']);
    writeFileSync(join(full, 'pnpm-workspace.yaml'), 'packages:\n');
    writeFileSync(join(full, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    expect(profileDeclarationDigest(full)).toBe(profileDeclarationFingerprint(full));

    const partial = join(layout.tmp, 'parity-partial');
    writeDeclaration(partial, ['@deepseek-ai/dsh-base']);
    expect(profileDeclarationDigest(partial)).toBe(profileDeclarationFingerprint(partial));

    const bare = join(layout.tmp, 'parity-bare');
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'cordis.patch.yml'), '# patch\n');
    expect(profileDeclarationDigest(bare)).toBeUndefined();
    expect(profileDeclarationFingerprint(bare)).toBeUndefined();

    const link = join(layout.tmp, 'parity-link');
    writeDeclaration(link, ['@deepseek-ai/dsh-base']);
    const real = join(layout.tmp, 'parity-real.json');
    writeFileSync(real, '{"name":"elsewhere"}');
    rmSync(join(link, 'package.json'));
    symlinkSync(real, join(link, 'package.json'));
    expect(() => profileDeclarationDigest(link)).toThrow();
    expect(() => profileDeclarationFingerprint(link)).toThrow();
  });
});
