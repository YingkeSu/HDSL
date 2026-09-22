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
