/**
 * Removal context derivation (#77 S3).
 *
 * The removal resolution/apply needs paths that must NEVER come from the caller
 * or the UI: they are derived here from the environment record and the ACTIVE
 * generation record (ADR 0005 D21/D15). A missing active generation is a
 * controlled failure, not an empty/guessed context.
 */
import { join } from 'node:path';
import { portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import { environmentPaths, generationPaths, type AppDataLayout } from './layout.js';
import { managedProfileName } from './generation-profile.js';

/**
 * Structural minimum both `EnvironmentRecord` and `EnvironmentSummary` satisfy, so
 * the preview/adapter layers can pass either without widening the derivation.
 */
export interface RemovalEnvironmentRef {
  readonly id: string;
  readonly activeGenerationId: string | null;
}

export interface RemovalContextInput {
  readonly layout: AppDataLayout;
  readonly environment: RemovalEnvironmentRef | undefined;
  /** Isolated staging directory name suffix (e.g. the operation id). */
  readonly stagingKey: string;
}

export interface RemovalContext {
  readonly environmentId: string;
  readonly generationId: string;
  readonly declarationDirectory: string;
  readonly publishedProfileDirectory: string;
  readonly homeDirectory: string;
  readonly dshDirectory: string;
  readonly nodeExecutable: string;
  readonly stagingDirectory: string;
}

/**
 * Derives the removal context from the environment's ACTIVE generation only.
 * No parameter here accepts a path, so a caller cannot point the removal at
 * another generation, home or install tree.
 */
export const deriveRemovalContext = (input: RemovalContextInput): PortOutcome<RemovalContext> => {
  const environment = input.environment;
  if (environment === undefined) {
    return portFail('NOT_FOUND', 'environment was not found');
  }
  const generationId = environment.activeGenerationId;
  if (generationId === null) {
    return portFail('NOT_FOUND', 'the environment has no active generation');
  }
  const generation = generationPaths(input.layout, environment.id, generationId);
  const environmentRoot = environmentPaths(input.layout, environment.id);
  return portOk({
    environmentId: environment.id,
    generationId,
    declarationDirectory: join(generation.generationDirectory, 'profile'),
    publishedProfileDirectory: join(environmentRoot.profilesDirectory, managedProfileName(generationId)),
    homeDirectory: environmentRoot.homeDirectory,
    dshDirectory: generation.dshDirectory,
    nodeExecutable: join(generation.nodeDirectory, 'bin', 'node'),
    stagingDirectory: join(input.layout.tmp, `removal-${input.stagingKey}`),
  });
};

/** Runtime/loader identity the service verification is valid under. */
export interface RemovalRuntimeIdentity {
  readonly dshVersion: string;
  readonly dshSha256: string;
  readonly loaderVersion: string;
  readonly cordisVersion: string;
}

export interface RemovalInstalledLock {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
}

/** Structural mirror of the runtime removal resolution input (ADR 0005 D17). */
export interface RemovalResolveInput {
  readonly pluginId: string;
  readonly expectedCommitSha: string | null;
  readonly expectedManifestSha256: string | null;
  readonly declarationDirectory: string;
  readonly publishedProfileDirectory: string;
  readonly homeDirectory: string;
  readonly dshDirectory: string;
  readonly nodeExecutable: string;
  readonly stagingDirectory: string;
  readonly installed: readonly RemovalInstalledLock[];
  readonly enabledBundles: readonly string[];
  readonly runtime: RemovalRuntimeIdentity;
}

export interface RemovalApplyInput {
  readonly pluginId: string;
  readonly resolve: RemovalResolveInput;
  readonly planDeclarationText: string;
  readonly planLockText: string;
  readonly generationDirectory: string;
  readonly homeDirectory: string;
  readonly nodeExecutable: string;
}

export interface RemovalResolution {
  readonly removals: readonly string[];
  readonly retention: readonly string[];
  readonly riskItems: readonly string[];
  readonly blockingReferences: readonly {
    readonly pluginId: string;
    readonly kind: 'bundle' | 'config' | 'userPatch';
    readonly detail: string;
  }[];
  /** True when the target is an in-box bundle of the current managed DSH install. */
  readonly isBuiltin: boolean;
  readonly directDependencies: readonly string[];
  readonly retainedTargetInClosure: boolean;
  readonly targetLockText: string;
  readonly targetLockSha256: string;
  readonly targetDeclarationText: string;
  readonly targetWorkspaceText: string | null;
  readonly targetDeclarationSha256: string;
  readonly serviceVerification: { readonly status: 'known' | 'unknown'; readonly provides?: readonly string[] };
}

export interface RemovalApplyResult {
  readonly retainedLockDependencies: readonly string[];
  readonly lockSha256: string;
  readonly declarationSha256: string;
}

/** Removal adapter owned by `runtime` (paths come from `deriveRemovalContext`). */
export interface PluginRemovalPort {
  resolveRemoval(input: RemovalResolveInput, signal: AbortSignal): Promise<PortOutcome<RemovalResolution>>;
  applyRemoval(input: RemovalApplyInput, signal: AbortSignal): Promise<PortOutcome<RemovalApplyResult>>;
}

/**
 * Reads the trusted runtime/loader identity of a generation: the DSH identity from
 * its install manifest plus the managed cordis/loader versions from the install
 * tree. Missing/unreadable pieces are a controlled failure (never a default).
 */
export const readRemovalRuntimeIdentity = (input: {
  readonly installManifestPath: string;
  readonly dshDirectory: string;
  readonly readJson: (path: string) => unknown;
}): PortOutcome<RemovalRuntimeIdentity> => {
  const manifest = input.readJson(input.installManifestPath);
  const record = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : undefined;
  const dsh = record !== undefined && typeof record['dsh'] === 'object' && record['dsh'] !== null
    ? (record['dsh'] as Record<string, unknown>)
    : undefined;
  const versionOf = (directory: string): string | undefined => {
    const pkg = input.readJson(join(input.dshDirectory, 'node_modules', '@deepseek-ai', directory, 'package.json'));
    const entry = typeof pkg === 'object' && pkg !== null ? (pkg as Record<string, unknown>) : undefined;
    const version = entry === undefined ? undefined : entry['version'];
    return typeof version === 'string' && version !== '' ? version : undefined;
  };
  const dshVersion = dsh === undefined ? undefined : dsh['version'];
  const dshSha256 = dsh === undefined ? undefined : dsh['sha256'];
  const loaderVersion = versionOf('cordis-plugin-loader');
  const cordisVersion = versionOf('cordis');
  if (
    typeof dshVersion !== 'string' || dshVersion === '' ||
    typeof dshSha256 !== 'string' || dshSha256 === '' ||
    loaderVersion === undefined || cordisVersion === undefined
  ) {
    return portFail('INTERNAL_ERROR', 'the managed runtime/loader identity of this generation could not be established');
  }
  return portOk({ dshVersion, dshSha256, loaderVersion, cordisVersion });
};

/** Fully derived removal resolution input plus the active-generation context. */
export interface RemovalResolveContext {
  readonly context: RemovalContext;
  readonly resolve: RemovalResolveInput;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Assembles a removal resolution input from the environment's ACTIVE generation
 * (`composition.lock.json` plugins + `pluginSources`, the generation's immutable
 * declaration `dsh.profile.bundles`, and the trusted runtime identity). Both
 * `changes.preview` (kind remove) and the apply transaction use this ONE function
 * so a preview and an apply always resolve from the same derivation.
 *
 * The caller cannot supply a path: every path comes from
 * {@link deriveRemovalContext}. A generation without a recorded plugin
 * composition is a controlled `NOT_FOUND`, never an empty removal.
 */
export const buildRemovalResolveInput = (input: {
  readonly layout: AppDataLayout;
  readonly environment: RemovalEnvironmentRef | undefined;
  readonly pluginId: string;
  readonly stagingKey: string;
  readonly readJson: (path: string) => unknown;
  readonly expectedManifestSha256?: string | null;
}): PortOutcome<RemovalResolveContext> => {
  const context = deriveRemovalContext({
    layout: input.layout,
    environment: input.environment,
    stagingKey: input.stagingKey,
  });
  if (!context.ok) {
    return context;
  }
  const generation = generationPaths(input.layout, context.value.environmentId, context.value.generationId);
  const lockRecord = asRecord(input.readJson(generation.lockPath));
  const rawPlugins = lockRecord?.['plugins'];
  const installed: RemovalInstalledLock[] = Array.isArray(rawPlugins)
    ? rawPlugins.flatMap((entry) => {
        const record = asRecord(entry);
        const id = record?.['id'];
        const version = record?.['version'];
        const sha256 = record?.['sha256'];
        return typeof id === 'string' && typeof version === 'string' && typeof sha256 === 'string'
          ? [{ id, version, sha256 }]
          : [];
      })
    : [];
  if (installed.length === 0) {
    return portFail('NOT_FOUND', 'the active generation has no recorded plugin composition');
  }
  const declaration = asRecord(input.readJson(join(context.value.declarationDirectory, 'package.json')));
  const dsh = asRecord(declaration?.['dsh']);
  const profile = asRecord(dsh?.['profile']);
  const enabledBundles = Array.isArray(profile?.['bundles'])
    ? profile['bundles'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const identity = readRemovalRuntimeIdentity({
    installManifestPath: generation.manifestPath,
    dshDirectory: context.value.dshDirectory,
    readJson: input.readJson,
  });
  if (!identity.ok) {
    return identity;
  }
  const sources = asRecord(lockRecord?.['pluginSources']);
  const sourceRecord = asRecord(sources?.[input.pluginId]);
  const commitSha = typeof sourceRecord?.['commitSha'] === 'string' ? (sourceRecord['commitSha'] as string) : null;
  return portOk({
    context: context.value,
    resolve: {
      pluginId: input.pluginId,
      expectedCommitSha: commitSha,
      expectedManifestSha256: input.expectedManifestSha256 ?? null,
      declarationDirectory: context.value.declarationDirectory,
      publishedProfileDirectory: context.value.publishedProfileDirectory,
      homeDirectory: context.value.homeDirectory,
      dshDirectory: context.value.dshDirectory,
      nodeExecutable: context.value.nodeExecutable,
      stagingDirectory: context.value.stagingDirectory,
      installed,
      enabledBundles,
      runtime: identity.value,
    },
  });
};
