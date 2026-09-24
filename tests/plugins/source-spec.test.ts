/**
 * #141: the pnpm TRANSPORT spec is the same commit's official codeload tarball,
 * while the recorded SOURCE stays GitHub + full commit. These are pure,
 * offline, deterministic checks: full pin (no floating ref), fixed host, and the
 * plan-inputs binding that makes a pre-change plan `PLAN_STALE` at apply.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CODELOAD_HOST, buildPreviewResolution, pluginTransportSpec } from '@hdsl/runtime';

const COMMIT = 'feb77307b45e9c4a9890e385748eebe5a919eb1b';

describe('pluginTransportSpec (#141)', () => {
  it('builds the exact official codeload URL for a full commit pin', () => {
    expect(pluginTransportSpec({ owner: 'Hisn00w', name: 'ASu-skills' }, COMMIT)).toBe(
      `https://codeload.github.com/Hisn00w/ASu-skills/tar.gz/${COMMIT}`,
    );
  });

  it('fixes the transport host to codeload.github.com and never emits a github: spec', () => {
    expect(CODELOAD_HOST).toBe('codeload.github.com');
    const spec = pluginTransportSpec({ owner: 'octo', name: 'demo' }, COMMIT);
    expect(spec.startsWith(`https://${CODELOAD_HOST}/octo/demo/tar.gz/`)).toBe(true);
    expect(spec).not.toContain('github:');
    expect(spec).not.toContain('git+');
  });

  it('refuses non-40-hex (floating) refs', () => {
    for (const ref of ['main', 'master', 'v1.0.0', 'HEAD', 'abc1234', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), '']) {
      expect(() => pluginTransportSpec({ owner: 'octo', name: 'demo' }, ref), ref).toThrow();
    }
  });

  it('refuses owner/name that could change the host or escape the path', () => {
    for (const source of [
      { owner: 'octo/../evil', name: 'demo' },
      { owner: 'octo', name: '../../evil' },
      { owner: 'octo', name: 'demo?x=1' },
      { owner: 'octo', name: 'demo#frag' },
      { owner: 'octo:443', name: 'demo' },
      { owner: '', name: 'demo' },
      { owner: 'octo', name: '' },
    ]) {
      expect(() => pluginTransportSpec(source, COMMIT), JSON.stringify(source)).toThrow();
    }
  });
});

describe('plan inputs binding covers the transport spec (#141)', () => {
  const source = { owner: 'Hisn00w', name: 'ASu-skills' };
  const manifestText = JSON.stringify({
    name: 'asu-skills',
    version: '0.4.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });

  it('binds the transport spec so a pre-change (legacy) digest cannot match', () => {
    const outcome = buildPreviewResolution({
      source,
      resolved: { commitSha: COMMIT, manifestText, lockText: null },
      executor: null,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const manifestSha256 = createHash('sha256').update(manifestText, 'utf8').digest('hex');
    // The exact pre-#141 formula (no transport binding) — a plan stored under it
    // must no longer match, so apply rejects it as PLAN_STALE before any effect.
    const legacyDigest = createHash('sha256')
      .update(
        JSON.stringify({
          commitSha: COMMIT,
          manifestSha256,
          closureLockSha256: null,
          scripts: [],
          executor: null,
        }),
        'utf8',
      )
      .digest('hex');
    expect(outcome.value.planInputsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.value.planInputsDigest).not.toBe(legacyDigest);
    expect(outcome.value.planInputsDigest).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            commitSha: COMMIT,
            manifestSha256,
            closureLockSha256: null,
            scripts: [],
            executor: null,
            transportSpec: pluginTransportSpec(source, COMMIT),
          }),
          'utf8',
        )
        .digest('hex'),
    );
  });

  it('keeps the recorded SOURCE as GitHub provenance (not the transport form)', () => {
    const outcome = buildPreviewResolution({
      source,
      resolved: { commitSha: COMMIT, manifestText, lockText: null },
      executor: null,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.sourceLock.sourceKind).toBe('github');
    expect(outcome.value.sourceLock.repository).toEqual({ owner: 'Hisn00w', name: 'ASu-skills' });
    expect(outcome.value.sourceLock.commitSha).toBe(COMMIT);
  });
});
