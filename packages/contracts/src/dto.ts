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
  // 1.1 plugin discovery (ADR 0005 D4/D5). `preview`/`apply`/`restore` are
  // added by S2+ inside the same not-yet-tagged 1.1 surface (ADR §5.4).
  'search',
  'inspect',
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
