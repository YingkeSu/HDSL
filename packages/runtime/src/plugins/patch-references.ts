/**
 * Reference detection for the user patch layer and other bundles' patches
 * (#77 S3, ADR 0005 D15).
 *
 * Authoritative implementation: a real YAML AST (`yaml@2.9.1`, ISC, no runtime
 * dependencies) plus the **actual rc.2 Cordis patch schema**, verified against
 * the managed install's own patches (`@deepseek-ai/dsh-base`,
 * `dsh-web-app`, `dsh-headless`, `dsh-sdk-*`, `dsh-acp-app`):
 *
 * ```yaml
 * - insert:                      # new rows (plugin package = `name`)
 *     - id: timer                # row identity (NOT a package)
 *       name: '@deepseek-ai/cordis-plugin-timer'
 *       disabled: true
 *       config: { ... }
 * - id: system-prompt            # override of an existing row by id
 *   config: { ... }              # replaces that row's whole config
 * ```
 *
 * Consequences for reference detection:
 *   - a **package reference** is a row's `name` scalar (top-level row names and
 *     `insert` row names); quoted scalars count exactly like plain ones;
 *   - `id` is a profile-local row identity, never a package name; an override
 *     entry (`- id: X`) *targets* row X, which is a config-level reference used
 *     by the caller to detect "removing this plugin's rows breaks another layer";
 *   - `inject` lists Cordis **services** (`webStartup`, `loader`, `acpAppStartup`,
 *     …), not packages, so it never counts as a plugin reference;
 *   - `config` subtrees, `disabled`/`enabled`, descriptions and any nested `name`
 *     inside `config` are data.
 *
 * Fail-closed rules (reported as `unknown`; callers MUST block the removal, and a
 * source that cannot be parsed never degrades to "no references"): parse errors,
 * multiple documents, non-sequence/non-mapping roots, `insert` values that are not
 * sequences of mapping rows, rows without a scalar `id`, non-string `name`, row
 * entries that are not mappings, aliases/anchors, merge keys, explicit tags
 * (never interpreted), complex (non-scalar) keys, block scalars in `name`/`insert`
 * positions, and size / node / depth bounds.
 *
 * Sources are safe identifiers (`user patch`, `bundle @scope/name`); no local
 * absolute path is ever emitted.
 */
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Node,
} from 'yaml';
import { isPlainRecord } from '@hdsl/contracts';

/** Maximum characters parsed per source. */
export const PATCH_SCAN_MAX = 256 * 1024;
/** Maximum AST nodes visited per source. */
export const PATCH_NODE_MAX = 20_000;
/** Maximum nesting depth visited per source. */
export const PATCH_DEPTH_MAX = 64;
/** Maximum unknown constructs reported per source. */
const UNKNOWN_MAX = 32;

export interface PatchUnknown {
  /** Safe source identifier (never an absolute path). */
  readonly source: string;
  readonly line: number;
  readonly reason: string;
}

export interface PatchReferences {
  /** Plugin package names referenced by patch rows (`insert[].name`, row `name`). */
  readonly references: readonly string[];
  /** Row ids this source INSERTS (its own rows). */
  readonly rowIds: readonly string[];
  /** Row ids this source OVERRIDES (`- id: X`), i.e. config-level references. */
  readonly rowTargets: readonly string[];
  readonly unknown: readonly PatchUnknown[];
}

const lineOf = (node: Node | null | undefined): number => {
  const range = node?.range;
  return typeof range?.[0] === 'number' ? range[0] + 1 : 1;
};

const hasCustomTag = (node: Node): boolean => {
  const tag = (node as { tag?: string }).tag;
  return typeof tag === 'string' && !tag.startsWith('tag:yaml.org,2002:');
};

/**
 * Scans one patch source for package references and row targets.
 * `source` must be a safe, path-free identifier.
 */
export const scanPatchReferences = (source: string, rawText: string): PatchReferences => {
  const unknown: PatchUnknown[] = [];
  const references = new Set<string>();
  const rowIds = new Set<string>();
  const rowTargets = new Set<string>();
  const pushUnknown = (line: number, reason: string): void => {
    if (unknown.length < UNKNOWN_MAX) {
      unknown.push({ source, line, reason });
    }
  };
  const result = (): PatchReferences => ({
    references: [...references].sort(),
    rowIds: [...rowIds].sort(),
    rowTargets: [...rowTargets].sort(),
    unknown,
  });

  if (rawText.length > PATCH_SCAN_MAX) {
    pushUnknown(1, 'source exceeds the bounded parse size');
    return result();
  }

  let documents: Document.Parsed[];
  try {
    documents = parseAllDocuments(rawText, {
      uniqueKeys: true,
      prettyErrors: false,
      strict: true,
      logLevel: 'silent',
    });
  } catch {
    pushUnknown(1, 'source could not be parsed');
    return result();
  }
  if (documents.length !== 1) {
    pushUnknown(1, 'multiple YAML documents are not supported');
    return result();
  }
  const document = documents[0];
  if (document === undefined || document.errors.length > 0) {
    pushUnknown(1, 'source contains a YAML error');
    return result();
  }

  let visited = 0;
  let overflowed = false;

  /** Reads a scalar string value; flags aliases/tags/blocks/complex nodes. */
  const scalarAt = (node: Node | null | undefined, depth: number, position: string): string | undefined => {
    if (node === null || node === undefined) {
      return undefined;
    }
    if (isAlias(node)) {
      pushUnknown(lineOf(node), `alias in ${position} cannot be resolved`);
      return undefined;
    }
    if (hasCustomTag(node)) {
      pushUnknown(lineOf(node), `explicit tag in ${position} is not interpreted`);
      return undefined;
    }
    if (!isScalar(node)) {
      pushUnknown(lineOf(node), `${position} is not a scalar`);
      return undefined;
    }
    if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
      pushUnknown(lineOf(node), `block scalar in ${position} cannot be classified`);
      return undefined;
    }
    void depth;
    const value = node.value;
    if (typeof value !== 'string') {
      pushUnknown(lineOf(node), `non-string scalar in ${position}`);
      return undefined;
    }
    return value;
  };

  /** Visits one patch row (an `insert` item or a top-level entry). */
  const visitRow = (row: Node | null | undefined, depth: number, inserted: boolean): void => {
    if (overflowed || row === null || row === undefined) {
      return;
    }
    visited += 1;
    if (visited > PATCH_NODE_MAX) {
      pushUnknown(lineOf(row), 'document exceeds the bounded node count');
      overflowed = true;
      return;
    }
    if (depth > PATCH_DEPTH_MAX) {
      pushUnknown(lineOf(row), 'document exceeds the bounded depth');
      overflowed = true;
      return;
    }
    if (isAlias(row)) {
      pushUnknown(lineOf(row), 'alias row cannot be resolved');
      return;
    }
    if (hasCustomTag(row)) {
      pushUnknown(lineOf(row), 'explicit tag is not interpreted');
      return;
    }
    if (!isMap(row)) {
      pushUnknown(lineOf(row), 'patch entry is not a mapping');
      return;
    }
    for (const pair of row.items) {
      const key = pair.key as Node | null | undefined;
      const keyValue = scalarAt(key, depth, 'patch entry key');
      if (keyValue === undefined) {
        continue;
      }
      if (keyValue === '<<') {
        pushUnknown(lineOf(key), 'merge key cannot be resolved');
        continue;
      }
      if (keyValue === 'id') {
        const id = scalarAt(pair.value as Node | null | undefined, depth + 1, 'row id');
        if (id !== undefined && id !== '') {
          if (inserted) {
            rowIds.add(id);
          } else {
            rowTargets.add(id);
          }
        }
        continue;
      }
      if (keyValue === 'name') {
        const name = scalarAt(pair.value as Node | null | undefined, depth + 1, 'row name');
        if (name !== undefined && name !== '') {
          references.add(name);
        }
        continue;
      }
      if (keyValue === 'insert') {
        const value = pair.value as Node | null | undefined;
        if (value !== null && value !== undefined && isAlias(value)) {
          pushUnknown(lineOf(value), 'alias insert list cannot be resolved');
          continue;
        }
        if (value !== null && value !== undefined && hasCustomTag(value)) {
          pushUnknown(lineOf(value), 'explicit tag is not interpreted');
          continue;
        }
        if (!isSeq(value)) {
          pushUnknown(lineOf(value ?? key), 'insert value is not a sequence of rows');
          continue;
        }
        for (const item of value.items as readonly (Node | null | undefined)[]) {
          visitRow(item, depth + 1, true);
        }
        continue;
      }
      // `config`, `disabled`, `inject`, … are data (or service names, never
      // packages): walk only to surface unresolvable constructs.
      walkForUnresolved(pair.value as Node | null | undefined, depth + 1);
    }
  };

  /** Recursively flags aliases/tags/complex keys anywhere in a data subtree. */
  const walkForUnresolved = (node: Node | null | undefined, depth: number): void => {
    if (node === null || node === undefined || overflowed) {
      return;
    }
    visited += 1;
    if (visited > PATCH_NODE_MAX) {
      pushUnknown(lineOf(node), 'document exceeds the bounded node count');
      overflowed = true;
      return;
    }
    if (depth > PATCH_DEPTH_MAX) {
      pushUnknown(lineOf(node), 'document exceeds the bounded depth');
      overflowed = true;
      return;
    }
    if (isAlias(node)) {
      pushUnknown(lineOf(node), 'alias cannot be resolved');
      return;
    }
    if (hasCustomTag(node)) {
      pushUnknown(lineOf(node), 'explicit tag is not interpreted');
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items as readonly (Node | null | undefined)[]) {
        walkForUnresolved(item, depth + 1);
      }
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key as Node | null | undefined;
        if (key !== null && key !== undefined && !isScalar(key)) {
          pushUnknown(lineOf(key), 'complex mapping key');
        } else if (key !== null && key !== undefined && isScalar(key) && key.value === '<<') {
          pushUnknown(lineOf(key), 'merge key cannot be resolved');
        }
        walkForUnresolved(pair.value as Node | null | undefined, depth + 1);
      }
    }
  };

  const contents = document.contents as Node | null | undefined;
  if (contents === null || contents === undefined) {
    return result();
  }
  if (isAlias(contents) || hasCustomTag(contents)) {
    pushUnknown(lineOf(contents), 'patch root cannot be resolved');
    return result();
  }
  if (isSeq(contents)) {
    for (const item of contents.items as readonly (Node | null | undefined)[]) {
      visitRow(item, 0, false);
    }
    return result();
  }
  if (isMap(contents)) {
    // A mapping root is accepted as a single implicit row (older/user form), but
    // its data subtrees are still checked for unresolvable constructs.
    visitRow(contents, 0, false);
    return result();
  }
  pushUnknown(lineOf(contents), 'patch root is neither a sequence nor a mapping');
  return result();
};

/** True when any source reports an unresolvable construct (must fail closed). */
export const hasUnresolvedReferences = (scans: readonly PatchReferences[]): boolean =>
  scans.some((scan) => scan.unknown.length > 0);

/** Structural shape guard for callers that persist scan results. */
export const isPatchReferenceShape = (value: unknown): value is PatchReferences =>
  isPlainRecord(value) &&
  Array.isArray(value['references']) &&
  Array.isArray(value['rowIds']) &&
  Array.isArray(value['rowTargets']) &&
  Array.isArray(value['unknown']);
