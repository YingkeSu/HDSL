/**
 * `plugins.installed` semantics (ADR 0005 D4/D15, #77): read-only immediate, no
 * BUSY for a running environment, explicit empty when there is no active
 * generation, NOT_FOUND for an unknown environment, and a bounded list that is
 * never silently truncated.
 */
import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  createContractRuntime,
  type ContractPort,
  type InstalledPluginsView,
} from '@hdsl/contracts';
import { FIXTURE_IDS, FIXTURE_SEED, ReferenceContractPort } from '@hdsl/contracts/testing';

const dispatch = (port: ContractPort, environmentId: string) =>
  createContractRuntime({ port }).dispatch({
    apiVersion: API_VERSION,
    method: 'plugins.installed',
    input: { environmentId },
  });

describe('plugins.installed', () => {
  it('lists the active generation of a RUNNING environment without ENVIRONMENT_BUSY', () => {
    const port = new ReferenceContractPort(FIXTURE_SEED);
    const response = dispatch(port, FIXTURE_IDS.environment.running);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const view = response.value as InstalledPluginsView;
    expect(view.environmentId).toBe(FIXTURE_IDS.environment.running);
    expect(view.generationId).toBe(`gen-${FIXTURE_IDS.environment.running}`);
    expect(view.revision).toBe(3);
    expect(Array.isArray(view.plugins)).toBe(true);
  });

  it('returns generationId=null and an empty list when there is no active generation', () => {
    const port = new ReferenceContractPort({
      ...FIXTURE_SEED,
      environments: FIXTURE_SEED.environments.map((environment) =>
        environment.id === FIXTURE_IDS.environment.stopped
          ? { ...environment, activeGenerationId: null }
          : environment,
      ),
    });
    const response = dispatch(port, FIXTURE_IDS.environment.stopped);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const view = response.value as InstalledPluginsView;
    expect(view.generationId).toBeNull();
    expect(view.plugins).toEqual([]);
  });

  it('rejects an unknown environment with NOT_FOUND', () => {
    const port = new ReferenceContractPort(FIXTURE_SEED);
    const response = dispatch(port, 'env-does-not-exist');
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('NOT_FOUND');
  });

  it('never silently truncates: a port value above the bound is a controlled failure', () => {
    const base = new ReferenceContractPort(FIXTURE_SEED);
    const port = {
      ...base,
      host: base.host,
      listInstalledPlugins: (environmentId: string) => ({
        ok: true as const,
        value: {
          environmentId,
          revision: 3,
          generationId: 'gen-x',
          plugins: Array.from({ length: 129 }, (_unused, index) => ({
            id: `plugin-${String(index)}`,
            version: '1.0.0',
            sha256: 'a'.repeat(64),
            isBuiltin: false,
            enabledBundle: true,
            source: null,
          })),
        },
      }),
    } as unknown as ContractPort;
    const response = dispatch(port, FIXTURE_IDS.environment.running);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('INTERNAL_ERROR');
  });
});
