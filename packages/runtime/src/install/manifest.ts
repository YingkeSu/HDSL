/** Managed-install manifest: durable evidence of what was installed and verified. */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type InstallMode = 'npm-ci' | 'artifacts-only';

export interface InstallCheck {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
}

export interface InstallManifest {
  readonly schemaVersion: '1';
  readonly installMode: InstallMode;
  readonly catalogRevision: string;
  readonly compositionDigest: string;
  readonly node: {
    /** Path relative to the generation directory. */
    readonly version: string;
    readonly sha256: string;
    readonly executable: string;
    /**
     * Optional (schema v1 add-on): deterministic digest of the installed Node
     * tree. Older records lack it; reuse verification fails closed for those
     * with an explainable reason instead of silently trusting file existence.
     */
    readonly treeDigest?: string;
  };
  readonly dsh: {
    readonly version: string;
    readonly sha256: string;
    readonly entrypoint: string;
    readonly treeDigest: string;
  };
  readonly closure: {
    readonly installed: boolean;
    readonly lockSha256: string;
    readonly lockAsset: string;
    readonly packageCount: number;
    readonly rootIntegritySha512: string;
    readonly npmVersion: string;
    readonly nodeVersion: string;
  } | null;
  readonly preflight: {
    readonly skipped: boolean;
    readonly passed: boolean;
    readonly checks: readonly InstallCheck[];
    readonly reason?: string;
  };
  /**
   * Optional (schema v1 add-on): the generated profile's immutable declaration
   * source staged at `<generation>/profile`. Absent on records from older builds
   * (treated as "no managed profile", i.e. legacy `web` compatibility).
   */
  readonly profile?: {
    readonly name: string;
    readonly digest: string;
  } | null;
  readonly installedAt: string;
}

export const writeJsonFileSync = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${String(process.pid)}`;
  const descriptor = openSync(temporary, 'w');
  try {
    writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
};
