/**
 * B1 (#115): the `dsh.profile.bundles` reconciliation baseline.
 *
 * `dsh plugin add|remove` reconciles the bundle layer from dependency bundle
 * declarations; HDSL treats that rule as the baseline while keeping its own
 * managed transaction. The rule is pure and fail-open on UNKNOWN (#112: unknown
 * is not danger and never a reason to guess).
 */
import { describe, expect, it } from 'vitest';
import { declaresBundle, reconcileProfileBundles } from '@hdsl/runtime';

describe('declaresBundle', () => {
  it('is true only for a non-empty dsh.bundle.patch string', () => {
    expect(declaresBundle({ name: 'p', dsh: { bundle: { patch: './cordis.patch.yml' } } })).toBe(true);
  });

  it('is parsed false when the declaration fields are absent or empty', () => {
    expect(declaresBundle({ name: 'p' })).toBe(false);
    expect(declaresBundle({ name: 'p', dsh: {} })).toBe(false);
    expect(declaresBundle({ name: 'p', dsh: { bundle: {} } })).toBe(false);
    expect(declaresBundle({ name: 'p', dsh: { client: { platform: 'web' } } })).toBe(false);
  });

  it('is UNKNOWN (null) when the manifest or the declaration is malformed', () => {
    expect(declaresBundle(undefined)).toBeNull();
    expect(declaresBundle('not-a-manifest')).toBeNull();
    expect(declaresBundle({ dsh: 'nope' })).toBeNull();
    expect(declaresBundle({ dsh: { bundle: 'nope' } })).toBeNull();
    expect(declaresBundle({ dsh: { bundle: { patch: 42 } } })).toBeNull();
    expect(declaresBundle({ dsh: { bundle: { patch: '' } } })).toBeNull();
  });
});

describe('reconcileProfileBundles', () => {
  it('enters a bundle-declaring dependency and preserves templates + order', () => {
    const result = reconcileProfileBundles({
      currentBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      dependencies: [
        { name: '@deepseek-ai/dsh-base', declaresBundle: true },
        { name: 'demo-plugin', declaresBundle: true },
      ],
    });
    expect(result.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'demo-plugin']);
    expect(result.entered).toEqual(['demo-plugin']);
    expect(result.exited).toEqual([]);
    expect(result.unresolved).toEqual([]);
    // A template bundle that is not a profile dependency is left untouched.
    expect(result.bundles).toContain('@deepseek-ai/dsh-web-app');
  });

  it('exits an enabled dependency that lost its bundle declaration', () => {
    const result = reconcileProfileBundles({
      currentBundles: ['@deepseek-ai/dsh-base', 'demo-plugin'],
      dependencies: [
        { name: '@deepseek-ai/dsh-base', declaresBundle: true },
        { name: 'demo-plugin', declaresBundle: false },
      ],
    });
    expect(result.bundles).toEqual(['@deepseek-ai/dsh-base']);
    expect(result.exited).toEqual(['demo-plugin']);
  });

  it('exits an explicitly removed package even when it is no longer a dependency', () => {
    const result = reconcileProfileBundles({
      currentBundles: ['@deepseek-ai/dsh-base', 'demo-plugin'],
      dependencies: [{ name: '@deepseek-ai/dsh-base', declaresBundle: true }],
      removed: ['demo-plugin'],
    });
    expect(result.bundles).toEqual(['@deepseek-ai/dsh-base']);
    expect(result.exited).toEqual(['demo-plugin']);
  });

  it('is fail-open on UNKNOWN: an unreadable declaration is neither added nor evicted', () => {
    const present = reconcileProfileBundles({
      currentBundles: ['demo-plugin'],
      dependencies: [{ name: 'demo-plugin', declaresBundle: null }],
    });
    expect(present.bundles).toEqual(['demo-plugin']);
    expect(present.unresolved).toEqual(['demo-plugin']);

    const absent = reconcileProfileBundles({
      currentBundles: [],
      dependencies: [{ name: 'demo-plugin', declaresBundle: null }],
    });
    expect(absent.bundles).toEqual([]);
    expect(absent.unresolved).toEqual(['demo-plugin']);
  });

  it('never adds a dependency that declares no bundle', () => {
    const result = reconcileProfileBundles({
      currentBundles: ['@deepseek-ai/dsh-base'],
      dependencies: [
        { name: '@deepseek-ai/dsh-base', declaresBundle: true },
        { name: 'plain-dep', declaresBundle: false },
      ],
    });
    expect(result.bundles).toEqual(['@deepseek-ai/dsh-base']);
    expect(result.entered).toEqual([]);
  });
});
