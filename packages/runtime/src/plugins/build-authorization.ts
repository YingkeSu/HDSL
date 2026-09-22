/**
 * S4 explicit build authorization (ADR 0005 D7/D14/D20, #78).
 *
 * Default deny is the norm: a plugin install runs `pnpm install --ignore-scripts`
 * and executes NO third-party lifecycle script. An explicit authorization may
 * widen this ONLY for an exact, enumerated, plan-bound set:
 *
 * - `commitSha` must equal the re-resolved source commit;
 * - `scripts` must EQUAL (set equality, never subset/prefix/wildcard) the
 *   install-time script set the runtime enumerated;
 * - the dependency closure must be FULLY enumerated (a source with any
 *   dependency this slice cannot enumerate is never authorizable);
 * - every authorized package must map to EXACTLY ONE identity in the plan-bound
 *   fully-pinned lock; that lock key IS pnpm's `allowBuilds` depPath (verified on
 *   the frozen managed pnpm 11.7.0: the sentinel's `pnpm-lock.yaml` key and the
 *   working `allowBuilds` key are byte-identical, e.g.
 *   `name@git+file://<path>#<sha>`). A name-only or wildcard key is never used.
 *
 * This module is pure: the caller materializes the returned `depPaths` into the
 * staged profile's `pnpm-workspace.yaml` for a SINGLE install and MUST clear it
 * before the profile is published (see `apply-port.ts`), so the authorization can
 * never become a resident allowlist.
 */
import { parse, stringify } from 'yaml';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainRecord, type BuildAuthorization, type BuildScriptEntry, type ScriptAssessment } from '@hdsl/contracts';

/** Lifecycle hooks HDSL enumerates (frozen order). */
export const BUILD_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

/** Frozen error codes reused by the authorization decision (no new code). */
export type BuildAuthorizationRejection = 'BUILD_NOT_AUTHORIZED' | 'AUTHORIZATION_MISMATCH';

export type BuildAuthorizationDecision =
  | { readonly ok: true; readonly mode: 'deny' }
  | { readonly ok: true; readonly mode: 'allow'; readonly depPaths: readonly string[] }
  /** Authorization present but the closure must be enumerated first (apply-time). */
  | { readonly ok: true; readonly mode: 'enumerate' }
  | { readonly ok: false; readonly code: BuildAuthorizationRejection; readonly message: string };

/** Exact, order-independent identity of one authorized script entry. */
export const buildScriptKey = (entry: BuildScriptEntry): string =>
  `${entry.source}\u0000${entry.packageName}\u0000${entry.packageVersion}\u0000${entry.script}`;

/**
 * Strict set equality. Duplicates in either list make the sets unequal, so a
 * padded/duplicated authorization never passes.
 */
export const sameBuildScriptSet = (
  left: readonly BuildScriptEntry[],
  right: readonly BuildScriptEntry[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const rightKeys = new Set(right.map(buildScriptKey));
  if (rightKeys.size !== right.length) {
    return false;
  }
  const leftKeys = new Set(left.map(buildScriptKey));
  if (leftKeys.size !== left.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!rightKeys.has(key)) {
      return false;
    }
  }
  return true;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isPlainRecord(value) ? value : undefined;

/** Maximum dependency package directories inspected (bounded, non-executing). */
const INSTALLED_SCAN_MAX = 4_000;

/**
 * Non-executing enumeration of install-time scripts from a materialised
 * `node_modules` tree (produced by a default-deny install). It reads each
 * dependency's `package.json` and NEVER runs a script. The authorized source's
 * own package is excluded so its hooks are not double-counted (they are already
 * reported as `source: 'root'` from the source manifest).
 */
export const enumerateInstallScriptsFromInstalledTree = (input: {
  readonly nodeModulesDirectory: string;
  /** Package name of the authorized source (excluded: counted as `root`). */
  readonly excludePackageName: string;
  readonly readPackageJsonText: (path: string) => string | undefined;
}): readonly BuildScriptEntry[] => {
  const collected: BuildScriptEntry[] = [];
  const pending: string[] = [input.nodeModulesDirectory];
  let inspected = 0;
  while (pending.length > 0 && inspected < INSTALLED_SCAN_MAX) {
    const directory = pending.shift()!;
    let names: string[];
    try {
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        continue;
      }
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === '.bin' || name === '.pnpm') {
        continue;
      }
      const entry = join(directory, name);
      let isDirectory = false;
      try {
        isDirectory = statSync(entry).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) {
        continue;
      }
      if (name.startsWith('@')) {
        pending.push(entry);
        continue;
      }
      inspected += 1;
      const manifestText = input.readPackageJsonText(join(entry, 'package.json'));
      if (manifestText === undefined) {
        continue;
      }
      let manifest: Record<string, unknown>;
      try {
        manifest = asRecord(JSON.parse(manifestText)) ?? {};
      } catch {
        continue;
      }
      const packageName = typeof manifest['name'] === 'string' ? manifest['name'] : name;
      if (packageName === input.excludePackageName) {
        continue;
      }
      const packageVersion = typeof manifest['version'] === 'string' ? manifest['version'] : '0.0.0';
      const scripts = asRecord(manifest['scripts']) ?? {};
      for (const script of BUILD_LIFECYCLE_SCRIPTS) {
        if (typeof scripts[script] === 'string') {
          collected.push({ packageName, packageVersion, script, source: 'dependency' });
        }
      }
    }
  }
  return collected;
};

export interface LockedIdentity {
  /** The exact pnpm depPath / lock key (`<name>@<resolved>`). */
  readonly depPath: string;
  readonly name: string;
  readonly version: string | undefined;
}

/** Reads the `packages`/`snapshots` identities of a fully-pinned pnpm lock. */
export const readLockedIdentities = (lockText: string): readonly LockedIdentity[] => {
  let parsed: unknown;
  try {
    parsed = parse(lockText, { uniqueKeys: true, logLevel: 'silent' });
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  if (root === undefined) {
    return [];
  }
  const seen = new Map<string, LockedIdentity>();
  for (const section of ['packages', 'snapshots', 'importers']) {
    const group = asRecord(root[section]);
    if (group === undefined) {
      continue;
    }
    for (const [depPath, value] of Object.entries(group)) {
      if (section === 'importers') {
        continue;
      }
      const entry = asRecord(value);
      const version = entry !== undefined && typeof entry['version'] === 'string' ? entry['version'] : undefined;
      const at = depPath.lastIndexOf('@');
      const name = at > 0 ? depPath.slice(0, at) : depPath;
      if (!seen.has(depPath)) {
        seen.set(depPath, { depPath, name, version });
      }
    }
  }
  return [...seen.values()];
};

/**
 * Binds each authorized package to EXACTLY ONE pinned-lock identity. Zero or
 * multiple matches are a refusal; the returned keys are used verbatim as the
 * pnpm `allowBuilds` depPaths.
 */
export const bindAuthorizedScriptsToLock = (
  lockText: string,
  scripts: readonly BuildScriptEntry[],
): { readonly ok: true; readonly depPaths: readonly string[] } | { readonly ok: false; readonly message: string } => {
  const identities = readLockedIdentities(lockText);
  const depPaths = new Set<string>();
  for (const script of scripts) {
    const matches = identities.filter(
      (identity) => identity.name === script.packageName && identity.version === script.packageVersion,
    );
    if (matches.length === 0) {
      return {
        ok: false,
        message: `the authorized package ${script.packageName}@${script.packageVersion} is not present in the plan-bound lock`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `the authorized package ${script.packageName}@${script.packageVersion} is ambiguous in the plan-bound lock`,
      };
    }
    depPaths.add(matches[0]!.depPath);
  }
  return { ok: true, depPaths: [...depPaths].sort() };
};

export interface BuildAuthorizationInput {
  readonly authorization: BuildAuthorization | null;
  /** The re-resolved source commit (never the client's value). */
  readonly commitSha: string;
  readonly scriptAssessment: ScriptAssessment;
  /** The install-time scripts the runtime enumerated for this source. */
  readonly scripts: readonly BuildScriptEntry[];
  /**
   * True only when the install-time script set covers the WHOLE dependency
   * closure. A source with an un-enumerated closure is never authorizable.
   */
  readonly closureEnumerated: boolean;
  /** The plan-bound, fully-pinned lock; `null` when none was resolved. */
  readonly lockText: string | null;
}

/**
 * The single authorization decision, evaluated BEFORE any write or executor run.
 * Anything not explicitly and exactly authorized stays default-deny.
 */
export const decideBuildAuthorization = (input: BuildAuthorizationInput): BuildAuthorizationDecision => {
  const { authorization } = input;
  if (authorization === null) {
    return input.scriptAssessment === 'none-detected' && input.scripts.length === 0
      ? { ok: true, mode: 'deny' }
      : {
          ok: false,
          code: 'BUILD_NOT_AUTHORIZED',
          message:
            'install-time scripts are refused by default; provide an explicit authorization that exactly matches the enumerated script set (S4)',
        };
  }
  if (authorization.commitSha !== input.commitSha) {
    return {
      ok: false,
      code: 'AUTHORIZATION_MISMATCH',
      message: 'the authorization is not bound to the re-resolved commit',
    };
  }
  if (!input.closureEnumerated) {
    // An authorization is present but the closure is not yet enumerated. The
    // apply boundary enumerates it (default-deny materialisation read-only) and
    // re-decides; the preview/CI pure path never allows without enumeration.
    return { ok: true, mode: 'enumerate' };
  }
  if (!sameBuildScriptSet(authorization.scripts, input.scripts)) {
    return {
      ok: false,
      code: 'AUTHORIZATION_MISMATCH',
      message: 'the authorization does not exactly match the enumerated install-time script set',
    };
  }
  if (authorization.scripts.length === 0) {
    return { ok: true, mode: 'deny' };
  }
  if (input.lockText === null) {
    return {
      ok: false,
      code: 'BUILD_NOT_AUTHORIZED',
      message: 'no fully pinned lockfile is available to bind the authorized packages',
    };
  }
  const bound = bindAuthorizedScriptsToLock(input.lockText, authorization.scripts);
  if (!bound.ok) {
    return { ok: false, code: 'AUTHORIZATION_MISMATCH', message: bound.message };
  }
  return { ok: true, mode: 'allow', depPaths: bound.depPaths };
};

/**
 * Merges an exact `allowBuilds` map into the workspace config for ONE install.
 * Refuses to combine with any pre-existing broad policy
 * (`dangerouslyAllowAllBuilds`, or a non-empty `allowBuilds`/`onlyBuiltDependencies`)
 * so an existing wider switch can never be silently reused.
 */
export const composeAuthorizedWorkspace = (
  workspaceText: string | null,
  depPaths: readonly string[],
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string } => {
  let document: Record<string, unknown> = {};
  if (workspaceText !== null) {
    let parsed: unknown;
    try {
      parsed = parse(workspaceText, { uniqueKeys: true, logLevel: 'silent' });
    } catch {
      return { ok: false, message: 'the workspace config is not valid YAML' };
    }
    document = asRecord(parsed) ?? {};
  }
  if (document['dangerouslyAllowAllBuilds'] === true || document['dangerouslyAllowAllBuilds'] !== undefined) {
    return { ok: false, message: 'the workspace config already carries a broad build policy' };
  }
  const existing = document['allowBuilds'];
  if (existing !== undefined && (!isPlainRecord(existing) || Object.keys(existing).length > 0)) {
    return { ok: false, message: 'the workspace config already carries an allowBuilds map' };
  }
  const existingOnly = document['onlyBuiltDependencies'];
  if (existingOnly !== undefined && (!Array.isArray(existingOnly) || existingOnly.length > 0)) {
    return { ok: false, message: 'the workspace config already carries an onlyBuiltDependencies list' };
  }
  const allowBuilds: Record<string, boolean> = {};
  for (const depPath of [...depPaths].sort()) {
    allowBuilds[depPath] = true;
  }
  return { ok: true, text: stringify({ ...document, allowBuilds }) };
};
