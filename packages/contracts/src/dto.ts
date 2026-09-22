/**
 * Shared DTO schemas and their inferred types (data-model.md is authoritative
 * for fields; this file is the executable copy).
 *
 * Each schema both produces the static type and validates untrusted values at
 * runtime, so a renderer-only type assertion can never smuggle an invalid DTO
 * into the bridge. `RuntimeArtifactRef` deliberately has **no** `url`: download
 * locations live on `RuntimeArtifact` / `RuntimeCombination.artifactLocations`
 * and on `CompositionLock.sources`, and never enter the composition digest.
 */
import { contractErrorSchema } from './errors.js';
import { sanitizeBoundedMessage } from './redaction.js';
import {
  catalogCombinationIdSchema,
  environmentIdSchema,
  exportIdSchema,
  generationIdSchema,
  nameSchema,
  opaqueIdSchema,
  operationIdSchema,
  planIdSchema,
  pluginIdSchema,
  revisionSchema,
  sha256Schema,
  subscriptionIdSchema,
} from './ids.js';
import { archSchema, platformSchema } from './platform.js';
import {
  sArray,
  sBoolean,
  sBooleanLiteral,
  sInteger,
  sLiteral,
  sNullable,
  sNumber,
  sObject,
  sOptional,
  sString,
  sUnknown,
  type Infer,
  type Schema,
} from './schema.js';

const artifactVersionSchema = sString({
  minLength: 1,
  maxLength: 64,
  pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
  patternHint: 'must be an exact version label',
});

const downloadUrlSchema = sString({
  minLength: 1,
  maxLength: 2048,
  pattern: /^https?:\/\//,
  patternHint: 'must be an http(s) URL',
});

/** RuntimeArtifactRef: the digest-eligible artifact identity, without a URL. */
export const runtimeArtifactRefSchema = sObject({
  version: artifactVersionSchema,
  platform: platformSchema,
  arch: archSchema,
  sha256: sha256Schema,
});
export type RuntimeArtifactRef = Infer<typeof runtimeArtifactRefSchema>;

/** Download location retained for provenance but excluded from the digest. */
export const artifactSourceSchema = sObject({
  url: downloadUrlSchema,
  sha256: sha256Schema,
});
export type ArtifactSource = Infer<typeof artifactSourceSchema>;

/** Full audited catalog record; the URL is a parallel location, not a ref. */
export const runtimeArtifactSchema = sObject({
  version: artifactVersionSchema,
  platform: platformSchema,
  arch: archSchema,
  url: downloadUrlSchema,
  sha256: sha256Schema,
});
export type RuntimeArtifact = Infer<typeof runtimeArtifactSchema>;

export const pluginLockSchema = sObject({
  id: pluginIdSchema,
  version: artifactVersionSchema,
  sha256: sha256Schema,
});
export type PluginLock = Infer<typeof pluginLockSchema>;

/**
 * CompositionLock: the immutable composition recorded for a generation.
 *
 * `sources` keeps the download URLs actually used at creation time (issue #15
 * N3: provenance must be retained). `compositionDigestInput` selects only the
 * version/platform/arch/sha256 subset, so `sources` can never change the
 * digest. `plugins` is schema-defined but empty in the first slice.
 */
export const compositionLockSchema = sObject({
  schemaVersion: sLiteral('1'),
  node: runtimeArtifactRefSchema,
  dsh: runtimeArtifactRefSchema,
  plugins: sArray(pluginLockSchema),
  sources: sObject({
    node: artifactSourceSchema,
    dsh: artifactSourceSchema,
  }),
});
export type CompositionLock = Infer<typeof compositionLockSchema>;

export const compatibilitySchema = sObject({
  status: sLiteral('verified', 'unverified'),
  evidenceRef: sString({ minLength: 1, maxLength: 256 }),
});
export type RuntimeCompatibility = Infer<typeof compatibilitySchema>;

/** RuntimeCombination: a catalog entry returned by `catalog.list`. */
export const runtimeCombinationSchema = sObject({
  id: catalogCombinationIdSchema,
  platform: platformSchema,
  arch: archSchema,
  node: runtimeArtifactRefSchema,
  dsh: runtimeArtifactRefSchema,
  compatibility: compatibilitySchema,
  artifactLocations: sObject({
    node: runtimeArtifactSchema,
    dsh: runtimeArtifactSchema,
  }),
});
export type RuntimeCombination = Infer<typeof runtimeCombinationSchema>;

export const environmentStateSchema = sLiteral(
  'creating',
  'stopped',
  'starting',
  'running',
  'stopping',
  'error',
);
export type EnvironmentState = Infer<typeof environmentStateSchema>;

export const operationStatusSchema = sLiteral(
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
);
export type OperationStatus = Infer<typeof operationStatusSchema>;

export const operationKindSchema = sLiteral(
  'create',
  'start',
  'stop',
  'openWebUI',
  'export',
  // 1.1 plugin discovery (ADR 0005 D4/D5).
  'search',
  'inspect',
  // 1.1 plugin transactions (ADR 0005 D4/D5, S2).
  'preview',
  'apply',
  'restore',
);
export type OperationKind = Infer<typeof operationKindSchema>;

/** `OperationSnapshot.phase` / `operation.updated` phase share this bound. */
export const OPERATION_PHASE_MAX_LENGTH = 64;

export const operationPhaseSchema = sString({
  minLength: 1,
  maxLength: OPERATION_PHASE_MAX_LENGTH,
});

/**
 * Canonicalizes a free-text operation `phase` before it crosses the bridge:
 * secret/path redaction plus the `operationPhaseSchema` code-point bound, so the
 * response (`operations.get` / `operations.cancel`) and event channels apply
 * the same postcondition to the same field (issue #29).
 */
export const sanitizeOperationPhase = (phase: string): string =>
  sanitizeBoundedMessage(phase, OPERATION_PHASE_MAX_LENGTH);

/** EnvironmentSummary: read-only list view without secrets or local paths. */
export const environmentSummarySchema = sObject({
  id: environmentIdSchema,
  name: nameSchema,
  revision: revisionSchema,
  stateVersion: revisionSchema,
  state: environmentStateSchema,
  activeGenerationId: sNullable(generationIdSchema),
  compositionDigest: sNullable(sha256Schema),
});
export type EnvironmentSummary = Infer<typeof environmentSummarySchema>;

/**
 * OperationSnapshot includes the final error, sequence and optional progress.
 *
 * `output` is the optional terminal result payload (ADR 0005 D5); it is
 * required for a succeeded `search`/`inspect` and must be absent for
 * queued/running/failed/cancelled and for every pre-1.1 kind. The dispatcher
 * enforces that rule with a per-kind schema, so the loose `sUnknown` here is
 * never what crosses the bridge.
 */
export const operationSnapshotSchema = sObject({
  id: operationIdSchema,
  environmentId: sNullable(environmentIdSchema),
  kind: operationKindSchema,
  phase: operationPhaseSchema,
  status: operationStatusSchema,
  sequence: sInteger({ min: 0 }),
  progress: sOptional(sNumber({ min: 0, max: 100 })),
  error: sOptional(sNullable(contractErrorSchema)),
  output: sOptional(sUnknown()),
});
export type OperationSnapshot = Infer<typeof operationSnapshotSchema>;

export const operationRefSchema = sObject({ operationId: operationIdSchema });
export type OperationRef = Infer<typeof operationRefSchema>;

export const subscriptionRefSchema = sObject({ subscriptionId: subscriptionIdSchema });
export type SubscriptionRef = Infer<typeof subscriptionRefSchema>;

export const runtimeCombinationListSchema = sArray(runtimeCombinationSchema);
export const environmentSummaryListSchema = sArray(environmentSummarySchema);

export const exportResultSchema = sObject({
  exportId: exportIdSchema,
  exported: sBooleanLiteral(true),
  redacted: sBooleanLiteral(true),
});
export type ExportResult = Infer<typeof exportResultSchema>;

/** Only the loopback origin is exposed; the token URL never leaves main. */
export const openWebUIResultSchema = sObject({
  loopbackOrigin: sString({ minLength: 1, maxLength: 128 }),
});
export type OpenWebUIResult = Infer<typeof openWebUIResultSchema>;

/** GitHub owner (user/org login): letters, digits and internal hyphens only. */
const githubOwnerSchema = sString({
  minLength: 1,
  maxLength: 64,
  pattern: /^[A-Za-z0-9][A-Za-z0-9-]*$/,
  patternHint: 'must be a GitHub owner login',
});

/**
 * GitHub repository name. Real names may contain `.`, `_` and `-`
 * (e.g. `Unclecheng-li/AI_Animation`), so only path separators/URL syntax are
 * rejected; the value is never used as a local path in this slice.
 */
const githubRepoSchema = sString({
  minLength: 1,
  maxLength: 100,
  pattern: /^[A-Za-z0-9._-]+$/,
  patternHint: 'must be a GitHub repository name',
});

/** Optional ref (branch/tag/commit label): no whitespace or URL syntax. */
const githubRefSchema = sString({
  minLength: 1,
  maxLength: 128,
  pattern: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  patternHint: 'must be a bounded git ref',
});

/** Public GitHub repository URL; credentials/query/fragment are not allowed. */
const githubHtmlUrlSchema = sString({
  minLength: 1,
  maxLength: 2048,
  pattern: /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/,
  patternHint: 'must be a public https://github.com repository URL',
});

/** Default discovery query (issue #75): topic + fork/archived exclusion. */
export const DEFAULT_PLUGIN_QUERY = 'topic:dsh-plugin fork:false archived:false';

export const PLUGIN_QUERY_MIN_LENGTH = 1;
export const PLUGIN_QUERY_MAX_LENGTH = 256;
export const PLUGIN_TOPICS_MAX = 50;
export const PLUGIN_HITS_MAX = 100;

/** GitHub repository search only paginates the first 1000 results. */
export const GITHUB_SEARCH_RESULT_LIMIT = 1000;
export const PLUGIN_SEARCH_PAGE_SIZE = 100;

/**
 * `plugins.search` / `plugins.inspect` source selector. Only a GitHub
 * `owner`/`name` plus an optional `ref` is accepted: `link:`/`file:`/local
 * paths/arbitrary URLs are `INVALID_INPUT` (ADR 0005 D4).
 */
export const pluginSourceSelectorSchema = sObject({
  owner: githubOwnerSchema,
  name: githubRepoSchema,
  ref: sOptional(githubRefSchema),
});
export type PluginSourceSelector = Infer<typeof pluginSourceSelectorSchema>;

/** One repository hit from a GitHub search; metadata only, never a safety signal. */
export const pluginSearchHitSchema = sObject({
  fullName: sString({ minLength: 3, maxLength: 200 }),
  owner: githubOwnerSchema,
  name: githubRepoSchema,
  description: sNullable(sString({ minLength: 1, maxLength: 512 })),
  htmlUrl: githubHtmlUrlSchema,
  stars: sInteger({ min: 0 }),
  topics: sArray(sString({ minLength: 1, maxLength: 64 }), { maxLength: PLUGIN_TOPICS_MAX }),
  defaultBranch: sString({ minLength: 1, maxLength: 256 }),
  updatedAt: sString({ minLength: 1, maxLength: 64 }),
  archived: sBoolean,
  fork: sBoolean,
  license: sNullable(sString({ minLength: 1, maxLength: 128 })),
});
export type PluginSearchHit = Infer<typeof pluginSearchHitSchema>;

/**
 * Terminal `plugins.search` payload (ADR 0005 D16/D20). `query` is the exact
 * string sent to GitHub, character for character; `hasMore` already accounts
 * for the 1000-result search ceiling so the UI can distinguish "truly this
 * few" from "truncated by GitHub".
 */
export const pluginSearchResultSchema = sObject({
  query: sString({ minLength: PLUGIN_QUERY_MIN_LENGTH, maxLength: PLUGIN_QUERY_MAX_LENGTH }),
  hits: sArray(pluginSearchHitSchema, { maxLength: PLUGIN_HITS_MAX }),
  totalCount: sInteger({ min: 0 }),
  incompleteResults: sBoolean,
  hasMore: sBoolean,
  fetchedAt: sString({ minLength: 1, maxLength: 64 }),
  fromCache: sBoolean,
});
export type PluginSearchResult = Infer<typeof pluginSearchResultSchema>;

/** Public repository detail returned by `plugins.inspect`. */
export const pluginRepositoryDetailSchema = sObject({
  fullName: sString({ minLength: 3, maxLength: 200 }), // owner/name, no further format rule
  description: sNullable(sString({ minLength: 1, maxLength: 512 })),
  htmlUrl: githubHtmlUrlSchema,
  stars: sInteger({ min: 0 }),
  topics: sArray(sString({ minLength: 1, maxLength: 64 }), { maxLength: PLUGIN_TOPICS_MAX }),
  defaultBranch: sString({ minLength: 1, maxLength: 256 }),
  updatedAt: sString({ minLength: 1, maxLength: 64 }),
  archived: sBoolean,
  fork: sBoolean,
  license: sNullable(sString({ minLength: 1, maxLength: 128 })),
  homepage: sNullable(sString({ minLength: 1, maxLength: 2048 })),
});
export type PluginRepositoryDetail = Infer<typeof pluginRepositoryDetailSchema>;

/** Terminal `plugins.inspect` payload; repository metadata only in S1. */
export const pluginInspectionSchema = sObject({
  source: pluginSourceSelectorSchema,
  repository: pluginRepositoryDetailSchema,
  fetchedAt: sString({ minLength: 1, maxLength: 64 }),
  fromCache: sBoolean,
});
export type PluginInspection = Infer<typeof pluginInspectionSchema>;

export const generationSchema = sObject({
  id: generationIdSchema,
  environmentId: environmentIdSchema,
  compositionDigest: sha256Schema,
  createdAt: sString({ minLength: 1, maxLength: 64 }),
});
export type Generation = Infer<typeof generationSchema>;

export const credentialReferenceSchema = sObject({
  id: opaqueIdSchema('credentialId'),
  store: sLiteral('keychain', 'credential-manager', 'secret-service'),
  key: sString({ minLength: 1, maxLength: 256 }),
});
export type CredentialReference = Infer<typeof credentialReferenceSchema>;

// ---------------------------------------------------------------------------
// Plugin transaction surface (ADR 0005 D4/D5/D6/D8/D13/D14/D20). Results are
// retrieved ONLY from the terminal `OperationSnapshot.output` (D5); there is no
// dual return value and `operation.updated` never carries `output`.
// ---------------------------------------------------------------------------

/** `none-detected` is parse evidence only; it is never a no-script guarantee. */
export const scriptAssessmentSchema = sLiteral('none-detected', 'detected', 'unknown');
export type ScriptAssessment = Infer<typeof scriptAssessmentSchema>;

export const EXECUTOR_ID_MAX_LENGTH = 128;
export const EXECUTOR_VERSION_MAX_LENGTH = 64;

/** Managed executor identity: versioned artifact plus verified content digests. */
export const executorIdentitySchema = sObject({
  id: sString({ minLength: 1, maxLength: EXECUTOR_ID_MAX_LENGTH }),
  version: sString({ minLength: 1, maxLength: EXECUTOR_VERSION_MAX_LENGTH }),
  /** Verified tarball digest. */
  sha256: sha256Schema,
  /** Digest of the executed entry (`bin/pnpm.mjs`), bound to the extraction. */
  entrySha256: sha256Schema,
  /** Digest of the extracted dependency tree, bound to the extraction. */
  treeSha256: sha256Schema,
});
export type ExecutorIdentity = Infer<typeof executorIdentitySchema>;

export const BUILD_SCRIPT_NAME_MAX_LENGTH = 64;
export const BUILD_SCRIPT_ENTRIES_MAX = 128;

/** One install-time script found in the dependency closure. */
export const buildScriptEntrySchema = sObject({
  packageName: sString({ minLength: 1, maxLength: 214 }),
  packageVersion: sString({ minLength: 1, maxLength: 128 }),
  script: sString({ minLength: 1, maxLength: BUILD_SCRIPT_NAME_MAX_LENGTH }),
  source: sLiteral('root', 'dependency'),
});
export type BuildScriptEntry = Infer<typeof buildScriptEntrySchema>;

/**
 * Explicit build authorization. Exact commit + exact script set only; no
 * wildcard, no author trust, no global allow switch (ADR 0005 D14).
 */
export const buildAuthorizationSchema = sObject({
  commitSha: sString({ minLength: 40, maxLength: 40 }),
  scripts: sArray(buildScriptEntrySchema, { maxLength: BUILD_SCRIPT_ENTRIES_MAX }),
});
export type BuildAuthorization = Infer<typeof buildAuthorizationSchema>;

/** Non-digest provenance for an installed plugin source (ADR 0005 D13). */
export const pluginSourceLockSchema = sObject({
  sourceKind: sLiteral('github'),
  repository: sObject({
    owner: sString({ minLength: 1, maxLength: 100 }),
    name: sString({ minLength: 1, maxLength: 100 }),
  }),
  commitSha: sString({ minLength: 40, maxLength: 40 }),
  ref: sNullable(sString({ minLength: 1, maxLength: 256 })),
  packageName: sString({ minLength: 1, maxLength: 214 }),
  packageVersion: sString({ minLength: 1, maxLength: 128 }),
  manifestSha256: sha256Schema,
  /** `null` when no fully-pinned lockfile was available (risk is then unknown). */
  closureLockSha256: sNullable(sha256Schema),
  isBuiltin: sBoolean,
  buildAuthorization: sNullable(buildAuthorizationSchema),
  executor: sNullable(executorIdentitySchema),
});
export type PluginSourceLock = Infer<typeof pluginSourceLockSchema>;

/** Install or remove action of a change plan (strict discriminated union). */
export type ChangePlanAction =
  | { readonly kind: 'install'; readonly source: PluginSourceSelector }
  | { readonly kind: 'remove'; readonly pluginId: string };

export const changePlanActionSchema: Schema<ChangePlanAction> = (value, path, issues) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'install') {
    const source = pluginSourceSelectorSchema(record['source'], `${path}.source`, issues);
    return source === undefined ? undefined : { kind: 'install', source };
  }
  if (record['kind'] === 'remove') {
    const pluginId = pluginIdSchema(record['pluginId'], `${path}.pluginId`, issues);
    return pluginId === undefined ? undefined : { kind: 'remove', pluginId };
  }
  issues.push({ path: `${path}.kind`, message: 'must be "install" or "remove"' });
  return undefined;
};

export const CHANGE_PLAN_RISK_ITEMS_MAX = 32;
export const CHANGE_PLAN_BLOCKING_MAX = 32;

/**
 * Durable change plan (ADR 0005 D5/D6/D8/D20). Identity and script evidence are
 * bound here so `changes.apply` can re-resolve and compare before any write.
 */
export const changePlanSchema = sObject({
  planId: planIdSchema,
  environmentId: environmentIdSchema,
  baseRevision: revisionSchema,
  action: changePlanActionSchema,
  createdAt: sString({ minLength: 1, maxLength: 64 }),
  expiresAt: sString({ minLength: 1, maxLength: 64 }),
  sourceLock: sNullable(pluginSourceLockSchema),
  scriptAssessment: scriptAssessmentSchema,
  scripts: sArray(buildScriptEntrySchema, { maxLength: BUILD_SCRIPT_ENTRIES_MAX }),
  requiresBuildAuthorization: sBoolean,
  riskItems: sArray(sString({ minLength: 1, maxLength: 256 }), { maxLength: CHANGE_PLAN_RISK_ITEMS_MAX }),
  removals: sArray(sString({ minLength: 1, maxLength: 214 }), { maxLength: CHANGE_PLAN_BLOCKING_MAX }),
  retention: sArray(sString({ minLength: 1, maxLength: 214 }), { maxLength: CHANGE_PLAN_BLOCKING_MAX }),
  blockingReferences: sArray(
    sObject({
      pluginId: sString({ minLength: 1, maxLength: 214 }),
      kind: sLiteral('bundle', 'config', 'userPatch'),
      detail: sString({ minLength: 1, maxLength: 256 }),
    }),
    { maxLength: CHANGE_PLAN_BLOCKING_MAX },
  ),
  executor: sNullable(executorIdentitySchema),
  planInputsDigest: sha256Schema,
});
export type ChangePlan = Infer<typeof changePlanSchema>;

/** Terminal `changes.apply` payload. */
export const changeApplicationSchema = sObject({
  planId: planIdSchema,
  environmentId: environmentIdSchema,
  generationId: generationIdSchema,
  compositionDigest: sha256Schema,
  sourceLock: sNullable(pluginSourceLockSchema),
  committedAt: sString({ minLength: 1, maxLength: 64 }),
});
export type ChangeApplication = Infer<typeof changeApplicationSchema>;

/** One generation summary for `generations.list` / `generations.restore`. */
export const generationSummarySchema = sObject({
  generationId: generationIdSchema,
  environmentId: environmentIdSchema,
  compositionDigest: sha256Schema,
  profileName: sNullable(sString({ minLength: 1, maxLength: 80 })),
  active: sBoolean,
  createdAt: sString({ minLength: 1, maxLength: 64 }),
});
export type GenerationSummary = Infer<typeof generationSummarySchema>;

/** Read-only list returned by `generations.list` (bounded by generations). */
export const generationSummaryListSchema = sArray(generationSummarySchema, { maxLength: 64 });
