/**
 * Pure preview-resolution builder and the `GitProvider` seam (ADR 0005 D7/D8/D19).
 *
 * `buildPreviewResolution` is a pure function over a source resolved at an exact
 * commit, so core/runtime can share one assessment implementation and tests can
 * inject a controlled provider.
 *
 * Evidence bounds (must not be overstated):
 * - `detected`  = the root manifest declares an install-time script.
 * - `unknown`   = a dependency closure exists that was NOT enumerated; the
 *                 closure may contain install-time scripts.
 * - `none-detected` = neither root scripts nor dependencies; this is a parse
 *                 result, never a "no script will run" guarantee.
 * `closureLockSha256` is `null` when no fully-pinned lockfile was resolved; a
 * digest is never fabricated from a semver range. Authoritative script denial
 * happens at apply (default deny + execution sentinel), not here.
 */
import { createHash } from 'node:crypto';
import {
  isPlainRecord,
  portFail,
  portOk,
  type BuildScriptEntry,
  type ExecutorIdentity,
  type PluginSourceLock,
  type PluginSourceSelector,
  type PortOutcome,
  type ScriptAssessment,
} from '@hdsl/contracts';

/** Structural mirror of core's `PluginPreviewResolution` (no cross-package import). */
export interface PluginPreviewResolution {
  readonly sourceLock: PluginSourceLock;
  readonly scripts: readonly BuildScriptEntry[];
  readonly scriptAssessment: ScriptAssessment;
  readonly requiresBuildAuthorization: boolean;
  /**
   * True only when the enumerated install-time script set covers the WHOLE
   * dependency closure. A source that declares any dependency is NOT fully
   * enumerated by this pure resolver, so its scripts can never be authorized
   * (S4). Runtime-internal; not a contract field.
   */
  readonly dependencyClosureEnumerated: boolean;
  readonly riskItems: readonly string[];
  readonly executor: ExecutorIdentity | null;
  readonly planInputsDigest: string;
  /** Target profile lock resolved in isolation; `null` for a source-only preview. */
  readonly targetLockText: string | null;
  /** Target profile declaration resolved in isolation; `null` for a source-only preview. */
  readonly targetDeclarationText: string | null;
  /** Workspace resolution config used for the target; `null` when absent. */
  readonly targetWorkspaceText: string | null;
  /** Target declaration digest; `null` for a source-only preview. */
  readonly targetDeclarationSha256: string | null;
}

/** A source manifest resolved at an exact, immutable commit. */
export interface ResolvedSourceManifest {
  readonly commitSha: string;
  readonly manifestText: string;
  /** Fully-pinned lockfile text, or `null` when none was resolved. */
  readonly lockText: string | null;
}

/**
 * Git provider seam. The production default reads public GitHub over HTTPS; tests
 * inject a controlled provider (for example a local bare git remote). A provider
 * resolves an exact commit and declaration files only; it never runs install-time
 * scripts.
 */
export interface GitProvider {
  resolveManifest(
    source: PluginSourceSelector,
    signal: AbortSignal,
  ): Promise<PortOutcome<ResolvedSourceManifest>>;
}

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
const NO_SCRIPTS_RISK =
  'no install-time scripts declared in the parsed manifest; the dependency closure was not enumerated';
const UNKNOWN_RISK = 'the dependency closure was not fully enumerated; install-time scripts may exist';
const SCRIPT_RISK = 'the package declares install-time scripts; HDSL rejects them by default at apply';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isPlainRecord(value) ? value : undefined;
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export const buildPreviewResolution = (input: {
  readonly source: PluginSourceSelector;
  readonly resolved: ResolvedSourceManifest;
  readonly executor: ExecutorIdentity | null;
}): PortOutcome<PluginPreviewResolution> => {
  const { source, resolved, executor } = input;
  if (!COMMIT_SHA_PATTERN.test(resolved.commitSha)) {
    return portFail('SOURCE_NOT_FOUND', 'the resolved commit SHA is not a 40-character commit');
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(resolved.manifestText);
    manifest = asRecord(parsed) ?? {};
  } catch {
    return portFail('SOURCE_MANIFEST_INVALID', 'the repository package.json is not valid JSON');
  }
  const dsh = asRecord(manifest['dsh']);
  const bundle = dsh === undefined ? undefined : asRecord(dsh['bundle']);
  if (bundle === undefined || bundle['patch'] === undefined) {
    return portFail('NOT_A_PLUGIN', 'the repository does not declare dsh.bundle.patch');
  }

  const scripts: BuildScriptEntry[] = [];
  const manifestScripts = asRecord(manifest['scripts']) ?? {};
  for (const name of INSTALL_SCRIPTS) {
    if (typeof manifestScripts[name] === 'string') {
      scripts.push({
        packageName: asString(manifest['name']) ?? source.name,
        packageVersion: asString(manifest['version']) ?? '0.0.0',
        script: name,
        source: 'root',
      });
    }
  }
  const dependencies = asRecord(manifest['dependencies']) ?? {};
  const hasDependencies = Object.keys(dependencies).length > 0;
  const scriptAssessment: ScriptAssessment =
    scripts.length > 0 ? 'detected' : hasDependencies ? 'unknown' : 'none-detected';
  const riskItems =
    scripts.length > 0 ? [SCRIPT_RISK] : scriptAssessment === 'unknown' ? [UNKNOWN_RISK] : [NO_SCRIPTS_RISK];

  const manifestSha256 = createHash('sha256').update(resolved.manifestText, 'utf8').digest('hex');
  const closureLockSha256 =
    resolved.lockText === null ? null : createHash('sha256').update(resolved.lockText, 'utf8').digest('hex');
  const sourceLock: PluginSourceLock = {
    sourceKind: 'github',
    repository: { owner: source.owner, name: source.name },
    commitSha: resolved.commitSha,
    ref: source.ref ?? null,
    packageName: asString(manifest['name']) ?? source.name,
    packageVersion: asString(manifest['version']) ?? '0.0.0',
    manifestSha256,
    closureLockSha256,
    isBuiltin: false,
    buildAuthorization: null,
    executor,
  };
  const planInputsDigest = createHash('sha256')
    .update(JSON.stringify({ commitSha: resolved.commitSha, manifestSha256, closureLockSha256, scripts, executor }), 'utf8')
    .digest('hex');

  return portOk({
    sourceLock,
    scripts,
    scriptAssessment,
    requiresBuildAuthorization: scriptAssessment !== 'none-detected',
    dependencyClosureEnumerated: !hasDependencies,
    riskItems,
    executor,
    planInputsDigest,
    targetLockText: null,
    targetDeclarationText: null,
    targetWorkspaceText: null,
    targetDeclarationSha256: null,
  });
};
