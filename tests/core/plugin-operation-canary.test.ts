/**
 * AC11 (operations scope): a plugin operation's terminal snapshot, error and
 * output must not carry a secret or an absolute local path, even when the
 * injected adapter throws with them in the message.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangePreviewService, resolveLayout, type PluginPreviewPort } from '@hdsl/core';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const SECRET = 'CANARY-token-abcdef0123456789';
const ABS = '/Users/operator/private/env';
const ENVIRONMENT_ID = 'env-0000000000000001';

const build = (port: PluginPreviewPort) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hdsl-op-canary-'));
  roots.push(dataRoot);
  return new ChangePreviewService({
    layout: resolveLayout(dataRoot),
    port,
    findEnvironment: (id) =>
      id === ENVIRONMENT_ID
        ? { id, name: 'canary', revision: 1, stateVersion: 1, state: 'stopped', activeGenerationId: null, compositionDigest: null }
        : undefined,
  });
};

const waitTerminal = async (service: ChangePreviewService, operationId: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const record = service.findOperation(operationId);
    if (record?.ok && ['succeeded', 'failed', 'cancelled'].includes(record.value.status)) return record.value;
    if (Date.now() > deadline) throw new Error('operation did not terminate');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('plugin operation output canaries (AC11)', () => {
  it('maps an adapter throw with a canary to a controlled error without the canary or path', async () => {
    const service = build({
      previewSource: async () => {
        throw new Error(`upstream failed at ${ABS} with token=${SECRET}`);
      },
    });
    const started = service.previewChange({
      requestId: 'req-canary',
      environmentId: ENVIRONMENT_ID,
      expectedRevision: 1,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo' } },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const snapshot = await waitTerminal(service, started.value.operationId);
    expect(snapshot.status).toBe('failed');
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(ABS);
    expect(snapshot.error?.code).toBe('INTERNAL_ERROR');
  });
});
