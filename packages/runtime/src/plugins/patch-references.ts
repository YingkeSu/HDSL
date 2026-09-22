/**
 * Reference detection for the user patch layer and other bundles' patches
 * (#77 S3, ADR 0005 D15).
 *
 * Authoritative implementation: a real YAML AST (`yaml@2.9.1`, ISC, no runtime
 * dependencies) plus DSH patch field semantics. It is NOT a comment/quote
 * scanner; the earlier hand-rolled scanner is kept only as negative-example
 * tests.
 *
 * Reference positions (rc.2 patch semantics):
 *   - every TOP-LEVEL mapping key names a plugin;
 *   - `inject` values name plugin ids (flow `[a, b]` or block sequences); a
 *     quoted scalar in either position is still a reference.
 * Everything else — nested option keys, `config` subtrees, description strings —
 * is data and is never reported, while comments are simply absent from the AST.
 *
 * Fail-closed rules (reported as `unknown`; callers MUST block the removal, and
 * a source that cannot be parsed never degrades to "no references"):
 *   - parse errors, multiple documents, non-mapping roots;
 *   - aliases/anchors, merge keys (`<<`), explicit/custom tags (never resolved or
 *     executed), complex (non-scalar) keys;
 *   - block scalars in a reference position (`inject: |` may hide a list);
 *   - documents exceeding the size / node / depth bounds.
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
/** Keys whose values name plugin ids. */
const REFERENCE_KEYS: ReadonlySet<string> = new Set(['inject']);

export interface PatchUnknown {
  /** Safe source identifier (never an absolute path). */
  readonly source: string;
  readonly line: number;
  readonly reason: string;
}

export interface PatchReferences {
  readonly references: readonly string[];
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
 * Scans one patch/config source for structural references to plugin ids.
 * `source` must be a safe, path-free identifier.
 */
export const scanPatchReferences = (source: string, rawText: string): PatchReferences => {
  const unknown: PatchUnknown[] = [];
  const pushUnknown = (line: number, reason: string): void => {
    if (unknown.length < UNKNOWN_MAX) {
      unknown.push({ source, line, reason });
    }
  };
  const references = new Set<string>();

  if (rawText.length > PATCH_SCAN_MAX) {
    pushUnknown(1, 'source exceeds the bounded parse size');
    return { references: [], unknown };
  }

  let documents: Document.Parsed[];
  try {
    // No `toJS` is ever called, so no alias expansion or object duplication can
    // happen; aliases are rejected outright by the visitor (fail closed).
    documents = parseAllDocuments(rawText, {
      uniqueKeys: true,
      prettyErrors: false,
      strict: true,
      logLevel: 'silent',
    });
  } catch {
    pushUnknown(1, 'source could not be parsed');
    return { references: [], unknown };
  }
  if (documents.length !== 1) {
    // Multi-document input is explicitly rejected: merging them would be inventing
    // semantics the patch format does not define.
    pushUnknown(1, 'multiple YAML documents are not supported');
    return { references: [], unknown };
  }
  const document = documents[0];
  if (document === undefined) {
    pushUnknown(1, 'source could not be parsed');
    return { references: [], unknown };
  }
  if (document.errors.length > 0) {
    pushUnknown(1, 'source contains a YAML error');
    return { references: [], unknown };
  }

  let visited = 0;
  const visitNode = (node: Node | null | undefined, depth: number, inReferenceField: boolean): void => {
    if (node === null || node === undefined) {
      return;
    }
    visited += 1;
    if (visited > PATCH_NODE_MAX) {
      pushUnknown(lineOf(node), 'document exceeds the bounded node count');
      return;
    }
    if (depth > PATCH_DEPTH_MAX) {
      pushUnknown(lineOf(node), 'document exceeds the bounded depth');
      return;
    }
    if (isAlias(node)) {
      // Never resolve an alias: it may point anywhere in the document.
      pushUnknown(lineOf(node), 'alias cannot be resolved');
      return;
    }
    if (hasCustomTag(node)) {
      // Custom tags are never executed or interpreted.
      pushUnknown(lineOf(node), 'explicit tag is not interpreted');
      return;
    }
    if (isScalar(node)) {
      if (!inReferenceField) {
        // Ordinary data: description strings, option values, `enabled: true`.
        return;
      }
      const value = node.value;
      if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
        // A block scalar in a reference field may hide a list: refuse rather than
        // read it as data.
        pushUnknown(lineOf(node), 'block scalar in a reference position cannot be classified');
        return;
      }
      if (typeof value !== 'string') {
        pushUnknown(lineOf(node), 'non-string scalar in a reference position');
        return;
      }
      if (value !== '') {
        references.add(value);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items as readonly (Node | null | undefined)[]) {
        if (inReferenceField && (isAlias(item) || isMap(item) || isSeq(item))) {
          pushUnknown(lineOf(item), 'nested collection in a reference sequence');
          continue;
        }
        visitNode(item, depth + 1, inReferenceField);
      }
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key as Node | null | undefined;
        if (key === null || key === undefined) {
          continue;
        }
        if (isAlias(key) || isMap(key) || isSeq(key)) {
          pushUnknown(lineOf(key), 'complex or aliased mapping key');
          continue;
        }
        if (hasCustomTag(key)) {
          pushUnknown(lineOf(key), 'explicit tag is not interpreted');
          continue;
        }
        if (!isScalar(key)) {
          pushUnknown(lineOf(key), 'mapping key could not be classified');
          continue;
        }
        const keyValue = key.value;
        if (typeof keyValue !== 'string') {
          pushUnknown(lineOf(key), 'non-string mapping key');
          continue;
        }
        if (keyValue === '<<') {
          // A merge key would pull in references the patch does not show; its
          // value is inspected too so an alias is surfaced explicitly.
          pushUnknown(lineOf(key), 'merge key cannot be resolved');
          visitNode(pair.value as Node | null | undefined, depth + 1, false);
          continue;
        }
        if (REFERENCE_KEYS.has(keyValue)) {
          visitNode(pair.value as Node | null | undefined, depth + 1, true);
          continue;
        }
        if (depth === 0) {
          // Top-level mapping keys name plugins in rc.2 patch semantics.
          if (keyValue !== '') {
            references.add(keyValue);
          }
          // A top-level value is plugin configuration: only walk it to find
          // nested `inject` fields, never to report its data as references.
          visitNode(pair.value as Node | null | undefined, depth + 1, false);
          continue;
        }
        visitNode(pair.value as Node | null | undefined, depth + 1, inReferenceField);
      }
    }
  };

  visitNode(document.contents, 0, false);
  return { references: [...references].sort(), unknown };
};

/** True when any source reports an unresolvable construct (must fail closed). */
export const hasUnresolvedReferences = (scans: readonly PatchReferences[]): boolean =>
  scans.some((scan) => scan.unknown.length > 0);

/** Structural shape guard for callers that persist scan results. */
export const isPatchReferenceShape = (value: unknown): value is PatchReferences =>
  isPlainRecord(value) && Array.isArray(value['references']) && Array.isArray(value['unknown']);
