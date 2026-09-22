/**
 * Reference detection for the user patch layer and other bundles' patches
 * (#77 S3, ADR 0005 D15).
 *
 * There is **no YAML parser dependency** in this repository, and adding one is a
 * workspace/root configuration change, so this module is deliberately a
 * *conservative structural scanner*, not comment stripping:
 *
 * - It classifies each line into a small, explicit node vocabulary (mapping key,
 *   sequence item, flow sequence, block-scalar header/body, comment/blank) and
 *   only reports references from **rc.2 patch reference positions**: mapping keys
 *   and `inject` values. Quoted scalars in those positions ARE references
 *   (`inject: ["plugin-name"]` counts); quoting never makes a reference
 *   disappear, and comments never create one.
 * - Everything it cannot classify as either a reference position or clearly
 *   non-referential data — anchors, aliases, merge keys, explicit tags, nested
 *   flow collections, tabs, multi-document markers, complex keys — is reported as
 *   **unknown**, and callers must FAIL CLOSED (block the removal) instead of
 *   assuming "no reference".
 *
 * Sources are passed in as safe identifiers (for example `user patch` or
 * `bundle @deepseek-ai/dsh-web-app`); no local absolute path is ever emitted.
 */
import { isPlainRecord } from '@hdsl/contracts';

/** Maximum characters scanned per source. */
export const PATCH_SCAN_MAX = 256 * 1024;
/** Maximum unknown constructs reported per source. */
const UNKNOWN_MAX = 32;

/** Keys whose (sequence or flow) values are plugin id references. */
const REFERENCE_KEYS: ReadonlySet<string> = new Set(['inject', 'dependencies', 'plugins']);

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

const unquote = (raw: string): string | undefined => {
  const value = raw.trim();
  if (value.length === 0) {
    return undefined;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last === first && value.length >= 2) {
    // A quoted scalar in a reference position is still a reference.
    return value.slice(1, -1);
  }
  if (first === '"' || first === "'") {
    // Unterminated quote: cannot classify.
    return undefined;
  }
  return value;
};

const UNSUPPORTED = /^(?:---|\.\.\.)\s*$|(?:^|[\s:[{,])[&*!]/;

const splitFlowSequence = (value: string): string[] | undefined => {
  if (!value.startsWith('[') || !value.endsWith(']')) {
    return undefined;
  }
  const inner = value.slice(1, -1).trim();
  if (inner === '') {
    return [];
  }
  return inner.split(',').map((entry) => entry.trim());
};

/**
 * Scans one patch/config source for structural references to plugin ids.
 * `source` must be a safe, path-free identifier.
 */
export const scanPatchReferences = (source: string, rawText: string): PatchReferences => {
  const text = rawText.length > PATCH_SCAN_MAX ? rawText.slice(0, PATCH_SCAN_MAX) : rawText;
  const references = new Set<string>();
  const unknown: PatchUnknown[] = [];
  const lines = text.split('\n');

  let blockScalarIndent: number | null = null;
  let injectIndent: number | null = null;

  const indentOf = (line: string): number => line.length - line.trimStart().length;

  /** Removes a trailing comment from a plain scalar (outside quotes only). */
  const stripTrailingComment = (value: string): string => {
    let quote: string | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index] ?? '';
      if (quote !== null) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '#' && (index === 0 || /\s/.test(value[index - 1] ?? ''))) {
        return value.slice(0, index).trim();
      }
    }
    return value.trim();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const lineNumber = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const indent = indentOf(raw);
    if (raw.slice(0, indent).includes('\t')) {
      unknown.push({ source, line: lineNumber, reason: 'tab indentation cannot be classified' });
      continue;
    }
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) {
        continue;
      }
      blockScalarIndent = null;
    }
    if (injectIndent !== null && indent <= injectIndent && !trimmed.startsWith('- ')) {
      injectIndent = null;
    }

    let unresolvable = false;
    if (UNSUPPORTED.test(trimmed)) {
      unknown.push({ source, line: lineNumber, reason: 'anchor, alias, tag or document marker' });
      unresolvable = true;
    }

    // Sequence item: a reference only under `inject`, config data otherwise.
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      const item = trimmed === '-' ? '' : trimmed.slice(2).trim();
      if (injectIndent !== null) {
        const value = unquote(stripTrailingComment(item));
        if (value === undefined) {
          unknown.push({ source, line: lineNumber, reason: 'unterminated quoted inject item' });
        } else if (value !== '') {
          references.add(value);
        }
      }
      continue;
    }

    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      if (!unresolvable) {
        unknown.push({ source, line: lineNumber, reason: 'line is neither a mapping entry nor a sequence item' });
      }
      continue;
    }
    const key = unquote(trimmed.slice(0, colon).trim());
    if (key === undefined || key === '') {
      if (!unresolvable) {
        unknown.push({ source, line: lineNumber, reason: 'unclassifiable mapping key' });
      }
      continue;
    }
    const value = stripTrailingComment(trimmed.slice(colon + 1));
    if (key === '<<') {
      unknown.push({ source, line: lineNumber, reason: 'merge key cannot be resolved' });
      continue;
    }
    if (REFERENCE_KEYS.has(key)) {
      const flow = splitFlowSequence(value);
      if (value === '') {
        injectIndent = indent;
        continue;
      }
      if (flow === undefined) {
        unknown.push({ source, line: lineNumber, reason: `${key} value is not a resolvable sequence` });
        continue;
      }
      for (const entry of flow) {
        const item = unquote(entry);
        if (item === undefined) {
          unknown.push({ source, line: lineNumber, reason: `unresolvable entry under ${key}` });
        } else if (item !== '') {
          references.add(item);
        }
      }
      continue;
    }
    // rc.2 patch semantics: only TOP-LEVEL (indent 0) mapping keys name plugins;
    // nested keys are plugin configuration, never references.
    if (value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) {
      // Block scalar header at ANY indent: its body is literal data.
      blockScalarIndent = indent;
    }
    if (indent === 0) {
      references.add(key);
    }
  }

  return { references: [...references].sort(), unknown: unknown.slice(0, UNKNOWN_MAX) };
};

/** True when any source reports an unresolvable construct (must fail closed). */
export const hasUnresolvedReferences = (scans: readonly PatchReferences[]): boolean =>
  scans.some((scan) => scan.unknown.length > 0);

/** Convenience for tests/tools: structural shape guard used by callers. */
export const isPatchReferenceShape = (value: unknown): value is PatchReferences =>
  isPlainRecord(value) && Array.isArray(value['references']) && Array.isArray(value['unknown']);
