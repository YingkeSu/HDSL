/**
 * Runtime-owned `changes.apply` adapter (ADR 0005 D8/D14, ADR 0006 D-B).
 *
 * Re-resolves the source at an exact commit (never trusting the preview or the
 * plan), enforces the default deny (`--ignore-scripts`) through the verified
 * managed executor, materialises the profile declaration source, and composes
 * the new generation's lock from the REUSED runtime lock plus the resolved
 * plugin identity. Core owns the commit (pointer switch) and the runtime copy.
 *
 * It never loads plugin code in-process and never receives a credential.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  portFail,
  portOk,
  type BuildAuthorization,
  type ChangePlan,
  type CompositionLock,
  type PluginLock,
  type PluginSourceLock,
  type PortOutcome,
} from '@hdsl/contracts';
import { buildPreviewResolution, type GitProvider } from './preview-resolution.js';
import { composeAuthorizedWorkspace, decideBuildAuthorization, enumerateInstallScriptsFromInstalledTree } from './build-authorization.js';
import { DEFAULT_INSTALL_ARGS, type PluginExecutorPort } from './executor.js';

export interface RuntimeApplyStageCommand {
  readonly environmentId: string;
  readonly generationId: string;
  readonly generationDirectory: string;
  readonly environmentDirectory: string;
  readonly homeDirectory: string;
  readonly nodeExecutable: string;
  readonly currentLock: CompositionLock;
  readonly plan: ChangePlan;
  readonly buildAuthorization: BuildAuthorization | null;
  /** Verified target profile (frozen lock + declaration); when present it is used verbatim. */
  readonly targetProfile?: {
    readonly lockText: string;
    readonly declarationText: string;
    readonly workspaceText: string | null;
  };
}

export interface RuntimeApplyStaged {
  readonly compositionLock: CompositionLock;
  readonly sourceLock: PluginSourceLock;
  readonly stagedProfileDirectory: string;
}

export interface RuntimePluginApplyPort {
  stage(
    command: RuntimeApplyStageCommand,
    signal: AbortSignal,
  ): Promise<PortOutcome<RuntimeApplyStaged>>;
}

export interface PluginApplyPortOptions {
  readonly gitProvider: GitProvider;
  readonly executor: PluginExecutorPort;
  /** Pinned registry; defaults to the official registry in the executor. */
  readonly registry?: string;
}

export const createPluginApplyPort = (options: PluginApplyPortOptions): RuntimePluginApplyPort => ({
  async stage(command, signal) {
    if (command.plan.action.kind !== 'install') {
      return portFail('INTERNAL_ERROR', 'remove apply is not implemented in this slice');
    }
    const source = command.plan.action.source;

    // 1) Re-resolve the source at the exact commit; never trust plan/preview.
    const resolved = await options.gitProvider.resolveManifest(source, signal);
    if (!resolved.ok) {
      return resolved;
    }
    // 2) Re-verify the managed executor identity BEFORE any plan comparison; the
    //    plan's executor identity must match the real one exactly.
    const identity = await options.executor.identity(signal);
    if (!identity.ok) {
      return identity;
    }
    const built = buildPreviewResolution({ source, resolved: resolved.value, executor: identity.value });
    if (!built.ok) {
      return built;
    }
    const resolution = built.value;

    // 3) Build authorization (S4) is decided AFTER the plan/executor binding
    //    checks below; it needs the re-resolved script set and the plan-bound lock
    //    and MUST complete before any write or executor run. Until then the
    //    default-deny shape is preserved.

    // 4) Bind to the PREVIEWED exact commit and closure. A branch that moved, a
    //    different closure lock, or an unrecorded/unpinned closure is drift, not
    //    a silent new composition.
    const planLock = command.plan.sourceLock;
    if (planLock === null) {
      return portFail('PLAN_STALE', 'the plan has no source lock to bind against');
    }
    if (planLock.commitSha !== resolution.sourceLock.commitSha) {
      return portFail('PLAN_STALE', 'the previewed commit is no longer what the ref resolves to');
    }
    if (planLock.manifestSha256 !== resolution.sourceLock.manifestSha256) {
      return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the manifest at the previewed commit has changed');
    }
    if (command.targetProfile !== undefined) {
      // The plan binds the EXPECTED TARGET PROFILE lock; verify the cached lock
      // matches it (core already verified the cache digest, this is defence in
      // depth inside the adapter).
      if (planLock.closureLockSha256 !== createHash('sha256').update(command.targetProfile.lockText, 'utf8').digest('hex')) {
        return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the target profile lock does not match the plan');
      }
    } else {
      // Legacy/source-only: the closure must be pinned and unchanged.
      if (planLock.closureLockSha256 === null || resolution.sourceLock.closureLockSha256 === null) {
        return portFail('PLAN_STALE', 'the dependency closure is not fully pinned; refusing to install a non-deterministic composition');
      }
      if (planLock.closureLockSha256 !== resolution.sourceLock.closureLockSha256) {
        return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the dependency closure has changed since the preview');
      }
    }
    if (
      command.plan.executor === null ||
      command.plan.executor.sha256 !== identity.value.sha256 ||
      command.plan.executor.entrySha256 !== identity.value.entrySha256 ||
      command.plan.executor.treeSha256 !== identity.value.treeSha256 ||
      command.plan.executor.version !== identity.value.version
    ) {
      return portFail('EXECUTOR_UNAVAILABLE', 'the managed executor identity does not match the plan');
    }
    if (command.plan.planInputsDigest !== resolution.planInputsDigest) {
      return portFail('PLAN_STALE', 'the plan inputs digest does not match the re-resolved source');
    }

    // S4 authorization decision: exact commit + exact enumerated script set +
    // plan-bound lock identity, evaluated BEFORE any write or execution.
    const profileDirectory = join(command.generationDirectory, 'profile');
    mkdirSync(profileDirectory, { recursive: true });
    const targetProfile = command.targetProfile;
    const runInstall = async (args: readonly string[]) =>
      options.executor.run(
        {
          cwd: profileDirectory,
          homeDirectory: command.homeDirectory,
          nodeExecutable: command.nodeExecutable,
          args,
          ...(options.registry === undefined ? {} : { registry: options.registry }),
        },
        signal,
      );

    // S4 authorization decision (before any write or run). `enumerate` means an
    // explicit authorization is present and the dependency closure must first be
    // materialised with DEFAULT DENY (no scripts) and read read-only.
    let authorization = decideBuildAuthorization({
      authorization: command.buildAuthorization,
      commitSha: resolution.sourceLock.commitSha,
      scriptAssessment: resolution.scriptAssessment,
      scripts: resolution.scripts,
      closureEnumerated: resolution.dependencyClosureEnumerated,
      lockText: command.targetProfile?.lockText ?? null,
    });
    if (!authorization.ok) {
      return portFail(authorization.code, authorization.message);
    }
    let sourceLock = resolution.sourceLock;
    let expectedLockText: string | null;
    let workspacePath: string | null = null;
    let ranDenyInstall = false;

    // 4) Materialise the profile declaration source (pinned to the exact commit).
    if (targetProfile !== undefined) {
      writeFileSync(join(profileDirectory, 'package.json'), targetProfile.declarationText, 'utf8');
      writeFileSync(join(profileDirectory, 'pnpm-lock.yaml'), targetProfile.lockText, 'utf8');
      workspacePath = join(profileDirectory, 'pnpm-workspace.yaml');
      if (targetProfile.workspaceText !== null) {
        writeFileSync(workspacePath, targetProfile.workspaceText, 'utf8');
      } else {
        rmSync(workspacePath, { force: true });
      }
      expectedLockText = targetProfile.lockText;
    } else {
      if (command.buildAuthorization !== null) {
        return portFail('BUILD_NOT_AUTHORIZED', 'build authorization requires a plan-bound target profile lock');
      }
      const gitSpec = `github:${source.owner}/${source.name}#${resolution.sourceLock.commitSha}`;
      const profilePackage = {
        name: `hdsl-profile-${command.generationId}`,
        private: true,
        dependencies: { [resolution.sourceLock.packageName]: gitSpec },
        dsh: { profile: { bundles: [resolution.sourceLock.packageName] } },
      };
      writeFileSync(join(profileDirectory, 'package.json'), `${JSON.stringify(profilePackage, null, 2)}\n`, 'utf8');
      if (resolved.value.lockText !== null) {
        writeFileSync(join(profileDirectory, 'pnpm-lock.yaml'), resolved.value.lockText, 'utf8');
      }
      expectedLockText = resolved.value.lockText;
    }
    const isAuthorizedTarget = targetProfile !== undefined;

    // 5) Enumerate the closure read-only with a default-deny materialisation,
    //    then re-decide against the FULL enumerated script set.
    if (authorization.mode === 'enumerate') {
      if (!isAuthorizedTarget) {
        return portFail('BUILD_NOT_AUTHORIZED', 'build authorization requires a plan-bound target profile lock');
      }
      const pre = await runInstall(['install', '--frozen-lockfile', '--ignore-scripts']);
      if (!pre.ok) {
        return pre;
      }
      if (pre.value.exitCode !== 0) {
        return portFail('INTERNAL_ERROR', 'the plan-bound profile could not be materialised for script enumeration');
      }
      ranDenyInstall = true;
      const dependencyScripts = enumerateInstallScriptsFromInstalledTree({
        nodeModulesDirectory: join(profileDirectory, 'node_modules'),
        lockText: targetProfile.lockText,
        excludePackageName: resolution.sourceLock.packageName,
        readPackageJsonText: (path) => {
          try {
            return readFileSync(path, 'utf8');
          } catch {
            return undefined;
          }
        },
      });
      if (dependencyScripts === undefined) {
        return portFail(
          'BUILD_NOT_AUTHORIZED',
          'the install-time dependency closure could not be fully verified against the pinned lock',
        );
      }
      const effectiveScripts = [...resolution.scripts, ...dependencyScripts];
      const final = decideBuildAuthorization({
        authorization: command.buildAuthorization,
        commitSha: resolution.sourceLock.commitSha,
        scriptAssessment: 'detected',
        scripts: effectiveScripts,
        closureEnumerated: true,
        lockText: targetProfile.lockText,
      });
      if (!final.ok) {
        return portFail(final.code, final.message);
      }
      authorization = final;
    }

    // 6) Install: default deny, or the exact single-install authorization (its
    //    `allowBuilds` map is written for this install and cleared immediately
    //    after, so it can never become a resident allowlist).
    if (authorization.mode === 'allow' && isAuthorizedTarget && targetProfile !== undefined) {
      const composed = composeAuthorizedWorkspace(targetProfile.workspaceText, authorization.depPaths);
      if (!composed.ok) {
        return portFail('AUTHORIZATION_MISMATCH', composed.message);
      }
      writeFileSync(workspacePath as string, composed.text, 'utf8');
      const restoreWorkspace = (): void => {
        if (targetProfile.workspaceText === null) {
          rmSync(workspacePath as string, { force: true });
        } else {
          writeFileSync(workspacePath as string, targetProfile.workspaceText, 'utf8');
        }
      };
      const authorized = await runInstall(['install', '--frozen-lockfile', '--ignore-scripts=false']);
      restoreWorkspace();
      if (!authorized.ok) {
        return authorized;
      }
      if (authorized.value.exitCode !== 0) {
        return portFail('INTERNAL_ERROR', 'the authorized managed pnpm install failed for the new generation');
      }
      sourceLock = { ...resolution.sourceLock, buildAuthorization: command.buildAuthorization };
    } else if (!ranDenyInstall) {
      const denyArgs = isAuthorizedTarget
        ? (['install', '--frozen-lockfile', '--ignore-scripts'] as const)
        : DEFAULT_INSTALL_ARGS;
      const denied = await runInstall([...denyArgs]);
      if (!denied.ok) {
        return denied;
      }
      if (denied.value.exitCode !== 0) {
        return portFail('INTERNAL_ERROR', 'the managed pnpm install failed for the new generation');
      }
    }
    // The install must not silently rewrite the pinned lock: if it did, the
    // composition is no longer what the plan bound.
    if (expectedLockText !== null) {
      const lockPath = join(profileDirectory, 'pnpm-lock.yaml');
      try {
        const after = createHash('sha256').update(readFileSync(lockPath)).digest('hex');
        const expected = createHash('sha256').update(expectedLockText, 'utf8').digest('hex');
        if (after !== expected) {
          return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the managed install rewrote the pinned lockfile');
        }
      } catch {
        return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the pinned lockfile is missing after the managed install');
      }
    }

    // 5) Compose the new lock from the reused runtime lock + resolved plugin.
    // Composition identity binds the plugin's CODE identity together with its
    // resolved closure: the exact commit and manifest digest are part of the
    // identity, so two sources that happen to share a lockfile (e.g. a fixture
    // whose two commits differ only in source) still produce DIFFERENT
    // composition identities. The closure lock digest is included too, so the
    // resolved dependency closure is covered.
    const pluginDigest = createHash('sha256')
      .update(
        JSON.stringify({
          commitSha: resolution.sourceLock.commitSha,
          manifestSha256: resolution.sourceLock.manifestSha256,
          closureLockSha256: resolution.sourceLock.closureLockSha256,
        }),
        'utf8',
      )
      .digest('hex');
    const plugin: PluginLock = {
      id: resolution.sourceLock.packageName,
      version: resolution.sourceLock.packageVersion,
      sha256: pluginDigest,
    };
    // Record the non-digest SOURCE provenance so a later removal can re-verify the
    // exact repository/commit/manifest identity instead of inventing trust from
    // live files (ADR 0005 D13/D21). It never changes the composition digest.
    const pluginSources = {
      ...(command.currentLock.pluginSources ?? {}),
      [resolution.sourceLock.packageName]: sourceLock,
    };
    const compositionLock: CompositionLock = {
      ...command.currentLock,
      plugins: [...command.currentLock.plugins, plugin],
      pluginSources,
    };
    return portOk({
      compositionLock,
      sourceLock,
      stagedProfileDirectory: profileDirectory,
    });
  },
});
