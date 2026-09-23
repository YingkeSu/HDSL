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
  pluginPackageNameSchema,
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
  isPlainRecord,
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
  id: pluginPackageNameSchema,
  version: artifactVersionSchema,
  sha256: sha256Schema,
});
export type PluginLock = Infer<typeof pluginLockSchema>;

/**
 * `pluginSources` map schema (ADR 0005 D13). Declared before
 * `compositionLockSchema` so the `sOptional(...)` argument is initialised; it
 * resolves `pluginSourceLockSchema` lazily at validation time, so the DTO keeps
 * its `PluginSourceLock` definition (and its executor/authorization
 * dependencies) later in the file.
 */
const pluginSourcesSchema: Schema<Readonly<Record<string, PluginSourceLock>>> = (value, path, issues) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'must be a plain object' });
    return undefined;
  }
  const output: Record<string, PluginSourceLock> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = pluginSourceLockSchema(entry, `${path}.${key}`, issues);
    if (parsed === undefined) {
      return undefined;
    }
    output[key] = parsed;
  }
  return output;
};

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
  /**
   * Non-digest plugin SOURCE provenance (ADR 0005 D13), keyed by plugin id
   * (= package name). Missing = no recorded plugin source; it never enters the
   * composition digest.
   */
  pluginSources: sOptional(pluginSourcesSchema),
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
  // 1.1 addition (#114, A2): in-environment composition switch transaction.
  'switch',
  'openWebUI',
  'export',
  // 1.1 plugin discovery (ADR 0005 D4/D5).
  'search',
  'inspect',
  // 1.1 plugin transactions (ADR 0005 D4/D5, S2).
  'preview',
  'apply',
  'restore',
  // 1.1 addition (#113, A1): read-only upstream DSH version listing.
  'versions',
  // 1.1 addition (#118): read-only expected composition from `--dump-config`.
  'composition',
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

// ---------------------------------------------------------------------------
// 1.1 addition (#113, A1): read-only upstream DSH version discovery. The list
// is fetched from the public npm registry (no credentials) and marks which
// upstream versions are covered by the audited runtime catalog. An unaudited
// version is reported as `supported: false` and is never presented as
// installable; `latest` is never equated with compatibility.
// ---------------------------------------------------------------------------

/** Registry dist-tags / catalog mappings kept per version are bounded. */
export const DSH_UPSTREAM_VERSIONS_MAX = 200;
export const DSH_VERSION_TAGS_MAX = 16;

/** One upstream version as published on the registry, plus catalog coverage. */
export const dshUpstreamVersionSchema = sObject({
  version: artifactVersionSchema,
  /** Registry dist-tags (e.g. `latest`, `next`) that currently point here. */
  distTags: sArray(sString({ minLength: 1, maxLength: 64 }), { maxLength: DSH_VERSION_TAGS_MAX }),
  /** Exact registry publish time, or null when the registry omitted it. */
  publishedAt: sNullable(sString({ minLength: 1, maxLength: 64 })),
  /** True only when the audited catalog has a verified combination for it. */
  supported: sBoolean,
  /** Audited catalog combination ids for this version (empty when unaudited). */
  catalogCombinationIds: sArray(catalogCombinationIdSchema, { maxLength: DSH_VERSION_TAGS_MAX }),
});
export type DshUpstreamVersion = Infer<typeof dshUpstreamVersionSchema>;

/** Public, credential-free registry the listing came from. */
export const dshRegistrySourceSchema = sObject({
  registry: sString({ minLength: 1, maxLength: 128 }),
  packageName: sString({ minLength: 1, maxLength: 214 }),
});
export type DshRegistrySource = Infer<typeof dshRegistrySourceSchema>;

/** Terminal `versions.dsh` payload (ADR 0005 D5 model, read-only). */
export const dshVersionListingSchema = sObject({
  source: dshRegistrySourceSchema,
  /** Exact query time of the registry response. */
  fetchedAt: sString({ minLength: 1, maxLength: 64 }),
  distTags: sArray(
    sObject({ tag: sString({ minLength: 1, maxLength: 64 }), version: artifactVersionSchema }),
    { maxLength: DSH_VERSION_TAGS_MAX },
  ),
  versions: sArray(dshUpstreamVersionSchema, { maxLength: DSH_UPSTREAM_VERSIONS_MAX }),
});
export type DshVersionListing = Infer<typeof dshVersionListingSchema>;

// ---------------------------------------------------------------------------
// 1.1 addition (#118): read-only EXPECTED composition from the managed
// `dsh --profile <p> --dump-config` output. It is explicitly the desired/
// EXPECTED composition, NEVER the runtime ACTIVE plugin set: `--dump-config`
// resolves config offline, preserves `!!js` expressions verbatim without
// evaluating them, and the dump <-> runtime-loaded-set equivalence (E9) is NOT
// established. The view carries `basis: 'dump-config'` and
// `runtimeVerification: 'unavailable'` so it can never read as ACTIVE.
// ---------------------------------------------------------------------------

/** Per-view bounds; a dump over these caps is truncated with a diagnostic. */
export const EXPECTED_COMPOSITION_GROUPS_MAX = 512;
export const EXPECTED_COMPOSITION_ROWS_MAX = 5000;
export const EXPECTED_COMPOSITION_DIAGNOSTICS_MAX = 64;
export const EXPECTED_COMPOSITION_ROW_CONFIG_MAX = 4096;
export const EXPECTED_COMPOSITION_STDERR_MAX = 8192;
export const EXPECTED_COMPOSITION_BUNDLES_MAX = 256;

/** Verbatim config subtree of one expected row; `!!js` stays literal (unrun). */
export const expectedCompositionConfigSchema = sObject({
  /** Verbatim YAML text (bounded); unevaluated `!!js` expressions stay literal. */
  text: sString({ maxLength: EXPECTED_COMPOSITION_ROW_CONFIG_MAX }),
  truncated: sBoolean,
  /** True when the subtree carries an unevaluated custom tag, alias or merge key. */
  unevaluated: sBoolean,
});
export type ExpectedCompositionConfig = Infer<typeof expectedCompositionConfigSchema>;

/** One expected row: `(id, name, disabled, config?)` from a `# ==` section. */
export const expectedCompositionRowSchema = sObject({
  id: sNullable(sString({ minLength: 1, maxLength: 256 })),
  /** Row `name` (package reference) when it is a plain scalar. */
  name: sNullable(sString({ minLength: 1, maxLength: 256 })),
  /** False when `name` is an explicit tag / alias / block scalar / non-string. */
  nameKnown: sBoolean,
  disabled: sNullable(sBoolean),
  /** False when `disabled` is an unevaluated `!!js` expression or non-boolean. */
  disabledKnown: sBoolean,
  config: sOptional(expectedCompositionConfigSchema),
});
export type ExpectedCompositionRow = Infer<typeof expectedCompositionRowSchema>;

export const expectedCompositionGroupSchema = sObject({
  /** The `# == <label>` header that introduced this section. */
  label: sString({ minLength: 1, maxLength: 256 }),
  rows: sArray(expectedCompositionRowSchema, { maxLength: EXPECTED_COMPOSITION_ROWS_MAX }),
});
export type ExpectedCompositionGroup = Infer<typeof expectedCompositionGroupSchema>;

export const expectedCompositionDiagnosticCodeSchema = sLiteral(
  'preamble-ignored',
  'group-parse-failed',
  'row-ignored',
  'unresolved-construct',
  'truncated',
);
export type ExpectedCompositionDiagnosticCode = Infer<
  typeof expectedCompositionDiagnosticCodeSchema
>;

export const expectedCompositionDiagnosticSchema = sObject({
  code: expectedCompositionDiagnosticCodeSchema,
  /** Value-free, redacted explanation (raw `!!js` text is never echoed here). */
  message: sString({ minLength: 1, maxLength: 512 }),
  groupLabel: sNullable(sString({ minLength: 1, maxLength: 256 })),
  line: sNullable(sInteger({ min: 1 })),
});
export type ExpectedCompositionDiagnostic = Infer<typeof expectedCompositionDiagnosticSchema>;

/**
 * Terminal `compositions.expected` payload (ADR 0005 D5 model, read-only).
 * `basis`/`runtimeVerification` are fixed literals so the view can never be
 * presented as the runtime ACTIVE plugin set.
 */
export const expectedCompositionViewSchema = sObject({
  environmentId: environmentIdSchema,
  revision: revisionSchema,
  generationId: sNullable(generationIdSchema),
  profileName: sString({ minLength: 1, maxLength: 256 }),
  /** Fixed: produced from the offline dump, never from a running process. */
  basis: sLiteral('dump-config'),
  /** Fixed: HDSL does not observe the runtime ACTIVE set in this slice. */
  runtimeVerification: sLiteral('unavailable'),
  /** Declared bundles from the profile declaration source. */
  bundles: sArray(sString({ minLength: 1, maxLength: 214 }), {
    maxLength: EXPECTED_COMPOSITION_BUNDLES_MAX,
  }),
  patchReload: sLiteral('live', 'startup', 'unknown'),
  groups: sArray(expectedCompositionGroupSchema, { maxLength: EXPECTED_COMPOSITION_GROUPS_MAX }),
  rowCount: sInteger({ min: 0, max: EXPECTED_COMPOSITION_ROWS_MAX }),
  stdoutBytes: sInteger({ min: 0 }),
  /** Bounded stderr text, surfaced as-is (redacted) and never silently dropped. */
  stderr: sString({ maxLength: EXPECTED_COMPOSITION_STDERR_MAX }),
  exitCode: sInteger({ min: -1, max: 255 }),
  timedOut: sBoolean,
  diagnostics: sArray(expectedCompositionDiagnosticSchema, {
    maxLength: EXPECTED_COMPOSITION_DIAGNOSTICS_MAX,
  }),
  observedAt: sString({ minLength: 1, maxLength: 64 }),
});
export type ExpectedCompositionView = Infer<typeof expectedCompositionViewSchema>;

// ---------------------------------------------------------------------------
// 1.2 addition (#135, E1-T1): desired-config entry patch for the runtime entry
// axis. It edits the environment-shared home user patch layer
// (`$DSH_HOME/cordis.patch.yml`) ONLY, never a generation's immutable profile
// declaration source. A saved file means "desired config persisted", never that
// the running DSH reached the matching ACTIVE set: `runtime` stays `pending`,
// `runtimeVerification` stays `unavailable`, and `activation` is one of
// `restart-required` / `live-reload-unverified`. No local path crosses the
// bridge.
// ---------------------------------------------------------------------------

/** Upper bounds for the bounded entry-patch terminal payload. */
export const ENTRY_PATCH_ROWS_MAX = 500;
export const ENTRY_PATCH_DIAGNOSTICS_MAX = 64;
export const ENTRY_PATCH_ROW_ID_MAX = 256;

export const entryPatchOperationKindSchema = sLiteral('enable', 'disable', 'config', 'remove');
export type EntryPatchOperationKind = Infer<typeof entryPatchOperationKindSchema>;

/** The four supported desired-config edits; `config` is required for `kind: config`. */
export type EntryPatchOperation =
  | { readonly kind: 'enable'; readonly rowId: string }
  | { readonly kind: 'disable'; readonly rowId: string }
  | { readonly kind: 'config'; readonly rowId: string; readonly config: unknown }
  | { readonly kind: 'remove'; readonly rowId: string };

const entryPatchRowIdSchema = sString({ minLength: 1, maxLength: ENTRY_PATCH_ROW_ID_MAX });

/** A required value that may itself be any JSON value (including `null`). */
const requiredUnknownSchema: Schema<unknown> = (value, path, issues) => {
  if (value === undefined) {
    issues.push({ path, message: 'is required' });
    return undefined;
  }
  return value;
};

const entryPatchWithoutConfigSchema = sObject({
  kind: sLiteral('enable', 'disable', 'remove'),
  rowId: entryPatchRowIdSchema,
});

const entryPatchWithConfigSchema = sObject({
  kind: sLiteral('config'),
  rowId: entryPatchRowIdSchema,
  config: requiredUnknownSchema,
});

/**
 * Strict discriminated union: `config` is required for `kind: 'config'` and
 * rejected for the other kinds, and unknown fields are `INVALID_INPUT`.
 */
export const entryPatchOperationSchema: Schema<EntryPatchOperation> = (value, path, issues) => {
  if (!isPlainRecord(value)) {
    issues.push({ path, message: 'must be a plain object' });
    return undefined;
  }
  if (value['kind'] === 'config') {
    return entryPatchWithConfigSchema(value, path, issues) as EntryPatchOperation | undefined;
  }
  return entryPatchWithoutConfigSchema(value, path, issues) as EntryPatchOperation | undefined;
};

export const entryPatchDiagnosticCodeSchema = sLiteral(
  'entry-not-mapping',
  'insert-row-not-mapping',
  'row-id-missing',
  'row-id-not-plain-scalar',
  'row-name-not-plain-scalar',
  'row-disabled-not-boolean',
  'entry-without-id-or-insert',
  'alias-not-resolved',
);
export type EntryPatchDiagnosticCode = Infer<typeof entryPatchDiagnosticCodeSchema>;

/** One row view of the resulting home patch file (no local path). */
export const entryPatchRowSchema = sObject({
  id: sString({ minLength: 1, maxLength: ENTRY_PATCH_ROW_ID_MAX }),
  kind: sLiteral('insert', 'override'),
  name: sNullable(sString({ minLength: 1, maxLength: 214 })),
  /** False when `name` is an explicit tag/alias/block scalar/non-string. */
  nameKnown: sBoolean,
  disabled: sNullable(sBoolean),
  hasConfig: sBoolean,
});
export type EntryPatchRow = Infer<typeof entryPatchRowSchema>;

export const entryPatchDiagnosticSchema = sObject({
  code: entryPatchDiagnosticCodeSchema,
  line: sInteger({ min: 1 }),
  /** Value-free, redacted structural note; never raw config text. */
  detail: sString({ minLength: 1, maxLength: 512 }),
});
export type EntryPatchDiagnostic = Infer<typeof entryPatchDiagnosticSchema>;

/**
 * Terminal `entries.patch` payload. `saved`/`runtime`/`runtimeVerification` are
 * fixed literals so the view can never be presented as the runtime ACTIVE set.
 */
export const entryPatchResultSchema = sObject({
  environmentId: environmentIdSchema,
  operation: entryPatchOperationKindSchema,
  /** Desired config was persisted atomically. */
  saved: sBooleanLiteral(true),
  /** The running DSH set was NOT observed. */
  runtime: sLiteral('pending'),
  runtimeVerification: sLiteral('unavailable'),
  activation: sLiteral('restart-required', 'live-reload-unverified'),
  restartRequired: sBoolean,
  reloadMode: sLiteral('live', 'startup', 'unknown'),
  rows: sArray(entryPatchRowSchema, { maxLength: ENTRY_PATCH_ROWS_MAX }),
  diagnostics: sArray(entryPatchDiagnosticSchema, { maxLength: ENTRY_PATCH_DIAGNOSTICS_MAX }),
});
export type EntryPatchResult = Infer<typeof entryPatchResultSchema>;

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
  /**
   * Optional: digest of the TARGET profile declaration/config the plan resolved
   * (current immutable declaration + workspace config + the exact source). It is
   * not part of the composition digest; it binds the plan to what was resolved.
   */
  targetDeclarationSha256: sOptional(sha256Schema),
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
    const pluginId = pluginPackageNameSchema(record['pluginId'], `${path}.pluginId`, issues);
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
export const INSTALLED_PLUGINS_MAX = 128;

/**
 * One installed plugin of the ACTIVE generation's recorded composition
 * (`plugins.installed`, ADR 0005 D4/D15). Minimal and bounded by design: no disk
 * paths, no manifest text and no credentials — `isBuiltin` is resolved from the
 * current managed DSH install, never from the client or a same-name profile
 * dependency.
 */
export const installedPluginSchema = sObject({
  id: pluginPackageNameSchema,
  version: artifactVersionSchema,
  sha256: sha256Schema,
  isBuiltin: sBoolean,
  enabledBundle: sBoolean,
  /** Public source identity recorded in the composition lock; never a path. */
  source: sNullable(
    sObject({
      owner: githubOwnerSchema,
      name: githubRepoSchema,
      commitSha: sNullable(sString({ minLength: 40, maxLength: 40 })),
    }),
  ),
});
export type InstalledPlugin = Infer<typeof installedPluginSchema>;

/**
 * Read-only view returned by `plugins.installed`. `revision` and `generationId`
 * bind the list to the environment state the UI must re-verify before a remove
 * preview/apply, so a stale list cannot target a superseded generation.
 */
export const installedPluginsViewSchema = sObject({
  environmentId: environmentIdSchema,
  revision: revisionSchema,
  generationId: sNullable(generationIdSchema),
  plugins: sArray(installedPluginSchema, { maxLength: INSTALLED_PLUGINS_MAX }),
});
export type InstalledPluginsView = Infer<typeof installedPluginsViewSchema>;

export const generationSummarySchema = sObject({
  generationId: generationIdSchema,
  environmentId: environmentIdSchema,
  compositionDigest: sha256Schema,
  profileName: sNullable(sString({ minLength: 1, maxLength: 80 })),
  active: sBoolean,
  createdAt: sString({ minLength: 1, maxLength: 64 }),
  // 1.1 additive (#114, A2): a NON-BLOCKING data-compatibility warning emitted
  // by `generations.restore` when the target generation's DSH version is older
  // than the environment's last successfully started DSH version. Absent/null
  // means "no warning" (including same-version and unknown-version cases).
  dshCompatibilityWarning: sOptional(sNullable(sString({ minLength: 1, maxLength: 512 }))),
});
export type GenerationSummary = Infer<typeof generationSummarySchema>;

/** Read-only list returned by `generations.list` (bounded by generations). */
export const generationSummaryListSchema = sArray(generationSummarySchema, { maxLength: 64 });
