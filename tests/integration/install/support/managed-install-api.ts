/**
 * Confirmed public calling surface for the T004 managed installer.
 *
 * Confirmed by hdsl-15 (T004 / issue #4) and verified against candidate
 * `9fb42d2fd78ea2bcb3cc4aacb629851476624175`. QA drives the real installer only
 * through these public package exports (`@hdsl/core` / `@hdsl/runtime`), never
 * an internal module path. The types below are re-exported from the real
 * packages so the QA scenarios cannot silently drift from the implementation;
 * if an export disappears, typecheck fails instead of a test skipping.
 *
 * Boundary (orchestrator, 2026-09-20): extracting the top-level DSH package is
 * NOT install success. A real install must run the audited `npm ci` closure and
 * a managed Node/DSH preflight, recorded in `install-manifest.json`. Synthetic
 * tarballs run with `closureInstall: false` + `fixtures.allowArtifactsOnly` and
 * only prove download/digest/journal/isolation/path boundaries — they are never
 * cited as evidence that a real DSH is runnable.
 */
import type { ContractPort, HostPlatform, OperationSnapshot, RuntimeCombination } from '@hdsl/contracts';
import type {
  createManagedInstall,
  CreationFaults,
  EnvironmentService,
  InstallCheck,
  InstallManifest,
  InstallMode,
  ManagedInstall,
  RecoveryReport,
} from '@hdsl/core';
import type {
  createRuntimePort,
  InstallFaults,
  ManagedRuntimePort,
  RuntimePortOptions,
} from '@hdsl/runtime';

export type {
  ContractPort,
  CreationFaults,
  EnvironmentService,
  HostPlatform,
  InstallCheck,
  InstallFaults,
  InstallManifest,
  InstallMode,
  ManagedInstall,
  ManagedRuntimePort,
  OperationSnapshot,
  RecoveryReport,
  RuntimeCombination,
  RuntimePortOptions,
};

export type CreateManagedInstall = typeof createManagedInstall;
export type CreateRuntimePort = typeof createRuntimePort;

/** Ordered operation phases before commit (confirmed by T004). */
export const OPERATION_PHASES = [
  'queued',
  'downloading',
  'extracting',
  'installing-dependencies',
  'preflight',
  'committing',
] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number] | string;

export interface ReadInstallManifestOptions {
  readonly generationId?: string;
}

export const CONFIRMED_API_STATUS =
  'CONFIRMED by hdsl-15 (issue #4); verified against candidate 9fb42d2.';
