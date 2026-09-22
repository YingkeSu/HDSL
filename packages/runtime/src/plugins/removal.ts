/**
 * S3 removal resolution (#77, ADR 0005 D15).
 *
 * Three branches with deterministic, offline resolution:
 *   - **remove**: the direct dependency entry and the enabled-bundle reference.
 *   - **retention**: shared/transitive dependencies stay in the lock (AC: the
 *     package is NOT required to disappear entirely), plus the user patch layer,
 *     the environment data and the audit log.
 *   - **blocked**: an in-box bundle of the CURRENT managed DSH install
 *     (`BUILTIN_BUNDLE_PROTECTED`, F12a) or a reference from another bundle /
 *     configuration / the user patch layer (`REFERENCED_BY_OTHER`, with source).
 *
 * The in-box set is resolved from the managed install's own tree, never from a
 * client-provided list and never from a same-name profile dependency.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainRecord } from '@hdsl/contracts';

/** Maximum packages inspected in the managed install's `@deepseek-ai` scope. */
const IN_BOX_SCAN_MAX = 1_000;
/** Maximum reference sources scanned for the removed plugin id. */
const REFERENCE_SOURCES_MAX = 64;
/** Maximum characters scanned per reference source (bounded, no full-file regex). */
const REFERENCE_SCAN_MAX = 256 * 1024;

/** Structural mirror of the frozen `ChangePlan.blockingReferences` entry. */
export interface ChangeBlockingReference {
  readonly pluginId: string;
  readonly kind: 'bundle' | 'config' | 'userPatch';
  readonly detail: string;
}

export interface InBoxBundle {
  readonly name: string;
  readonly version: string;
}

const readJsonRecord = (path: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Resolves the in-box bundle set of a managed DSH installation (F12a).
 *
 * An in-box bundle is a package in `<dshDirectory>/node_modules/@deepseek-ai/*`
 * declaring `dsh.bundle.patch` — the same "is a bundle" rule HDSL applies to any
 * package. Returns `undefined` when the install tree is missing or unreadable so
 * callers fail closed instead of treating a partial set as authoritative.
 */
export const resolveInBoxBundles = (dshDirectory: string): readonly InBoxBundle[] | undefined => {
  const scope = join(dshDirectory, 'node_modules', '@deepseek-ai');
  let names: string[];
  try {
    if (!existsSync(scope) || !statSync(scope).isDirectory()) {
      return undefined;
    }
    names = readdirSync(scope).slice(0, IN_BOX_SCAN_MAX);
  } catch {
    return undefined;
  }
  const bundles: InBoxBundle[] = [];
  for (const name of names) {
    const manifest = readJsonRecord(join(scope, name, 'package.json'));
    if (manifest === undefined) {
      continue;
    }
    const dsh = isPlainRecord(manifest['dsh']) ? manifest['dsh'] : undefined;
    const bundle = dsh !== undefined && isPlainRecord(dsh['bundle']) ? dsh['bundle'] : undefined;
    const patch = bundle === undefined ? undefined : asString(bundle['patch']);
    const packageName = asString(manifest['name']);
    const version = asString(manifest['version']);
    if (patch === undefined || packageName === undefined || version === undefined) {
      continue;
    }
    bundles.push({ name: packageName, version });
  }
  // An install without the DSH scope cannot prove its in-box set.
  return bundles.length === 0 ? undefined : bundles;
};

export interface PluginReferenceSource {
  readonly kind: 'bundle' | 'config' | 'userPatch';
  /** Bounded, non-absolute description shown to the operator. */
  readonly detail: string;
  /** File text scanned for the plugin id (already bounded by the caller). */
  readonly text: string;
}

export interface PluginRemovalInput {
  readonly pluginId: string;
  /** Current generation's immutable declaration source (`package.json`). */
  readonly declarationText: string;
  readonly workspaceText: string | null;
  /** Installed plugin locks of the active generation (`composition.lock.json`). */
  readonly installed: readonly { readonly id: string; readonly version: string }[];
  /** In-box bundles of the current managed DSH install. */
  readonly inBoxBundles: readonly InBoxBundle[];
  /** Other places that may reference the plugin (patches, configs). */
  readonly referenceSources: readonly PluginReferenceSource[];
}

export interface PluginRemovalResolution {
  readonly removals: readonly string[];
  readonly retention: readonly string[];
  readonly blockingReferences: readonly ChangeBlockingReference[];
  /** Declaration without the direct dependency entry and bundle reference. */
  readonly prunedDeclarationText: string;
  readonly prunedWorkspaceText: string | null;
}

export type PluginRemovalOutcome =
  | { readonly ok: true; readonly value: PluginRemovalResolution }
  | { readonly ok: false; readonly code: 'NOT_FOUND' | 'BUILTIN_BUNDLE_PROTECTED' | 'REFERENCED_BY_OTHER' | 'INTERNAL_ERROR'; readonly message: string };

const boundedScan = (text: string): string =>
  text.length > REFERENCE_SCAN_MAX ? text.slice(0, REFERENCE_SCAN_MAX) : text;

/** True when `pluginId` appears as a whole token (not a substring of another id). */
const referencesPlugin = (text: string, pluginId: string): boolean => {
  const haystack = boundedScan(text);
  let index = haystack.indexOf(pluginId);
  while (index !== -1) {
    const before = index === 0 ? '' : (haystack[index - 1] ?? '');
    const afterIndex = index + pluginId.length;
    const after = afterIndex >= haystack.length ? '' : (haystack[afterIndex] ?? '');
    const boundary = /[A-Za-z0-9._@/-]/;
    if (!boundary.test(before) && !boundary.test(after)) {
      return true;
    }
    index = haystack.indexOf(pluginId, index + 1);
  }
  return false;
};

/**
 * Pure resolution of a remove preview. Never touches the filesystem: the caller
 * supplies the immutable declaration source, the installed locks, the in-box set
 * and the reference sources it read.
 */
export const resolvePluginRemoval = (input: PluginRemovalInput): PluginRemovalOutcome => {
  let declaration: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input.declarationText);
    if (!isPlainRecord(parsed)) {
      return { ok: false, code: 'INTERNAL_ERROR', message: 'the current profile declaration is malformed' };
    }
    declaration = parsed;
  } catch {
    return { ok: false, code: 'INTERNAL_ERROR', message: 'the current profile declaration is not valid JSON' };
  }

  const dependencies = isPlainRecord(declaration['dependencies']) ? { ...declaration['dependencies'] } : {};
  const dsh = isPlainRecord(declaration['dsh']) ? declaration['dsh'] : {};
  const profile = isPlainRecord(dsh['profile']) ? { ...dsh['profile'] } : {};
  const bundles = Array.isArray(profile['bundles']) ? [...profile['bundles']] : [];
  const isDependency = Object.hasOwn(dependencies, input.pluginId);
  const isEnabledBundle = bundles.includes(input.pluginId);
  if (!isDependency && !isEnabledBundle) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'the plugin is not a direct profile dependency or an enabled bundle of the active generation',
    };
  }

  const blockingReferences: ChangeBlockingReference[] = [];
  const inBox = input.inBoxBundles.find((bundle) => bundle.name === input.pluginId);
  if (inBox !== undefined) {
    blockingReferences.push({
      pluginId: input.pluginId,
      kind: 'bundle',
      detail: `in-box bundle of the current managed DSH install (${inBox.version})`,
    });
  }

  for (const source of input.referenceSources.slice(0, REFERENCE_SOURCES_MAX)) {
    if (source.kind === 'bundle' && source.detail.startsWith(`${input.pluginId} `)) {
      // The removed plugin's own patch is not a reference from elsewhere.
      continue;
    }
    if (referencesPlugin(source.text, input.pluginId)) {
      blockingReferences.push({ pluginId: input.pluginId, kind: source.kind, detail: source.detail });
    }
  }

  const removals = [
    isDependency ? `dependency entry ${input.pluginId}@${asString(dependencies[input.pluginId]) ?? 'pinned'}` : null,
    isEnabledBundle ? `enabled bundle reference ${input.pluginId}` : null,
  ].filter((entry): entry is string => entry !== null);

  const missing = !input.installed.some((plugin) => plugin.id === input.pluginId);
  if (missing && blockingReferences.length === 0) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'the plugin is not present in the active generation composition',
    };
  }

  const retention = [
    'user patch layer (home cordis.patch.yml)',
    'environment data (home/ and data/)',
    'plugin operation audit log',
    ...Object.keys(dependencies)
      .filter((id) => id !== input.pluginId)
      .map((id) => `dependency entry ${id}`),
    ...bundles.filter((id) => id !== input.pluginId).map((id) => `enabled bundle ${id}`),
    'shared/transitive dependencies remain in the profile lock',
  ];

  const { [input.pluginId]: _removed, ...remainingDependencies } = dependencies;
  void _removed;
  const prunedDeclarationText = `${JSON.stringify(
    {
      ...declaration,
      dependencies: remainingDependencies,
      dsh: { ...dsh, profile: { ...profile, bundles: bundles.filter((id) => id !== input.pluginId) } },
    },
    null,
    2,
  )}\n`;

  return {
    ok: true,
    value: {
      removals,
      retention,
      blockingReferences,
      prunedDeclarationText,
      prunedWorkspaceText: input.workspaceText,
    },
  };
};
