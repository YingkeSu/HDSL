/**
 * Renderer plugin install flow (issue #76, S2): direct repo input -> preview ->
 * confirm -> apply, against the TEST-ONLY reference runtime. Not evidence about
 * real GitHub or Electron behavior.
 */
import { describe, expect, it } from 'vitest';
import { RendererController } from '../../apps/desktop/src/renderer/controller.js';
import { createTestRendererClient } from './support/contract-client.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

describe('RendererController plugin install', () => {
  it('previews with the exact source and revision, then applies the returned plan', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    const stopped = controller.getState().environments.find((environment) => environment.state === 'stopped');
    expect(stopped).toBeDefined();
    if (stopped === undefined) {
      return;
    }
    controller.selectEnvironment(stopped.id);
    controller.setInstallSource('owner', 'octo');
    controller.setInstallSource('name', 'dsh-plugin-demo');
    controller.setInstallSource('ref', 'main');

    await controller.previewPluginChange();
    await flush();
    const preview = calls.find((call) => call.method === 'changes.preview');
    expect(preview?.input).toMatchObject({
      environmentId: stopped.id,
      expectedRevision: stopped.revision,
      action: { kind: 'install', source: { owner: 'octo', name: 'dsh-plugin-demo', ref: 'main' } },
    });
    const plan = controller.getState().changePlan;
    expect(plan).not.toBeNull();
    expect(plan?.sourceLock?.commitSha).toHaveLength(40);

    await controller.applyPluginChange();
    await flush();
    const apply = calls.find((call) => call.method === 'changes.apply');
    expect(apply?.input).toMatchObject({
      environmentId: stopped.id,
      expectedRevision: stopped.revision,
      planId: plan?.planId,
    });
    expect(controller.getState().changeApplication).not.toBeNull();

    await controller.dispose();
  });
});

describe('RendererController generation restore', () => {
  it('loads the generation list and issues a pointer-only restore for a non-active generation', async () => {
    const { client, calls } = createTestRendererClient();
    const controller = new RendererController({ client });
    await controller.load();
    const stopped = controller.getState().environments.find((environment) => environment.state === 'stopped');
    if (stopped === undefined) {
      return;
    }
    controller.selectEnvironment(stopped.id);
    await controller.loadGenerations();
    await flush();
    const listCall = calls.find((call) => call.method === 'generations.list');
    expect(listCall?.input).toMatchObject({ environmentId: stopped.id });

    await controller.restoreGeneration('gen-0000000000000002');
    await flush();
    const restoreCall = calls.find((call) => call.method === 'generations.restore');
    expect(restoreCall?.input).toMatchObject({
      environmentId: stopped.id,
      targetGenerationId: 'gen-0000000000000002',
    });
    await controller.dispose();
  });
});
