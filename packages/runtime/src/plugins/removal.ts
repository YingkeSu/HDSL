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
import { reconcileProfileBundles } from './profile-bundles.js';

/** Maximum packages inspected in the managed install's `@deepseek-ai` scope. */
const IN_BOX_SCAN_MAX = 1_000;
/** Maximum reference sources scanned for the removed plugin id. */
const REFERENCE_SOURCES_MAX = 64;

/** Field bound shared with the frozen `ChangePlan.blockingReferences.detail`. */
export const REFERENCE_DETAIL_MAX = 256;

/**
 * A safe reference-source label: bounded, never a LOCAL ABSOLUTE path (scoped
 * package names like `@scope/name` and relative labels like
 * `home/cordis.patch.yml` are safe identifiers, not local paths).
 */
export const isSafeDetail = (value: string): boolean =>
  value.length > 0 &&
  value.length <= REFERENCE_DETAIL_MAX &&
  !value.startsWith('/') &&
  !value.startsWith('~') &&
  !value.includes('\\') &&
  !/^[A-Za-z]:[\\/]/.test(value);

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

/**
 * A scanned reference source. `references`/`unresolved` come from the structural
 * scanner (`scanPatchReferences`); token matching against raw text is NOT used as
 * semantic proof, so an unparsable construct can only ever be *more* blocking.
 */
export interface PluginReferenceSource {
  readonly kind: 'bundle' | 'config' | 'userPatch';
  /** Bounded, non-absolute description shown to the operator. */
  readonly detail: string;
  /** Plugin package names this source references (`insert[].name`, row `name`). */
  readonly references: readonly string[];
  /** Row ids this source overrides (`- id: X`): config-level references. */
  readonly rowTargets?: readonly string[];
  /** Row ids this source INSERTS (`insert[].id`): duplicate-row breakage source. */
  readonly rowIds?: readonly string[];
  /** Cordis service names this source injects (informational, never packages). */
  readonly services?: readonly string[];
  /** True when the scanner could not classify the source (must fail closed). */
  readonly unresolved: boolean;
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
  /** Row ids introduced by the removed plugin's own patch rows. */
  readonly removedRowIds?: readonly string[];
  /** Service names appearing in the removed plugin's own patch rows (informational). */
  readonly removedServiceNames?: readonly string[];
  /**
   * HDSL service-verification status for the removed plugin (ADR 0005 D21).
   * The `known`/`unknown` gate was superseded by #112: this is now an
   * INFORMATIONAL input, never a `blockingReferences` source. `known` +
   * `provides: []` is a verified-empty set; `unknown` (missing declaration,
   * unverified or digest mismatch) is reported as a risk item and does NOT block.
   */
  readonly serviceVerification?:
    | { readonly status: 'known'; readonly provides: readonly string[] }
    | { readonly status: 'unknown' };
}

export interface PluginRemovalResolution {
  readonly removals: readonly string[];
  readonly retention: readonly string[];
  readonly blockingReferences: readonly ChangeBlockingReference[];
  /**
   * True when the target is an in-box bundle of the CURRENT managed DSH install
   * (F12a). Core maps this to `BUILTIN_BUNDLE_PROTECTED` (a fail, not a plan)
   * without string-matching the reference detail.
   */
  readonly isBuiltin: boolean;
  /**
   * Honest risk statements. Always includes the service-coupling limitation: the
   * absence of a static reference never proves the removal is safe. Service
   * verification is reported here as information, never as a blocker (superseded
   * by #112: `unknown` is not danger).
   */
  readonly riskItems: readonly string[];
  /** Declaration without the direct dependency entry and bundle reference. */
  readonly prunedDeclarationText: string;
  readonly prunedWorkspaceText: string | null;
}

export type PluginRemovalOutcome =
  | { readonly ok: true; readonly value: PluginRemovalResolution }
  | { readonly ok: false; readonly code: 'NOT_FOUND' | 'BUILTIN_BUNDLE_PROTECTED' | 'REFERENCED_BY_OTHER' | 'INTERNAL_ERROR'; readonly message: string };

/** Bounds an informational risk string to the frozen contract limit (256). */
const boundRisk = (value: string): string => (value.length <= 256 ? value : value.slice(0, 256));

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
    const detail = isSafeDetail(source.detail) ? source.detail : `unresolvable ${source.kind} reference source`;
    if (source.references.includes(input.pluginId)) {
      blockingReferences.push({ pluginId: input.pluginId, kind: source.kind, detail });
      continue;
    }
    const removedRowIds = input.removedRowIds ?? [];
    if (removedRowIds.length > 0 && (source.rowTargets ?? []).some((id) => removedRowIds.includes(id))) {
      blockingReferences.push({
        pluginId: input.pluginId,
        kind: source.kind,
        detail: `${detail} overrides a row this plugin inserts`,
      });
      continue;
    }
    if (removedRowIds.length > 0 && (source.rowIds ?? []).some((id) => removedRowIds.includes(id))) {
      // Another layer re-inserts the same row id ("last write winning"): removing
      // this plugin's rows changes that layer's resolution.
      blockingReferences.push({
        pluginId: input.pluginId,
        kind: source.kind,
        detail: `${detail} inserts the same row id as this plugin`,
      });
      continue;
    }
    if (source.unresolved) {
      // Fail closed: an unclassified construct may be a dynamic/alias reference.
      blockingReferences.push({
        pluginId: input.pluginId,
        kind: source.kind,
        detail: `${detail} contains a construct that cannot be resolved`,
      });
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

  const SERVICE_COUPLING_LIMITATION =
    'service-level coupling (another layer injecting a Cordis service provided by the removed plugin) is not decidable from patch files; no static reference does not prove the removal is free of impact';
  const injectedElsewhere = new Map<string, PluginReferenceSource>();
  for (const source of input.referenceSources) {
    for (const service of source.services ?? []) {
      if (!injectedElsewhere.has(service)) {
        injectedElsewhere.set(service, source);
      }
    }
  }
  // Service verification is INFORMATIONAL, never a removal gate. The old
  // `known`/`unknown` blocking policy (ADR 0005 D21) was superseded by #112:
  // HDSL is a launcher/version manager, does not promise impact analysis, and a
  // missing/unverified review record no longer means "forbid removal" (unknown
  // is not danger). The verified provider set, when present, is still reported
  // as an observed retained-consumer fact; it does not block.
  const verification = input.serviceVerification ?? { status: 'unknown' as const };
  const informationalServiceNotes: string[] = [];
  if (verification.status === 'known') {
    for (const provided of verification.provides) {
      const consumer = injectedElsewhere.get(provided);
      if (consumer !== undefined) {
        const detail = isSafeDetail(consumer.detail) ? consumer.detail : `unresolvable ${consumer.kind} reference source`;
        informationalServiceNotes.push(
          boundRisk(`informational: ${detail} consumes the Cordis service "${provided}" this plugin provides (not a removal blocker)`),
        );
      }
    }
  } else {
    informationalServiceNotes.push(
      'informational: service dependencies for this plugin are not verified by an HDSL review record (unknown is not a removal blocker; policy superseded by #112)',
    );
  }

  const serviceOverlap = (input.removedServiceNames ?? []).filter((service) => injectedElsewhere.has(service));
  const riskItems: string[] = [SERVICE_COUPLING_LIMITATION, ...informationalServiceNotes];
  if (serviceOverlap.length > 0) {
    riskItems.push(
      `informational: service name(s) also referenced by other patch layers: ${serviceOverlap.slice(0, 8).join(', ')} (not a blocking reference)`,
    );
  }

  const { [input.pluginId]: _removed, ...remainingDependencies } = dependencies;
  void _removed;
  // Bundle pruning goes through the same reconcile baseline as install. Only the
  // explicit removal target leaves the layer; unrelated (template/non-string)
  // entries are preserved verbatim rather than dropped as a side effect.
  const prunedBundles = reconcileProfileBundles({
    currentBundles: bundles.filter((entry): entry is string => typeof entry === 'string'),
    dependencies: [],
    removed: [input.pluginId],
  });
  const exitedBundles = new Set(prunedBundles.exited);
  const nextBundles = bundles.filter((entry) => typeof entry !== 'string' || !exitedBundles.has(entry));
  const prunedDeclarationText = `${JSON.stringify(
    {
      ...declaration,
      dependencies: remainingDependencies,
      dsh: { ...dsh, profile: { ...profile, bundles: nextBundles } },
    },
    null,
    2,
  )}\n`;

  return {
    ok: true,
    value: {
      removals,
      retention,
      riskItems,
      blockingReferences,
      isBuiltin: inBox !== undefined,
      prunedDeclarationText,
      prunedWorkspaceText: input.workspaceText,
    },
  };
};
