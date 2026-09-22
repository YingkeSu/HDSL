/**
 * Production preview port that resolves the TARGET profile in isolation.
 *
 * It wraps the GitHub GitProvider (source resolution) and the frozen managed
 * executor (isolated, default-deny target-lock resolution via
 * resolveTargetProfileLock). The resulting resolution binds the target lock
 * digest + target declaration digest, so a plan is bound to the EXPECTED target
 * composition, not to the source repository's own lock.
 */
import { portOk, type ExecutorIdentity, type PluginSourceSelector, type PortOutcome } from '@hdsl/contracts';
import { buildPreviewResolution, type GitProvider } from './preview-resolution.js';
import type { PluginPreviewResolution } from './preview-resolution.js';
import type { PluginExecutorPort } from './executor.js';
import { resolveTargetProfileLock } from './target-profile.js';

export interface PreviewSourceContext {
  readonly declarationDirectory: string;
  readonly stagingDirectory: string;
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
      },
      signal,
    );
    if (!target.ok) {
      return target;
    }
    return portOk({
      ...built.value,
      sourceLock: {
        ...built.value.sourceLock,
        closureLockSha256: target.value.targetLockSha256,
        targetDeclarationSha256: target.value.targetDeclarationSha256,
      },
      targetLockText: target.value.targetLockText,
      targetDeclarationText: target.value.targetDeclarationText,
      targetWorkspaceText: target.value.targetWorkspaceText,
      targetDeclarationSha256: target.value.targetDeclarationSha256,
    });
  },
});
