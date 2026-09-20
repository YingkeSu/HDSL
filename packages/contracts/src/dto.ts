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
  sBooleanLiteral,
  sInteger,
  sLiteral,
  sNullable,
  sNumber,
  sObject,
  sOptional,
  sString,
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

export const operationKindSchema = sLiteral('create', 'start', 'stop', 'openWebUI', 'export');
export type OperationKind = Infer<typeof operationKindSchema>;

export const operationPhaseSchema = sString({ minLength: 1, maxLength: 64 });

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

/** OperationSnapshot includes the final error, sequence and optional progress. */
export const operationSnapshotSchema = sObject({
  id: operationIdSchema,
  environmentId: sNullable(environmentIdSchema),
  kind: operationKindSchema,
  phase: operationPhaseSchema,
  status: operationStatusSchema,
  sequence: sInteger({ min: 0 }),
  progress: sOptional(sNumber({ min: 0, max: 100 })),
  error: sOptional(sNullable(contractErrorSchema)),
});
export type OperationSnapshot = Infer<typeof operationSnapshotSchema>;

export const operationRefSchema = sObject({ operationId: operationIdSchema });
export type OperationRef = Infer<typeof operationRefSchema>;

export const subscriptionRefSchema = sObject({ subscriptionId: subscriptionIdSchema });
export type SubscriptionRef = Infer<typeof subscriptionRefSchema>;

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
