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
import { mkdirSync, writeFileSync } from 'node:fs';
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
    const built = buildPreviewResolution({ source, resolved: resolved.value, executor: null });
    if (!built.ok) {
      return built;
    }
    const resolution = built.value;

    // 2) Default deny: a source that needs install-time scripts requires S4.
    if (resolution.requiresBuildAuthorization && command.buildAuthorization === null) {
      return portFail('BUILD_NOT_AUTHORIZED', 'the source requires an explicit build authorization');
    }

    // 3) Re-verify the managed executor identity (not the preview's self-report).
    const identity = await options.executor.identity(signal);
    if (!identity.ok) {
      return identity;
    }

    // 4) Materialise the profile declaration source (pinned to the exact commit)
    //    and install it with the default-deny arguments.
    const profileDirectory = join(command.generationDirectory, 'profile');
    mkdirSync(profileDirectory, { recursive: true });
    const profilePackage = {
      name: `hdsl-profile-${command.generationId}`,
      private: true,
      dependencies: { [resolution.sourceLock.packageName]: resolution.sourceLock.packageVersion },
      dsh: { profile: { bundles: [resolution.sourceLock.packageName] } },
    };
    writeFileSync(join(profileDirectory, 'package.json'), `${JSON.stringify(profilePackage, null, 2)}\n`, 'utf8');
    if (resolved.value.lockText !== null) {
      writeFileSync(join(profileDirectory, 'pnpm-lock.yaml'), resolved.value.lockText, 'utf8');
    }
    const run = await options.executor.run(
      {
        cwd: profileDirectory,
        homeDirectory: command.homeDirectory,
        nodeExecutable: command.nodeExecutable,
        args: [...DEFAULT_INSTALL_ARGS],
        ...(options.registry === undefined ? {} : { registry: options.registry }),
      },
      signal,
    );
    if (!run.ok) {
      return run;
    }
    if (run.value.exitCode !== 0) {
      return portFail('INTERNAL_ERROR', 'the managed pnpm install failed for the new generation');
    }

    // 5) Compose the new lock from the reused runtime lock + resolved plugin.
    const plugin: PluginLock = {
      id: resolution.sourceLock.packageName,
      version: resolution.sourceLock.packageVersion,
      sha256: resolution.sourceLock.manifestSha256,
    };
    const compositionLock: CompositionLock = {
      ...command.currentLock,
      plugins: [...command.currentLock.plugins, plugin],
    };
    return portOk({
      compositionLock,
      sourceLock: resolution.sourceLock,
      stagedProfileDirectory: profileDirectory,
    });
  },
});
