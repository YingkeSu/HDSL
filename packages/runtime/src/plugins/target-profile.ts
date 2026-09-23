/**
 * Target-profile resolution (review 5776435420): the closure digest bound to a
 * plan must be the EXPECTED TARGET PROFILE lock, not the source repository's own
 * lock.
 *
 * The target declaration is built from the CURRENT generation's immutable
 * declaration source (never the mutable live profile): its dependencies, its
 * `dsh` profile bundles and any pnpm workspace resolution config are preserved,
 * and only the exact GitHub commit of the new plugin is added. Resolution runs
 * with the fixed managed executor under `--ignore-scripts` (the default deny)
 * into an ISOLATED staging directory, so preview never writes the environment
 * home, the active pointer or the source lock, and never enables build scripts
 * (no `allowBuilds`, no host config).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isPlainRecord, portFail, portOk, type PluginSourceSelector, type PortOutcome } from '@hdsl/contracts';
import type { GitProvider } from './preview-resolution.js';
import type { PluginExecutorPort } from './executor.js';
import { declaresBundle, reconcileProfileBundles, unresolvedBundleRisk } from './profile-bundles.js';
import { pluginTransportSpec } from './source-spec.js';

export interface TargetProfileInput {
  readonly source: PluginSourceSelector;
  /** Exact commit the source was previewed at. */
  readonly commitSha: string;
  /** Current generation's immutable declaration source directory. */
  readonly declarationDirectory: string;
  /** Isolated staging directory (must not be the environment home). */
  readonly stagingDirectory: string;
  /**
   * Managed Node executable of the CURRENT generation. It must be the managed
   * runtime, never `process.execPath`: inside the Electron main process
   * `process.execPath` is the Electron binary, which does not exit after running
   * a script (observed hang in the real desktop chain, QA33), so the resolution
   * child would never terminate.
   */
  readonly nodeExecutable: string;
}

export interface TargetProfileResolution {
  readonly targetLockText: string;
  readonly targetLockSha256: string;
  readonly targetDeclarationText: string;
  /** Workspace resolution config participating in the target (nullable). */
  readonly targetWorkspaceText: string | null;
  /** Binding digest over package.json + workspace config (not the lock). */
  readonly targetDeclarationSha256: string;
  /**
   * Risk statements for bundle declarations that could not be read. The caller
   * MUST surface these in the plan `riskItems`; an unreadable declaration leaves
   * the bundle entry untouched and must not read as "reconciled".
   */
  readonly bundleRiskItems: readonly string[];
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Bounded timeout for the isolated lock-only resolution. A stuck child must fail
 * the preview with a controlled error instead of leaving the operation running.
 */
const TARGET_PROFILE_RESOLUTION_TIMEOUT_MS = 180_000;

const readOptional = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8') : null;

export const resolveTargetProfileLock = async (
  gitProvider: GitProvider,
  executor: PluginExecutorPort,
  input: TargetProfileInput,
  signal: AbortSignal,
): Promise<PortOutcome<TargetProfileResolution>> => {
  // The source manifest is re-read so the caller cannot supply a stale name.
  const resolved = await gitProvider.resolveManifest(input.source, signal);
  if (!resolved.ok) {
    return resolved;
  }
  if (resolved.value.commitSha !== input.commitSha) {
    return portFail('PLAN_STALE', 'the source commit changed during target-profile resolution');
  }

  const declarationPath = join(input.declarationDirectory, 'package.json');
  const currentDeclaration = readOptional(declarationPath);
  if (currentDeclaration === null) {
    return portFail('INTERNAL_ERROR', 'the current generation has no immutable profile declaration source');
  }
  let declaration: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(currentDeclaration);
    if (!isPlainRecord(parsed)) {
      return portFail('INTERNAL_ERROR', 'the current profile declaration is malformed');
    }
    declaration = parsed;
  } catch {
    return portFail('INTERNAL_ERROR', 'the current profile declaration is not valid JSON');
  }
  const workspace = readOptional(join(input.declarationDirectory, 'pnpm-workspace.yaml'));
  const currentLock = readOptional(join(input.declarationDirectory, 'pnpm-lock.yaml'));

  // The plugin's own package name comes from the source manifest at the pinned
  // commit; it is the dependency key AND the profile bundle entry.
  let pluginName: string;
  let sourceManifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(resolved.value.manifestText);
    if (!isPlainRecord(parsed)) {
      return portFail('SOURCE_MANIFEST_INVALID', 'the source manifest is not a package manifest');
    }
    const name = parsed['name'];
    if (typeof name !== 'string' || name === '') {
      return portFail('SOURCE_MANIFEST_INVALID', 'the source manifest has no package name');
    }
    pluginName = name;
    sourceManifest = parsed;
  } catch {
    return portFail('SOURCE_MANIFEST_INVALID', 'the source manifest is not valid JSON');
  }

  // Build the target declaration: preserve everything, add only the exact
  // GitHub commit dependency for the new plugin. The recorded SOURCE stays a
  // GitHub repository + commit; the pnpm TRANSPORT spec is that commit's
  // official codeload tarball (#141), built by the single shared constructor.
  const dependencies = isPlainRecord(declaration['dependencies']) ? { ...declaration['dependencies'] } : {};
  const transportSpec = pluginTransportSpec(input.source, input.commitSha);
  dependencies[pluginName] = transportSpec;
  const dsh = isPlainRecord(declaration['dsh']) ? { ...declaration['dsh'] } : {};
  const profile = isPlainRecord(dsh['profile']) ? { ...dsh['profile'] } : {};
  const currentBundles = Array.isArray(profile['bundles'])
    ? profile['bundles'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  // Reconciliation BASELINE (#115): the source enters the bundle layer only when
  // its own manifest declares `dsh.bundle.patch`; a source that declares none is
  // added as a plain dependency and never guessed into the bundle layer.
  const reconciled = reconcileProfileBundles({
    currentBundles,
    dependencies: [{ name: pluginName, declaresBundle: declaresBundle(sourceManifest) }],
  });
  const bundles = reconciled.bundles;
  const bundleRiskItems = reconciled.unresolved.map(unresolvedBundleRisk);
  const targetDeclarationText = `${JSON.stringify(
    { ...declaration, dependencies, dsh: { ...dsh, profile: { ...profile, bundles } } },
    null,
    2,
  )}\n`;

  // The declaration binding covers package.json + every workspace config that
  // participates in resolution (not the lock, which is bound separately).
  const targetDeclarationSha256 = sha256(
    JSON.stringify({ declaration: targetDeclarationText, workspace }),
  );

  const staging = input.stagingDirectory;
  // Fail closed before spawning anything. The managed Node must be an explicit,
  // existing executable and must NOT be the host process binary: inside Electron
  // `process.execPath` is the Electron binary, which does not exit after running
  // a script (real desktop hang, QA33), and `dirname(execPath)` would also break
  // the isolated PATH. There is deliberately no `process.execPath` fallback.
  if (typeof input.nodeExecutable !== 'string' || input.nodeExecutable === '') {
    return portFail('INTERNAL_ERROR', 'the current generation has no managed Node executable for target-profile resolution');
  }
  if (input.nodeExecutable === process.execPath) {
    return portFail('INTERNAL_ERROR', 'target-profile resolution must not run under the host process binary');
  }
  if (!existsSync(input.nodeExecutable)) {
    return portFail('INTERNAL_ERROR', 'the managed Node executable for target-profile resolution does not exist');
  }
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'package.json'), targetDeclarationText, 'utf8');
    if (workspace !== null) {
      writeFileSync(join(staging, 'pnpm-workspace.yaml'), workspace, 'utf8');
    }
    if (currentLock !== null) {
      writeFileSync(join(staging, 'pnpm-lock.yaml'), currentLock, 'utf8');
    }

    // Resolution only, default deny. No allowBuilds and no host config.
    const run = await executor.run(
      {
        cwd: staging,
        homeDirectory: staging,
        nodeExecutable: input.nodeExecutable,
        args: ['install', '--lockfile-only', '--ignore-scripts'],
        timeoutMs: TARGET_PROFILE_RESOLUTION_TIMEOUT_MS,
      },
      signal,
    );
    if (!run.ok) {
      return run;
    }
    if (run.value.exitCode !== 0) {
      return portFail('INTERNAL_ERROR', 'the target profile lock could not be resolved');
    }
    const lockPath = join(staging, 'pnpm-lock.yaml');
    if (!existsSync(lockPath)) {
      return portFail('INTERNAL_ERROR', 'the target profile resolution produced no lockfile');
    }
    const targetLockText = readFileSync(lockPath, 'utf8');
    return portOk({
      targetLockText,
      targetLockSha256: sha256(targetLockText),
      targetDeclarationText,
      targetWorkspaceText: workspace,
      targetDeclarationSha256,
      bundleRiskItems,
    });
  } catch {
    return portFail('INTERNAL_ERROR', 'the target profile could not be resolved in isolation');
  } finally {
    // The staging directory is isolated preview cache; leave nothing behind that
    // could be mistaken for environment state.
    rmSync(staging, { recursive: true, force: true });
  }
};

/** Test helper: list the staging directory contents (must be empty after a run). */
export const stagingIsClean = (stagingDirectory: string): boolean =>
  !existsSync(stagingDirectory) || readdirSync(stagingDirectory).length === 0;
