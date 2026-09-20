/**
 * Application-data layout.
 *
 * Mirrors `docs/architecture/tdd.md` and adds the managed-runtime + DSH home
 * directories a generation needs:
 *
 * ```text
 * <app-data>/
 *   artifacts/                     verified immutable downloads, by sha256
 *   npm-cache/                     shared npm download cache (inside app-data)
 *   tmp/                           same-volume staging
 *   environments/<id>/
 *     environment.json
 *     generations/<generation-id>/
 *       composition.lock.json
 *       generation.json
 *       install-manifest.json      managed install evidence (T004)
 *       runtime/node|dsh/          managed Node and DSH dependency closure
 *       home/                      DSH_HOME for this generation
 *       config/ data/
 *   operations/<operation-id>.json
 *   transactions/<transaction-id>.json
 *   idempotency/<hashed-request-id>.json
 * ```
 *
 * Names are never turned into paths: only opaque ids do, and each derived path
 * is re-checked with {@link assertWithin} (FR-001).
 */
import { join, resolve } from 'node:path';
import { OPAQUE_ID_PATTERN } from '@hdsl/contracts';
import { assertWithin, ensureDirectory } from './fsx.js';

export interface AppDataLayout {
  readonly root: string;
  readonly artifacts: string;
  readonly npmCache: string;
  readonly tmp: string;
  readonly environments: string;
  readonly operations: string;
  readonly transactions: string;
  readonly idempotency: string;
  readonly logs: string;
}

export const resolveLayout = (dataRoot: string): AppDataLayout => {
  const root = resolve(dataRoot);
  return {
    root,
    artifacts: join(root, 'artifacts'),
    npmCache: join(root, 'npm-cache'),
    tmp: join(root, 'tmp'),
    environments: join(root, 'environments'),
    operations: join(root, 'operations'),
    transactions: join(root, 'transactions'),
    idempotency: join(root, 'idempotency'),
    logs: join(root, 'logs'),
  };
};

export const ensureLayout = (layout: AppDataLayout): void => {
  for (const directory of [
    layout.root,
    layout.artifacts,
    layout.npmCache,
    layout.tmp,
    layout.environments,
    layout.operations,
    layout.transactions,
    layout.idempotency,
    layout.logs,
  ]) {
    ensureDirectory(directory);
  }
};

const assertOpaqueId = (value: string, label: string): string => {
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be an opaque id`);
  }
  return value;
};

export const environmentDirectory = (layout: AppDataLayout, environmentId: string): string =>
  assertWithin(
    layout.environments,
    join(layout.environments, assertOpaqueId(environmentId, 'environmentId')),
    'environmentId',
  );

export const environmentRecordPath = (layout: AppDataLayout, environmentId: string): string =>
  join(environmentDirectory(layout, environmentId), 'environment.json');

export const generationsDirectory = (layout: AppDataLayout, environmentId: string): string =>
  join(environmentDirectory(layout, environmentId), 'generations');

export interface GenerationPaths {
  readonly environmentId: string;
  readonly generationId: string;
  readonly generationDirectory: string;
  readonly lockPath: string;
  readonly generationRecordPath: string;
  readonly manifestPath: string;
  readonly nodeDirectory: string;
  readonly dshDirectory: string;
  readonly homeDirectory: string;
  readonly configDirectory: string;
  readonly dataDirectory: string;
}

export const generationPaths = (
  layout: AppDataLayout,
  environmentId: string,
  generationId: string,
): GenerationPaths => {
  const generationDirectory = assertWithin(
    generationsDirectory(layout, environmentId),
    join(generationsDirectory(layout, environmentId), assertOpaqueId(generationId, 'generationId')),
    'generationId',
  );
  return {
    environmentId,
    generationId,
    generationDirectory,
    lockPath: join(generationDirectory, 'composition.lock.json'),
    generationRecordPath: join(generationDirectory, 'generation.json'),
    manifestPath: join(generationDirectory, 'install-manifest.json'),
    // Layout written by the runtime installer (see `install-manifest.json`).
    nodeDirectory: join(generationDirectory, 'node'),
    dshDirectory: join(generationDirectory, 'dsh'),
    homeDirectory: join(generationDirectory, 'home'),
    configDirectory: join(generationDirectory, 'config'),
    dataDirectory: join(generationDirectory, 'data'),
  };
};

export const operationRecordPath = (layout: AppDataLayout, operationId: string): string =>
  assertWithin(
    layout.operations,
    join(layout.operations, `${assertOpaqueId(operationId, 'operationId')}.json`),
    'operationId',
  );

export const transactionRecordPath = (layout: AppDataLayout, transactionId: string): string =>
  assertWithin(
    layout.transactions,
    join(layout.transactions, `${assertOpaqueId(transactionId, 'transactionId')}.json`),
    'transactionId',
  );
