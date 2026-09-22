/**
 * `plugins.installed` read-only view (ADR 0005 D4/D15, #77 S3).
 *
 * The list is bound to ONE read of the environment record plus its ACTIVE
 * generation's `composition.lock.json` and immutable declaration source, so
 * `revision`/`generationId`/`plugins` are always same-source. There is
 * deliberately NO state guard: a running environment can be listed (the handler
 * never reports `ENVIRONMENT_BUSY`).
 *
 * `isBuiltin` comes from the CURRENT managed install's in-box bundle set (F12a),
 * resolved through an injected structural resolver — never from the client, the
 * profile dependencies or a same-name package. A resolver that cannot prove the
 * in-box set is a controlled failure, never an empty set.
 */
import { join } from 'node:path';
import {
  portFail,
  portOk,
  type CompositionLock,
  type InstalledPlugin,
  type InstalledPluginsView,
  type PortOutcome,
} from '@hdsl/contracts';
import { tryReadJsonFile } from './fsx.js';
import { generationPaths, type AppDataLayout } from './layout.js';
import type { EnvironmentStore } from './environment-store.js';
import type { InstalledPluginsPort } from './ports.js';

/** Structural in-box resolver (runtime owns the concrete tree scan). */
export interface InBoxBundleResolver {
  resolveInBoxBundles(
    dshDirectory: string,
  ): readonly { readonly name: string; readonly version: string }[] | undefined;
}

export interface InstalledPluginsServiceOptions {
  readonly layout: AppDataLayout;
  readonly environments: EnvironmentStore;
  readonly inBox: InBoxBundleResolver;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readEnabledBundles = (path: string): readonly string[] => {
  const declaration = asRecord(tryReadJsonFile<unknown>(path));
  const dsh = asRecord(declaration?.['dsh']);
  const profile = asRecord(dsh?.['profile']);
  return Array.isArray(profile?.['bundles'])
    ? profile['bundles'].filter((entry): entry is string => typeof entry === 'string')
    : [];
};

export class InstalledPluginsService implements InstalledPluginsPort {
  readonly #layout: AppDataLayout;
  readonly #environments: EnvironmentStore;
  readonly #inBox: InBoxBundleResolver;

  constructor(options: InstalledPluginsServiceOptions) {
    this.#layout = options.layout;
    this.#environments = options.environments;
    this.#inBox = options.inBox;
  }

  list(environmentId: string): PortOutcome<InstalledPluginsView> {
    const environment = this.#environments.read(environmentId);
    if (environment === undefined) {
      return portFail('NOT_FOUND', 'environment was not found');
    }
    const generationId = environment.activeGenerationId;
    if (generationId === null) {
      // A created-but-uncommitted environment has no composition: an empty list is
      // the honest answer, not a fabricated generation id.
      return portOk({ environmentId, revision: environment.revision, generationId: null, plugins: [] });
    }
    const paths = generationPaths(this.#layout, environmentId, generationId);
    const lock = tryReadJsonFile<CompositionLock>(paths.lockPath);
    if (lock === undefined) {
      return portFail('INTERNAL_ERROR', 'the active generation has no composition lock');
    }
    const inBox = this.#inBox.resolveInBoxBundles(paths.dshDirectory);
    if (inBox === undefined) {
      return portFail('INTERNAL_ERROR', 'the in-box bundle set of the managed install could not be resolved');
    }
    const inBoxNames = new Set(inBox.map((bundle) => bundle.name));
    const enabled = new Set(
      readEnabledBundles(join(paths.generationDirectory, 'profile', 'package.json')),
    );
    const sources = lock.pluginSources ?? {};
    const plugins: InstalledPlugin[] = lock.plugins.map((plugin) => {
      const source = sources[plugin.id];
      return {
        id: plugin.id,
        version: plugin.version,
        sha256: plugin.sha256,
        isBuiltin: inBoxNames.has(plugin.id),
        enabledBundle: enabled.has(plugin.id),
        source:
          source === undefined
            ? null
            : { owner: source.repository.owner, name: source.repository.name, commitSha: source.commitSha },
      };
    });
    return portOk({ environmentId, revision: environment.revision, generationId, plugins });
  }
}
