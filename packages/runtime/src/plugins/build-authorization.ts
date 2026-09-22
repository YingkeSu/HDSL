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
import { readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isPlainRecord, type BuildAuthorization, type BuildScriptEntry, type ScriptAssessment } from '@hdsl/contracts';
import { resolveLockClosure } from './lock-closure.js';

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

interface InstalledManifest {
  readonly name: string;
  readonly version: string;
  readonly scripts: Record<string, unknown>;
}

/** Package directories in a `node_modules`-like dir (handles `@scope/name`). */
const packageDirsIn = (nodeModulesDirectory: string): readonly string[] => {
  const result: string[] = [];
  let names: string[];
  try {
    names = readdirSync(nodeModulesDirectory);
  } catch {
    return result;
  }
  for (const name of names) {
    if (name.startsWith('.')) {
      continue; // .bin, .pnpm, .modules.yaml
    }
    const entry = join(nodeModulesDirectory, name);
    if (name.startsWith('@')) {
      let scoped: string[];
      try {
        scoped = readdirSync(entry);
      } catch {
        continue;
      }
      for (const child of scoped) {
        if (!child.startsWith('.')) {
          result.push(join(entry, child));
        }
      }
      continue;
    }
    result.push(entry);
  }
  return result;
};

/**
 * Collects the manifests of a materialised pnpm tree: the top-level links AND
 * the `.pnpm` virtual store (where transitive dependencies live). Directories are
 * deduplicated by REAL path, so a top-level symlink and its store target are one
 * package. Returns `undefined` when the bounded scan is exceeded (fail closed).
 */
const collectInstalledManifests = (
  nodeModulesDirectory: string,
  readPackageJsonText: (path: string) => string | undefined,
): readonly InstalledManifest[] | undefined => {
  const directories = new Set<string>();
  let nodeModulesReal: string;
  try {
    nodeModulesReal = realpathSync(nodeModulesDirectory);
  } catch {
    nodeModulesReal = nodeModulesDirectory;
  }
  const escapes = (candidate: string): boolean => {
    const rel = relative(nodeModulesReal, candidate);
    return rel !== '' && (rel.startsWith('..') || isAbsolute(rel));
  };
  let escaped = false;
  const addDirectory = (directory: string): void => {
    let real = directory;
    try {
      real = realpathSync(directory);
    } catch {
      // Keep the raw path; the manifest read below will fail closed.
    }
    if (escapes(real)) {
      escaped = true;
      return;
    }
    directories.add(real);
  };
  for (const directory of packageDirsIn(nodeModulesDirectory)) {
    addDirectory(directory);
  }
  const virtualStore = join(nodeModulesDirectory, '.pnpm');
  let storeEntries: string[];
  try {
    storeEntries = readdirSync(virtualStore);
  } catch {
    storeEntries = [];
  }
  for (const storeEntry of storeEntries) {
    if (storeEntry.startsWith('.')) {
      continue;
    }
    for (const directory of packageDirsIn(join(virtualStore, storeEntry, 'node_modules'))) {
      addDirectory(directory);
    }
  }
  if (directories.size > INSTALLED_SCAN_MAX) {
    return undefined;
  }
  if (escaped) {
    // A symlink target outside the materialised tree is an unsupported shape.
    return undefined;
  }
  const manifests: InstalledManifest[] = [];
  for (const directory of directories) {
    const text = readPackageJsonText(join(directory, 'package.json'));
    if (text === undefined) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = asRecord(JSON.parse(text)) ?? {};
    } catch {
      continue;
    }
    const name = typeof parsed['name'] === 'string' ? parsed['name'] : undefined;
    const version = typeof parsed['version'] === 'string' ? parsed['version'] : undefined;
    if (name === undefined || version === undefined) {
      continue;
    }
    manifests.push({ name, version, scripts: asRecord(parsed['scripts']) ?? {} });
  }
  return manifests;
};

/**
 * Pinned-lock-guided, non-executing enumeration of install-time scripts from a
 * materialised `node_modules` tree (produced by a default-deny install).
 *
 * The authority is the REACHABLE `packages`/`snapshots` identity set of the
 * plan-bound fully-pinned lock (root importer closure), not a directory walk:
 * every reachable identity must resolve to a manifest addressable from the
 * materialised tree (top-level link or the `.pnpm` virtual store), with an exact
 * identity count per `(name, version)` (no silent merge of peer/git identities).
 * A missing/duplicate/unreadable manifest, an escaping symlink target, an
 * uninterpretable lock or an unsupported shape is `undefined` (the caller keeps
 * `unknown`, never authorizable). The source package's own hooks are excluded
 * (they are `root` entries from the source manifest). NEVER runs a script.
 */
export const enumerateInstallScriptsFromInstalledTree = (input: {
  readonly nodeModulesDirectory: string;
  /** The plan-bound, fully-pinned lock that defines the authoritative package set. */
  readonly lockText: string;
  /** Package name of the authorized source (its hooks are `root`, not `dependency`). */
  readonly excludePackageName: string;
  readonly readPackageJsonText: (path: string) => string | undefined;
}): readonly BuildScriptEntry[] | undefined => {
  // The REACHABLE closure of the root importer is the authoritative identity set.
  const closure = resolveLockClosure(input.lockText);
  if (closure.status !== 'ok' || closure.reachable.length === 0) {
    return undefined;
  }
  const identityVersion = new Map<string, string | undefined>();
  for (const identity of readLockedIdentities(input.lockText)) {
    identityVersion.set(identity.depPath, identity.version);
  }
  // Expected reachable (name, version) multiset. An identity whose version cannot
  // be established is an unsupported shape.
  const expectedCounts = new Map<string, number>();
  for (const depPath of closure.reachable) {
    const at = depPath.lastIndexOf('@');
    if (at <= 0) {
      return undefined;
    }
    const name = depPath.slice(0, at);
    const version = identityVersion.get(depPath);
    if (version === undefined) {
      return undefined; // cannot bind the identity to a concrete package
    }
    const key = `${name}\u0000${version}`;
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const manifests = collectInstalledManifests(input.nodeModulesDirectory, input.readPackageJsonText);
  if (manifests === undefined) {
    return undefined;
  }
  const manifestsByKey = new Map<string, InstalledManifest[]>();
  for (const manifest of manifests) {
    const key = `${manifest.name}\u0000${manifest.version}`;
    const existing = manifestsByKey.get(key);
    if (existing === undefined) {
      manifestsByKey.set(key, [manifest]);
    } else {
      existing.push(manifest);
    }
  }
  // Exact count per identity key: a missing package, or a name-only merge of two
  // distinct (peer/git) identities, fails closed.
  for (const [key, expected] of expectedCounts) {
    const found = manifestsByKey.get(key)?.length ?? 0;
    if (found !== expected) {
      return undefined;
    }
  }
  const entries: BuildScriptEntry[] = [];
  for (const [key, group] of manifestsByKey) {
    if (!expectedCounts.has(key)) {
      continue; // an unreachable/extra manifest is not authorized here
    }
    for (const manifest of group) {
      if (manifest.name === input.excludePackageName) {
        continue;
      }
      for (const script of BUILD_LIFECYCLE_SCRIPTS) {
        if (typeof manifest.scripts[script] === 'string') {
          entries.push({ packageName: manifest.name, packageVersion: manifest.version, script, source: 'dependency' });
        }
      }
    }
  }
  return entries;
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

/** Build-permission config keys that must never be inherited into a materialisation. */
export const BUILD_PERMISSION_CONFIG_KEYS = [
  'allowBuilds',
  'onlyBuiltDependencies',
  'dangerouslyAllowAllBuilds',
  'neverBuiltDependencies',
  'ignoredBuiltDependencies',
] as const;

/**
 * Removes every build-permission key from a workspace config so a historical
 * `allowBuilds`/`onlyBuiltDependencies`/`dangerouslyAllowAllBuilds` can never be
 * inherited into the default-deny materialisation. Unparsable YAML is a refusal
 * (the caller keeps the source `unknown`) rather than a silent pass-through.
 */
export const stripBuildPermissionConfig = (
  workspaceText: string | null,
): { readonly ok: true; readonly text: string | null } | { readonly ok: false } => {
  if (workspaceText === null) {
    return { ok: true, text: null };
  }
  let parsed: unknown;
  try {
    parsed = parse(workspaceText, { uniqueKeys: true, logLevel: 'silent' });
  } catch {
    return { ok: false };
  }
  const record = asRecord(parsed);
  if (record === undefined) {
    return { ok: false };
  }
  let changed = false;
  for (const key of BUILD_PERMISSION_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      delete record[key];
      changed = true;
    }
  }
  const pnpm = asRecord(record['pnpm']);
  if (pnpm !== undefined) {
    for (const key of ['allowBuilds', 'onlyBuiltDependencies', 'dangerouslyAllowAllBuilds'] as const) {
      if (Object.prototype.hasOwnProperty.call(pnpm, key)) {
        delete pnpm[key];
        changed = true;
      }
    }
  }
  return { ok: true, text: changed ? stringify(record) : workspaceText };
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
