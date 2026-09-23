/**
 * `dsh.profile.bundles` reconciliation baseline (#115, B1).
 *
 * Upstream `dsh plugin --profile <n> add|remove` forwards the package operation
 * to pnpm and, on success, reconciles the profile's `dsh.profile.bundles`: a
 * dependency whose package declares `dsh.bundle.patch` enters the bundle layer;
 * a package that is removed (or loses its declaration) exits it; bundle entries
 * that are not profile dependencies (the template's in-box bundles) are left
 * untouched (see #111 §2/§6, R005).
 *
 * HDSL keeps its own managed transaction (staged generation + pointer commit,
 * default-deny executor) and treats this rule as the reconciliation BASELINE, so
 * the bundle layer is derived from evidence instead of assumption. This module
 * is pure: it never reads the filesystem, spawns a process or loads plugin code.
 *
 * Fail-open on UNKNOWN, deliberately (policy superseded by #112): when a
 * dependency's bundle declaration cannot be read, its entry is left exactly as it
 * is and reported as `unresolved`. An unreadable declaration is never turned
 * into `unknown => forbid`, and it is never guessed into or out of the layer.
 */
import { isPlainRecord } from '@hdsl/contracts';

/** One profile dependency and its observed bundle declaration. */
export interface BundleDeclarationInput {
  readonly name: string;
  /**
   * `true`  — the package manifest declares a bundle (`dsh.bundle.patch`);
   * `false` — the parsed manifest has no bundle declaration;
   * `null`  — the declaration could not be read/parsed (unknown, fail-open).
   */
  readonly declaresBundle: boolean | null;
}

export interface ProfileBundleReconciliation {
  /** The reconciled bundle list, preserving the original entry order. */
  readonly bundles: readonly string[];
  /** Dependencies that entered the bundle layer. */
  readonly entered: readonly string[];
  /** Dependencies/packages that left the bundle layer. */
  readonly exited: readonly string[];
  /** Declarations that could not be read; entries are left untouched. */
  readonly unresolved: readonly string[];
}

/**
 * Reads the bundle declaration of a parsed package manifest.
 *
 * `true`/`false` are EVIDENCE from the parsed manifest; `null` is UNKNOWN (the
 * manifest is not an object, or `dsh`/`dsh.bundle`/`dsh.bundle.patch` is present
 * but malformed). Absence of the fields is a parsed `false`, never `null`.
 */
export const declaresBundle = (manifest: unknown): boolean | null => {
  if (!isPlainRecord(manifest)) {
    return null;
  }
  const dsh = manifest['dsh'];
  if (dsh === undefined) {
    return false;
  }
  if (!isPlainRecord(dsh)) {
    return null;
  }
  const bundle = dsh['bundle'];
  if (bundle === undefined) {
    return false;
  }
  if (!isPlainRecord(bundle)) {
    return null;
  }
  const patch = bundle['patch'];
  if (patch === undefined) {
    return false;
  }
  return typeof patch === 'string' && patch !== '' ? true : null;
};

/** Contract cap for one `ChangePlan.riskItems` entry (each item max 256). */
export const RISK_ITEM_MAX_LENGTH = 256;

/**
 * The risk statement for a bundle declaration that could not be read. Callers
 * MUST surface this (plan `riskItems`) instead of dropping `unresolved`: an
 * unreadable declaration leaves the entry untouched, which is NOT the same as
 * "the bundle layer was reconciled".
 */
export const unresolvedBundleRisk = (name: string): string => {
  const statement = `the bundle declaration of ${name} could not be read (dsh.bundle.patch is not a non-empty string); its dsh.profile.bundles entry was left unchanged, not silently reconciled`;
  return statement.length <= RISK_ITEM_MAX_LENGTH
    ? statement
    : `${statement.slice(0, RISK_ITEM_MAX_LENGTH - 1)}…`;
};

/**
 * Reconciles a profile's bundle layer from the current declaration and the
 * observed dependency declarations. It never invents an entry for an unknown
 * declaration and never drops an entry it cannot classify.
 *
 * @param input.removed packages known to leave the layer regardless of the
 *   declaration evidence (the explicit removal target); they exit even when the
 *   dependency has already been pruned from `dependencies`.
 */
export const reconcileProfileBundles = (input: {
  readonly currentBundles: readonly string[];
  readonly dependencies: readonly BundleDeclarationInput[];
  readonly removed?: readonly string[];
}): ProfileBundleReconciliation => {
  const removed = new Set(input.removed ?? []);
  const declarations = new Map<string, boolean | null>();
  for (const dependency of input.dependencies) {
    declarations.set(dependency.name, dependency.declaresBundle);
  }

  const exited: string[] = [];
  const unresolved: string[] = [];
  const kept: string[] = [];
  for (const entry of input.currentBundles) {
    if (removed.has(entry)) {
      exited.push(entry);
      continue;
    }
    const declaration = declarations.get(entry);
    if (declaration === false) {
      // A profile dependency that lost its bundle declaration leaves the layer.
      exited.push(entry);
      continue;
    }
    if (declaration === null) {
      unresolved.push(entry);
    }
    kept.push(entry);
  }

  const present = new Set(kept);
  const entered: string[] = [];
  for (const dependency of input.dependencies) {
    if (removed.has(dependency.name) || present.has(dependency.name)) {
      continue;
    }
    if (dependency.declaresBundle === true) {
      entered.push(dependency.name);
      present.add(dependency.name);
    } else if (dependency.declaresBundle === null) {
      unresolved.push(dependency.name);
    }
  }

  return {
    bundles: [...kept, ...entered],
    entered,
    exited,
    unresolved: [...new Set(unresolved)],
  };
};
