/**
 * Production removal port (#77 S3).
 *
 * Structural mirror of core's `PluginRemovalPort` (ADR 0005 D17: core and runtime
 * never import each other). It performs the filesystem reads, the structural
 * reference scans, the in-box resolution and the isolated pruned-lock recompute
 * that core cannot do without the executor.
 *
 * Trust/identity rules:
 *   - the in-box set comes from the CURRENT managed install (`<gen>/dsh`); a
 *     missing/unreadable scope is a controlled failure, never an empty set;
 *   - extra `pnpm-lock.yaml`-declared `node_modules` entries are scanned from the
 *     PUBLISHED profile only after its declaration bytes match the generation's
 *     immutable declaration source (a drifted live profile is not an identity);
 *   - the user patch (`<env>/home/cordis.patch.yml`) is read but NEVER written;
 *   - the pruned lock is recomputed in an isolated staging directory under the
 *     MANAGED Node and the frozen pnpm executor, default deny.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import { resolveInBoxBundles, type InBoxBundle } from './removal.js';
import { resolvePluginRemoval, type PluginReferenceSource, type PluginRemovalResolution } from './removal.js';
import { scanPatchReferences } from './patch-references.js';
import {
  lookupServiceVerification,
  type ServiceVerificationLookup,
  type ServiceVerificationQuery,
} from './service-verifications.js';
import type { PluginExecutorPort } from './executor.js';

/** Bounded timeout for the isolated lock-only recompute. */
const REMOVAL_LOCK_TIMEOUT_MS = 180_000;
/** Maximum enabled bundles whose patches are scanned. */
const BUNDLE_PATCH_SCAN_MAX = 64;
/** Maximum patch bytes read per source. */
const PATCH_FILE_MAX = 256 * 1024;

export interface InstalledPluginLock {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
}

export interface RemovalListInput {
  readonly installed: readonly InstalledPluginLock[];
  readonly enabledBundles: readonly string[];
  readonly dshDirectory: string;
  /** Recorded composition-lock source identity per plugin (never a path). */
  readonly sources?: Readonly<Record<string, { readonly owner: string; readonly name: string; readonly commitSha: string | null }>> | undefined;
}

export interface RemovalListEntry {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly isBuiltin: boolean;
  readonly enabledBundle: boolean;
  readonly source: { readonly owner: string; readonly name: string; readonly commitSha: string | null } | null;
}

export interface RemovalResolveInput {
  readonly pluginId: string;
  readonly expectedCommitSha: string | null;
  readonly expectedManifestSha256: string | null;
  /** Current generation's immutable declaration source (`<gen>/profile`). */
  readonly declarationDirectory: string;
  /** Published profile of the current generation (`<env>/home/profiles/hdsl-<gen>`). */
  readonly publishedProfileDirectory: string;
  /** Environment home (user patch lives here). */
  readonly homeDirectory: string;
  readonly dshDirectory: string;
  readonly nodeExecutable: string;
  readonly stagingDirectory: string;
  readonly installed: readonly InstalledPluginLock[];
  readonly enabledBundles: readonly string[];
  /** Current managed generation runtime identity (install manifest + install tree). */
  readonly runtime: ServiceVerificationQuery['runtime'];
}

export interface RemovalResolution extends PluginRemovalResolution {
  readonly targetLockText: string;
  readonly targetLockSha256: string;
  readonly targetDeclarationText: string;
  readonly targetWorkspaceText: string | null;
  readonly targetDeclarationSha256: string;
  readonly inBoxBundles: readonly InBoxBundle[];
  readonly serviceVerification: ServiceVerificationLookup;
}

export interface RemovalApplyInput {
  readonly pluginId: string;
  /** Pruned declaration + lock bound by the plan (read from the plan's cache). */
  readonly declarationText: string;
  readonly lockText: string;
  readonly workspaceText: string | null;
  /** Generation directory whose `<gen>/profile` receives the pruned profile. */
  readonly generationDirectory: string;
  readonly homeDirectory: string;
  readonly nodeExecutable: string;
  /** Installed plugins WITHOUT the removed one (the retained composition). */
  readonly retainedPlugins: readonly { readonly id: string; readonly version: string; readonly sha256: string }[];
}

export interface RemovalApplyResult {
  readonly installed: readonly { readonly id: string; readonly version: string; readonly sha256: string }[];
  readonly lockSha256: string;
  readonly declarationSha256: string;
}

export interface PluginRemovalPort {
  listInstalled(input: RemovalListInput, signal: AbortSignal): Promise<PortOutcome<readonly RemovalListEntry[]>>;
  resolveRemoval(input: RemovalResolveInput, signal: AbortSignal): Promise<PortOutcome<RemovalResolution>>;
  /**
   * Applies the pruned profile with `--frozen-lockfile --ignore-scripts` under the
   * managed Node, then returns the retained composition. The caller (core) owns
   * the pointer switch, journal, revision re-validation and ledger.
   */
  applyRemoval(input: RemovalApplyInput, signal: AbortSignal): Promise<PortOutcome<RemovalApplyResult>>;
}

const readOptional = (path: string): string | null => {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const text = readFileSync(path, 'utf8');
    return text.length > PATCH_FILE_MAX ? text.slice(0, PATCH_FILE_MAX) : text;
  } catch {
    return null;
  }
};

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const createPluginRemovalPort = (options: { readonly executor: PluginExecutorPort }): PluginRemovalPort => ({
  async listInstalled(input) {
    const inBox = resolveInBoxBundles(input.dshDirectory);
    if (inBox === undefined) {
      // Missing/untrusted install scope is a controlled failure, never "no builtins".
      return portFail('INTERNAL_ERROR', 'the in-box bundle set of the managed install could not be resolved');
    }
    const inBoxNames = new Set(inBox.map((bundle) => bundle.name));
    const enabled = new Set(input.enabledBundles);
    return portOk(
      input.installed.map((plugin) => ({
        id: plugin.id,
        version: plugin.version,
        sha256: plugin.sha256,
        isBuiltin: inBoxNames.has(plugin.id),
        enabledBundle: enabled.has(plugin.id),
        source: input.sources?.[plugin.id] ?? null,
      })),
    );
  },

  async applyRemoval(input, signal) {
    const profileDirectory = join(input.generationDirectory, 'profile');
    try {
      mkdirSync(profileDirectory, { recursive: true });
      writeFileSync(join(profileDirectory, 'package.json'), input.declarationText, 'utf8');
      writeFileSync(join(profileDirectory, 'pnpm-lock.yaml'), input.lockText, 'utf8');
      if (input.workspaceText !== null) {
        writeFileSync(join(profileDirectory, 'pnpm-workspace.yaml'), input.workspaceText, 'utf8');
      }
      const run = await options.executor.run(
        {
          cwd: profileDirectory,
          homeDirectory: input.homeDirectory,
          nodeExecutable: input.nodeExecutable,
          args: ['install', '--frozen-lockfile', '--ignore-scripts'],
          timeoutMs: REMOVAL_LOCK_TIMEOUT_MS,
        },
        signal,
      );
      if (!run.ok) {
        return run;
      }
      if (run.value.exitCode !== 0) {
        return portFail('INTERNAL_ERROR', 'the pruned profile install failed');
      }
      const lockAfter = readFileSync(join(profileDirectory, 'pnpm-lock.yaml'), 'utf8');
      if (lockAfter !== input.lockText) {
        // The install must not silently rewrite the pruned lock the plan bound.
        return portFail('PLUGIN_INTEGRITY_MISMATCH', 'the pruned profile lock was rewritten during install');
      }
      return portOk({
        installed: input.retainedPlugins,
        lockSha256: sha256Of(lockAfter),
        declarationSha256: sha256Of(input.declarationText),
      });
    } catch {
      return portFail('INTERNAL_ERROR', 'the pruned profile could not be installed');
    }
  },

  async resolveRemoval(input, signal) {
    const inBox = resolveInBoxBundles(input.dshDirectory);
    if (inBox === undefined) {
      return portFail('INTERNAL_ERROR', 'the in-box bundle set of the managed install could not be resolved');
    }

    const declarationPath = join(input.declarationDirectory, 'package.json');
    const declarationText = readOptional(declarationPath);
    if (declarationText === null) {
      return portFail('INTERNAL_ERROR', 'the current generation has no immutable profile declaration source');
    }
    const workspaceText = readOptional(join(input.declarationDirectory, 'pnpm-workspace.yaml'));
    const currentLockText = readOptional(join(input.declarationDirectory, 'pnpm-lock.yaml'));

    // Reference sources. The user patch is read-only; the published profile is
    // used only when its declaration bytes match the immutable source.
    const referenceSources: PluginReferenceSource[] = [];
    const pushScan = (kind: PluginReferenceSource['kind'], detail: string, text: string | null): void => {
      if (text === null) {
        return;
      }
      const scan = scanPatchReferences(detail, text);
      referenceSources.push({
        kind,
        detail,
        references: scan.references,
        rowIds: scan.rowIds,
        rowTargets: scan.rowTargets,
        services: scan.services,
        unresolved: scan.unknown.length > 0,
      });
    };

    const profilePatch = readOptional(join(input.declarationDirectory, 'cordis.patch.yml'));
    pushScan('config', 'profile patch', profilePatch);
    pushScan('userPatch', 'user patch (home/cordis.patch.yml)', readOptional(join(input.homeDirectory, 'cordis.patch.yml')));

    const immutableDeclaration = readOptional(join(input.declarationDirectory, 'package.json'));
    const publishedDeclaration = readOptional(join(input.publishedProfileDirectory, 'package.json'));
    const publishedMatches =
      immutableDeclaration !== null && publishedDeclaration !== null && immutableDeclaration === publishedDeclaration;

    let removedRowIds: readonly string[] = [];
    let removedServiceNames: readonly string[] = [];
    if (publishedMatches) {
      for (const bundle of input.enabledBundles.slice(0, BUNDLE_PATCH_SCAN_MAX)) {
        if (bundle === input.pluginId) {
          continue;
        }
        const patchPath = join(input.publishedProfileDirectory, 'node_modules', bundle, 'cordis.patch.yml');
        pushScan('bundle', `bundle ${bundle}`, readOptional(patchPath));
      }
      const ownPatch = readOptional(
        join(input.publishedProfileDirectory, 'node_modules', input.pluginId, 'cordis.patch.yml'),
      );
      if (ownPatch !== null) {
        // The removed plugin's own patch contributes its OWN row ids and consumed
        // service names; it is not a "reference from elsewhere" (its self `name`
        // entry must never block its own removal).
        const own = scanPatchReferences(`plugin ${input.pluginId}`, ownPatch);
        removedRowIds = own.rowIds;
        removedServiceNames = own.services;
      }
    } else {
      // A drifted/unavailable published profile cannot be used as an identity: the
      // reference scan is incomplete, so the resolution must fail closed.
      referenceSources.push({
        kind: 'config',
        detail: 'published profile is not byte-identical to the immutable declaration source',
        references: [],
        rowIds: [],
        rowTargets: [],
        services: [],
        unresolved: true,
      });
    }

    // The verified-install manifest digest: the installed package's own
    // `package.json` under the (identity-checked) published profile. This avoids
    // adding contract fields while keeping the verification binding strict.
    let installedManifestSha256: string | null = input.expectedManifestSha256;
    if (installedManifestSha256 === null && publishedMatches) {
      const installedManifest = readOptional(
        join(input.publishedProfileDirectory, 'node_modules', input.pluginId, 'package.json'),
      );
      installedManifestSha256 = installedManifest === null ? null : sha256Of(installedManifest);
    }
    const serviceVerification = lookupServiceVerification({
      pluginId: input.pluginId,
      commitSha: input.expectedCommitSha,
      manifestSha256: installedManifestSha256,
      runtime: input.runtime,
    });

    const resolution = resolvePluginRemoval({
      pluginId: input.pluginId,
      declarationText,
      workspaceText,
      installed: input.installed.map((plugin) => ({ id: plugin.id, version: plugin.version })),
      inBoxBundles: inBox,
      referenceSources,
      removedRowIds,
      removedServiceNames,
      serviceVerification,
    });
    if (!resolution.ok) {
      return portFail(resolution.code, resolution.message);
    }

    const staging = input.stagingDirectory;
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, 'package.json'), resolution.value.prunedDeclarationText, 'utf8');
      if (workspaceText !== null) {
        writeFileSync(join(staging, 'pnpm-workspace.yaml'), workspaceText, 'utf8');
      }
      if (currentLockText !== null) {
        writeFileSync(join(staging, 'pnpm-lock.yaml'), currentLockText, 'utf8');
      }
      const run = await options.executor.run(
        {
          cwd: staging,
          homeDirectory: staging,
          nodeExecutable: input.nodeExecutable,
          args: ['install', '--lockfile-only', '--ignore-scripts'],
          timeoutMs: REMOVAL_LOCK_TIMEOUT_MS,
        },
        signal,
      );
      if (!run.ok) {
        return run;
      }
      if (run.value.exitCode !== 0) {
        return portFail('INTERNAL_ERROR', 'the pruned target profile lock could not be resolved');
      }
      const lockPath = join(staging, 'pnpm-lock.yaml');
      if (!existsSync(lockPath)) {
        return portFail('INTERNAL_ERROR', 'the pruned target profile resolution produced no lockfile');
      }
      const targetLockText = readFileSync(lockPath, 'utf8');
      return portOk({
        ...resolution.value,
        targetLockText,
        targetLockSha256: sha256Of(targetLockText),
        targetDeclarationText: resolution.value.prunedDeclarationText,
        targetWorkspaceText: resolution.value.prunedWorkspaceText,
        targetDeclarationSha256: sha256Of(
          JSON.stringify({ declaration: resolution.value.prunedDeclarationText, workspace: workspaceText }),
        ),
        inBoxBundles: inBox,
        serviceVerification,
      });
    } catch {
      return portFail('INTERNAL_ERROR', 'the pruned target profile could not be resolved in isolation');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  },
});
