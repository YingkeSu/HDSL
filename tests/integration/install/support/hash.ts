/**
 * Digest helpers for install QA fixtures.
 *
 * The catalog advertises SHA-256 (64 lowercase hex, `sha256Schema`), so every
 * fixture artifact is measured with the same primitive the launcher must use.
 */
import { createHash } from 'node:crypto';

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

/** Deterministic marker digest, used to detect cross-environment mixing. */
export const markerOf = (scope: string, environmentName: string): string =>
  sha256Hex(`hdsl-install-qa:${scope}:${environmentName}`);
