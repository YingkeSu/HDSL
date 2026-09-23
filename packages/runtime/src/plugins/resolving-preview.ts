/**
 * Production preview port that resolves the TARGET profile in isolation.
 *
 * It wraps the GitHub GitProvider (source resolution) and the frozen managed
 * executor (isolated, default-deny target-lock resolution via
 * resolveTargetProfileLock). The resulting resolution binds the target lock
 * digest + target declaration digest, so a plan is bound to the EXPECTED target
 * composition, not to the source repository's own lock.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { portOk, type BuildScriptEntry, type ExecutorIdentity, type PluginSourceSelector, type PortOutcome, type ScriptAssessment } from '@hdsl/contracts';
import { buildPreviewResolution, type GitProvider } from './preview-resolution.js';
import type { PluginPreviewResolution } from './preview-resolution.js';
import type { PluginExecutorPort } from './executor.js';
import { resolveTargetProfileLock } from './target-profile.js';
import { buildScriptKey, enumerateInstallScriptsFromInstalledTree, stripBuildPermissionConfig } from './build-authorization.js';

/** Bounded timeout for the default-deny materialisation used to enumerate scripts. */
const MATERIALIZE_TIMEOUT_MS = 180_000;

export interface PreviewSourceContext {
  readonly declarationDirectory: string;
  readonly stagingDirectory: string;
  /**
   * Managed Node executable of the current generation (never `process.execPath`:
   * in the Electron main process that is the Electron binary, which does not exit
   * after running a script).
   */
  readonly nodeExecutable: string;
}

export interface ResolvingPreviewOptions {
  readonly gitProvider: GitProvider;
  readonly executor: PluginExecutorPort;
  readonly executorIdentity: ExecutorIdentity;
}

export interface ResolvingPreviewPort {
  previewSource(
    source: PluginSourceSelector,
    signal: AbortSignal,
    context?: PreviewSourceContext,
  ): Promise<PortOutcome<PluginPreviewResolution>>;
}

export const createResolvingPreviewPort = (options: ResolvingPreviewOptions): ResolvingPreviewPort => ({
  async previewSource(source, signal, context) {
    const resolved = await options.gitProvider.resolveManifest(source, signal);
    if (!resolved.ok) {
      return resolved;
    }
    // Source-only resolution is still returned when no target context is given
    // (e.g. a global inspect-like call); target binding below is additive.
    const built = buildPreviewResolution({
      source,
      resolved: resolved.value,
      executor: options.executorIdentity,
    });
    if (!built.ok || context === undefined) {
      return built;
    }
    const target = await resolveTargetProfileLock(
      options.gitProvider,
      options.executor,
      {
        source,
        commitSha: resolved.value.commitSha,
        declarationDirectory: context.declarationDirectory,
        stagingDirectory: context.stagingDirectory,
        nodeExecutable: context.nodeExecutable,
      },
      signal,
    );
    if (!target.ok) {
      return target;
    }
    // Enumerate the INSTALL-TIME dependency closure read-only: materialise the
    // target profile with DEFAULT DENY (no script runs, no marker, no
    // allowBuilds), then read each dependency's package.json. A failed
    // enumeration keeps the source `unknown` (never authorizable) — it is never
    // guessed and never discovered by executing a script.
    const closureScripts = await enumerateClosureScripts(options, {
      declarationText: target.value.targetDeclarationText,
      lockText: target.value.targetLockText,
      workspaceText: target.value.targetWorkspaceText,
      stagingDirectory: context.stagingDirectory,
      nodeExecutable: context.nodeExecutable,
      excludePackageName: built.value.sourceLock.packageName,
      signal,
    });
    const merged = closureScripts === undefined ? built.value.scripts : mergeScripts(built.value.scripts, closureScripts);
    const enumerationComplete = closureScripts !== undefined;
    // A failed enumeration of a source that HAS a dependency closure keeps
    // `unknown` (never authorizable); it is never downgraded to `none-detected`.
    const scriptAssessment: ScriptAssessment = enumerationComplete
      ? merged.length > 0
        ? 'detected'
        : 'none-detected'
      : built.value.dependencyClosureEnumerated
        ? built.value.scriptAssessment
        : 'unknown';
    return portOk({
      ...built.value,
      sourceLock: {
        ...built.value.sourceLock,
        closureLockSha256: target.value.targetLockSha256,
        targetDeclarationSha256: target.value.targetDeclarationSha256,
      },
      scripts: merged,
      scriptAssessment,
      requiresBuildAuthorization: enumerationComplete ? merged.length > 0 : built.value.requiresBuildAuthorization,
      dependencyClosureEnumerated: enumerationComplete,
      // B3 (#115): an unreadable bundle declaration is surfaced as a risk item so
      // the caller cannot silently treat the bundle layer as reconciled.
      riskItems: [...built.value.riskItems, ...target.value.bundleRiskItems],
      targetLockText: target.value.targetLockText,
      targetDeclarationText: target.value.targetDeclarationText,
      targetWorkspaceText: target.value.targetWorkspaceText,
      targetDeclarationSha256: target.value.targetDeclarationSha256,
    });
  },
});

/** Stable, duplicate-free union of root and closure script entries. */
const mergeScripts = (
  root: readonly BuildScriptEntry[],
  closure: readonly BuildScriptEntry[],
): readonly BuildScriptEntry[] => {
  const byKey = new Map<string, BuildScriptEntry>();
  for (const entry of [...root, ...closure]) {
    byKey.set(buildScriptKey(entry), entry);
  }
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry);
};

/**
 * Default-deny materialisation + non-executing closure enumeration in an isolated
 * staging directory. Returns `undefined` when enumeration cannot be completed
 * (so callers keep `unknown`). The staging directory is always cleaned.
 */
const enumerateClosureScripts = async (
  options: ResolvingPreviewOptions,
  input: {
    readonly declarationText: string;
    readonly lockText: string;
    readonly workspaceText: string | null;
    readonly stagingDirectory: string;
    readonly nodeExecutable: string;
    readonly excludePackageName: string;
    readonly signal: AbortSignal;
  },
): Promise<readonly BuildScriptEntry[] | undefined> => {
  const staging = `${input.stagingDirectory}-materialize`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'package.json'), input.declarationText, 'utf8');
    writeFileSync(join(staging, 'pnpm-lock.yaml'), input.lockText, 'utf8');
    // Never inherit a historical build-permission config into the default-deny
    // materialisation. Unparsable YAML refuses enumeration (the source stays
    // `unknown`, never authorizable).
    const sanitizedWorkspace = stripBuildPermissionConfig(input.workspaceText);
    if (!sanitizedWorkspace.ok) {
      return undefined;
    }
    if (sanitizedWorkspace.text !== null) {
      writeFileSync(join(staging, 'pnpm-workspace.yaml'), sanitizedWorkspace.text, 'utf8');
    }
    const run = await options.executor.run(
      {
        cwd: staging,
        homeDirectory: staging,
        nodeExecutable: input.nodeExecutable,
        args: ['install', '--frozen-lockfile', '--ignore-scripts'],
        timeoutMs: MATERIALIZE_TIMEOUT_MS,
      },
      input.signal,
    );
    if (!run.ok || run.value.exitCode !== 0) {
      return undefined;
    }
    return enumerateInstallScriptsFromInstalledTree({
      nodeModulesDirectory: join(staging, 'node_modules'),
      lockText: input.lockText,
      excludePackageName: input.excludePackageName,
      readPackageJsonText: (path) => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return undefined;
        }
      },
    });
  } catch {
    return undefined;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};
