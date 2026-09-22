/**
 * pnpm 11.7.0 lockfile reachability for #77 S3 retention.
 *
 * The root importer's dependency lists are only the DIRECT set. Whether a removed
 * plugin is still legitimately retained must be decided by its exact package
 * identity inside the **reachable closure** of the pruned lock: start from the
 * target profile importer and follow the resolved edges recorded in `snapshots`
 * (falling back to `packages`), never by package-name string matching and never by
 * treating every `packages` entry as reachable.
 *
 * Unsupported shapes are reported as `unsupported` so callers fail closed (a
 * removal is never presented as complete when the lock cannot be interpreted).
 */
import { parse } from 'yaml';
import { isPlainRecord } from '@hdsl/contracts';

/** Maximum lock bytes parsed. */
export const LOCK_SCAN_MAX = 8 * 1024 * 1024;
/** Maximum resolved package identities visited. */
const CLOSURE_MAX = 20_000;

export interface LockClosure {
  readonly status: 'ok';
  /** Direct dependency names of the root importer (NOT the full retention set). */
  readonly direct: readonly string[];
  /** Exact resolved identities (`<name>@<resolved>`) reachable from the importer. */
  readonly reachable: readonly string[];
}

export type LockClosureOutcome =
  | LockClosure
  | { readonly status: 'unsupported'; readonly reason: string };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isPlainRecord(value) ? value : undefined;

/** Snapshot/package maps keyed by `<name>@<resolved>`; dependencies of each key. */
const collectInstances = (
  node: unknown,
): { readonly edges: Map<string, string[]>; readonly keys: Set<string> } => {
  const edges = new Map<string, string[]>();
  const keys = new Set<string>();
  const record = asRecord(node);
  if (record === undefined) {
    return { edges, keys };
  }
  for (const [key, value] of Object.entries(record)) {
    keys.add(key);
    const entry = asRecord(value);
    const deps: string[] = [];
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const group = entry === undefined ? undefined : asRecord(entry[section]);
      if (group === undefined) {
        continue;
      }
      for (const [name, version] of Object.entries(group)) {
        if (typeof version === 'string') {
          deps.push(`${name}@${version}`);
        }
      }
    }
    edges.set(key, deps);
  }
  return { edges, keys };
};

/**
 * Computes the reachable closure from the root importer of a pnpm v9 lock.
 * The target identity is matched by EXACT resolved identity, so a git dependency
 * is `name@<tarball-url>` (which embeds the commit), not `name@<version>`.
 */
export const resolveLockClosure = (lockText: string): LockClosureOutcome => {
  if (lockText.length > LOCK_SCAN_MAX) {
    return { status: 'unsupported', reason: 'the lock exceeds the bounded parse size' };
  }
  let parsed: unknown;
  try {
    parsed = parse(lockText, { uniqueKeys: true, logLevel: 'silent' });
  } catch {
    return { status: 'unsupported', reason: 'the lock could not be parsed' };
  }
  const root = asRecord(parsed);
  const importers = root === undefined ? undefined : asRecord(root['importers']);
  const importer = importers === undefined ? undefined : asRecord(importers['.']);
  if (importer === undefined) {
    return { status: 'unsupported', reason: 'the lock has no root importer' };
  }
  const snapshots = collectInstances(root?.['snapshots']);
  const packages = collectInstances(root?.['packages']);
  const edges = new Map<string, string[]>([...packages.edges, ...snapshots.edges]);
  const known = new Set<string>([...packages.keys, ...snapshots.keys]);

  const direct: string[] = [];
  const seeds: string[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const group = asRecord(importer[section]);
    if (group === undefined) {
      continue;
    }
    for (const [name, value] of Object.entries(group)) {
      direct.push(name);
      const entry = asRecord(value);
      const resolved = entry === undefined ? undefined : entry['version'];
      if (typeof resolved !== 'string' || resolved === '') {
        return { status: 'unsupported', reason: `the importer entry ${name} has no resolved version` };
      }
      seeds.push(`${name}@${resolved}`);
    }
  }

  // A root importer with no dependencies has an EMPTY reachable closure. This is
  // the legitimate state after the last direct dependency is pruned (pnpm then
  // emits no `packages`/`snapshots` sections at all), and must NOT be reported as
  // an uninterpretable lock — otherwise a complete removal fails closed.
  if (seeds.length === 0) {
    return { status: 'ok', direct: [], reachable: [] };
  }
  if (known.size === 0) {
    return { status: 'unsupported', reason: 'the lock exposes neither packages nor snapshots' };
  }

  const isLocalEdge = (value: string): boolean =>
    value.includes('link:') || value.includes('workspace:') || value.includes('file:');

  // A reachable local edge cannot be silently skipped: the target could be
  // referenced through it, so the closure would be incomplete. Only verifiable
  // semantics (resolving the edge to an importer we can keep traversing) would be
  // supported; that is out of scope here, so it fails closed.
  for (const seed of seeds) {
    if (isLocalEdge(seed)) {
      return { status: 'unsupported', reason: 'the root importer has a local dependency edge that cannot be resolved' };
    }
  }

  const reachable = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const identity = queue.shift();
    if (identity === undefined) {
      break;
    }
    if (reachable.has(identity)) {
      continue;
    }
    reachable.add(identity);
    if (reachable.size > CLOSURE_MAX) {
      return { status: 'unsupported', reason: 'the lock closure exceeds the bounded size' };
    }
    for (const edge of edges.get(identity) ?? []) {
      if (isLocalEdge(edge)) {
        // Reachable local edge: fail closed rather than report a complete closure.
        return { status: 'unsupported', reason: 'a reachable local dependency edge cannot be resolved in this lock shape' };
      }
      queue.push(edge);
    }
  }
  return { status: 'ok', direct: [...new Set(direct)].sort(), reachable: [...reachable].sort() };
};

export interface TargetRetention {
  readonly status: 'ok';
  /** The target identity is still reachable through retained dependencies. */
  readonly retained: boolean;
  readonly direct: readonly string[];
  readonly reachable: readonly string[];
}

/**
 * Decides whether `targetIdentity` (`<name>@<resolved>` with the exact recorded
 * resolution, e.g. the codeload tarball URL for a git source) is still part of the
 * pruned lock's reachable closure.
 */
export const targetRetentionInLock = (
  lockText: string,
  targetIdentity: string,
): TargetRetention | { readonly status: 'unsupported'; readonly reason: string } => {
  const closure = resolveLockClosure(lockText);
  if (closure.status !== 'ok') {
    return closure;
  }
  return {
    status: 'ok',
    retained: closure.reachable.includes(targetIdentity),
    direct: closure.direct,
    reachable: closure.reachable,
  };
};
