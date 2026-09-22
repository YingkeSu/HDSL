/**
 * A2 slice: generation-scoped managed profile publication, declaration-source
 * identity, and namespace-confined orphan GC (ADR 0006 §2.3 / S2 §1).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectOrphanProfiles,
  environmentPaths,
  managedProfileName,
  profileDeclarationFingerprint,
  publishGenerationProfile,
  resolveLayout,
} from '@hdsl/core';

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

  it('publishes a staged profile into the managed namespace', () => {
    const { layout, env } = build();
    const staged = join(layout.tmp, 'staged-profile');
    writeDeclaration(staged, ['@deepseek-ai/dsh-base']);
    const fingerprint = profileDeclarationFingerprint(staged);

    const result = publishGenerationProfile({
      layout,
      environmentId: ENVIRONMENT_ID,
      generationId: GENERATION_ID,
      stagedDirectory: staged,
    });
    const target = join(env.profilesDirectory, managedProfileName(GENERATION_ID));
    expect(result.fingerprint).toBe(fingerprint);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(staged)).toBe(false);
    expect(profileDeclarationFingerprint(target)).toBe(fingerprint);
  });

  it('refuses to overwrite a mismatching published profile', () => {
    const { layout, env } = build();
    const target = join(env.profilesDirectory, managedProfileName(GENERATION_ID));
    writeDeclaration(target, ['@deepseek-ai/dsh-base']);
    const staged = join(layout.tmp, 'staged-profile');
    writeDeclaration(staged, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

    expect(() =>
      publishGenerationProfile({
        layout,
        environmentId: ENVIRONMENT_ID,
        generationId: GENERATION_ID,
        stagedDirectory: staged,
      }),
    ).toThrow(/mismatching published profile/);
    // The published profile is untouched.
    expect(profileDeclarationFingerprint(target)).not.toBe(profileDeclarationFingerprint(staged));
    expect(existsSync(staged)).toBe(true);
  });

  it('collects only managed-namespace orphans and retains referenced profiles', () => {
    const { layout, env } = build();
    mkdirSync(env.profilesDirectory, { recursive: true });
    for (const name of ['hdsl-genA', 'hdsl-genB', 'hdsl-genC', 'web']) {
      writeDeclaration(join(env.profilesDirectory, name), ['@deepseek-ai/dsh-base']);
    }
    const removed = collectOrphanProfiles({
      layout,
      environmentId: ENVIRONMENT_ID,
      retain: new Set(['hdsl-genA', 'hdsl-genB']),
    });
    expect(removed).toEqual(['hdsl-genC']);
    expect(existsSync(join(env.profilesDirectory, 'hdsl-genA'))).toBe(true);
    expect(existsSync(join(env.profilesDirectory, 'hdsl-genB'))).toBe(true);
    expect(existsSync(join(env.profilesDirectory, 'hdsl-genC'))).toBe(false);
    // User/default profiles are never collected.
    expect(existsSync(join(env.profilesDirectory, 'web'))).toBe(true);
  });
});
