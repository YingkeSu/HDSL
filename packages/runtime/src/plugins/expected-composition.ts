/**
 * Read-only EXPECTED composition: managed `dsh --profile <p> --dump-config`
 * invocation and grouped-YAML parsing (issue #118).
 *
 * `dsh --profile <p> --dump-config` prints a **grouped** stream: each section
 * starts with a `# == <label>` comment followed by top-level sequence rows. It
 * is NOT one logical document and it contains `!!js` expressions that
 * `--dump-config` preserves **verbatim without evaluating** (E9, the dump <->
 * runtime-loaded-set equivalence, is NOT established). The parser therefore:
 *
 * - splits on the `# ==` section headers and parses each section as its own
 *   bounded YAML document (a header-less preamble or a section that is not a
 *   sequence becomes an explicit diagnostic, never a silent drop);
 * - extracts `(id, name, disabled, config?)` rows and keeps `!!js`, anchors and
 *   merge keys as **unevaluated data** (never executed, never resolved);
 * - reports every parse failure as an explicit diagnostic.
 *
 * The view this feeds is always named the desired/expected composition and is
 * never the runtime ACTIVE plugin set. The invocation runs the managed Node and
 * DSH entrypoint offline with an isolated HOME/DSH_HOME and no credential
 * variables; it only reads the documented dump and never writes desired config,
 * entries, packages or versions.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node } from 'yaml';
import {
  portFail,
  portOk,
  type ExpectedCompositionDiagnostic,
  type ExpectedCompositionGroup,
  type ExpectedCompositionRow,
  type PortOutcome,
} from '@hdsl/contracts';
import { runCommand } from '../install/run-command.js';

/** Maximum characters of a single dump parsed per view. */
export const EXPECTED_DUMP_MAX = 512 * 1024;
/** Maximum AST nodes visited while scanning one section's data subtrees. */
export const EXPECTED_NODE_MAX = 40_000;
/** Maximum nesting depth visited while scanning one section. */
export const EXPECTED_DEPTH_MAX = 64;
/** Maximum rows kept across all sections. */
export const EXPECTED_ROWS_MAX = 5_000;
/** Maximum `# ==` sections kept. */
export const EXPECTED_GROUPS_MAX = 512;
/** Maximum diagnostics reported per view. */
export const EXPECTED_DIAGNOSTICS_MAX = 64;
/** Maximum verbatim characters kept for one row's config subtree. */
export const EXPECTED_CONFIG_MAX = 4_096;

const GROUP_HEADER = /^#\s*==\s*(.+?)\s*$/;

/** Managed path entries, matching the process manager's isolated PATH. */
const MANAGED_PATH_ENTRIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

/** Verbatim config subtree of one row; `!!js` text is preserved, not run. */
export interface ExpectedCompositionConfigText {
  readonly text: string;
  readonly truncated: boolean;
  readonly unevaluated: boolean;
}

export interface ExpectedCompositionParsedDump {
  readonly groups: readonly ExpectedCompositionGroup[];
  readonly diagnostics: readonly ExpectedCompositionDiagnostic[];
  readonly rowCount: number;
}

type DiagnosticCode = ExpectedCompositionDiagnostic['code'];

interface MutableParseState {
  readonly diagnostics: ExpectedCompositionDiagnostic[];
  rows: number;
  /** The diagnostics buffer saturated; detail entries were dropped. */
  diagnosticsTruncated: boolean;
  /** A row, group or the dump itself was dropped; the view is incomplete. */
  viewTruncated: boolean;
  /** Message for the guaranteed `truncated` diagnostic (first cause wins). */
  truncationMessage: string | null;
}

const hasTruncationDiagnostic = (state: MutableParseState): boolean =>
  state.diagnostics.some((diagnostic) => diagnostic.code === 'truncated');

/**
 * Pushes one diagnostic. Truncation is a hard postcondition: whenever anything
 * is dropped (a diagnostic itself, a row or a group) a `truncated` entry is
 * guaranteed to survive even if the detail buffer is saturated. One slot is
 * always reserved for it, and `ensureTruncationDiagnostic` back-fills at the
 * end so the drop can never be silent (spec/contracts §3.6).
 */
const pushDiagnostic = (
  state: MutableParseState,
  code: DiagnosticCode,
  message: string,
  groupLabel: string | null,
  line: number | null,
): void => {
  const bounded = message.length > 500 ? `${message.slice(0, 499)}…` : message;
  if (code === 'truncated') {
    const reason = state.truncationMessage ?? bounded;
    state.truncationMessage = reason;
    state.viewTruncated = true;
    if (!hasTruncationDiagnostic(state) && state.diagnostics.length < EXPECTED_DIAGNOSTICS_MAX) {
      state.diagnostics.push({ code, message: reason, groupLabel, line });
    }
    return;
  }
  // Reserve one slot for the mandatory truncation diagnostic.
  if (state.diagnostics.length >= EXPECTED_DIAGNOSTICS_MAX - 1) {
    state.diagnosticsTruncated = true;
    state.truncationMessage ??= 'more diagnostics than the bounded view keeps';
    return;
  }
  state.diagnostics.push({ code, message: bounded, groupLabel, line });
};

/** Back-fills the mandatory `truncated` diagnostic when a detail dropped it. */
const ensureTruncationDiagnostic = (state: MutableParseState): void => {
  if ((!state.viewTruncated && !state.diagnosticsTruncated) || hasTruncationDiagnostic(state)) {
    return;
  }
  const message = state.truncationMessage ?? 'the composed view is incomplete';
  const diagnostic: ExpectedCompositionDiagnostic = {
    code: 'truncated',
    message: message.length > 500 ? `${message.slice(0, 499)}…` : message,
    groupLabel: null,
    line: null,
  };
  if (state.diagnostics.length < EXPECTED_DIAGNOSTICS_MAX) {
    state.diagnostics.push(diagnostic);
  } else {
    // Defensive: never exceed the schema bound, but never go silent either.
    state.diagnostics[state.diagnostics.length - 1] = diagnostic;
  }
};

/**
 * Tags the default YAML schema assigns to literal nodes. Any other resolved
 * tag (for example `!!js`, which the `!!` shorthand expands to
 * `tag:yaml.org,2002:js`) is an explicit, non-literal construct and must be
 * reported, never interpreted.
 */
const KNOWN_LITERAL_TAGS: ReadonlySet<string> = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:timestamp',
  'tag:yaml.org,2002:binary',
  'tag:yaml.org,2002:set',
  'tag:yaml.org,2002:omap',
  'tag:yaml.org,2002:pairs',
  'tag:yaml.org,2002:merge',
]);

const hasCustomTag = (node: Node): boolean => {
  const tag = (node as { tag?: string }).tag;
  return typeof tag === 'string' && !KNOWN_LITERAL_TAGS.has(tag);
};

const lineOf = (node: Node | null | undefined): number | null => {
  const range = node?.range;
  return typeof range?.[0] === 'number' ? range[0] + 1 : null;
};

const rangeText = (
  body: string,
  node: Node | null | undefined,
): { text: string; truncated: boolean } | null => {
  const range = node?.range;
  if (range === null || range === undefined || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
    return null;
  }
  const raw = body.slice(range[0], range[1]);
  return raw.length <= EXPECTED_CONFIG_MAX
    ? { text: raw, truncated: false }
    : { text: raw.slice(0, EXPECTED_CONFIG_MAX), truncated: true };
};

interface IdentityValue {
  readonly value: string | null;
  readonly known: boolean;
  readonly issue: string | null;
}

/** Reads a literal scalar identity without interpreting tags/aliases/blocks. */
const readIdentity = (node: Node | null | undefined, position: string): IdentityValue => {
  if (node === null || node === undefined) {
    return { value: null, known: false, issue: null };
  }
  if (isAlias(node)) {
    return { value: null, known: false, issue: `alias in ${position} is not resolved` };
  }
  if (hasCustomTag(node)) {
    return { value: null, known: false, issue: `explicit tag in ${position} is not interpreted` };
  }
  if (!isScalar(node)) {
    return { value: null, known: false, issue: `${position} is not a scalar` };
  }
  if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
    return { value: null, known: false, issue: `block scalar in ${position} is not a literal value` };
  }
  const value = node.value;
  if (typeof value !== 'string' || value === '') {
    return { value: null, known: false, issue: `${position} is not a non-empty string` };
  }
  return { value, known: true, issue: null };
};

interface DisabledValue {
  readonly value: boolean | null;
  readonly known: boolean;
  readonly issue: string | null;
}

const readDisabled = (node: Node | null | undefined): DisabledValue => {
  if (node === null || node === undefined) {
    return { value: null, known: false, issue: null };
  }
  if (isScalar(node) && !hasCustomTag(node) && typeof node.value === 'boolean') {
    return { value: node.value, known: true, issue: null };
  }
  return {
    value: null,
    known: false,
    issue: 'disabled value is not a literal boolean and is not evaluated',
  };
};

interface UnevaluatedScan {
  readonly unevaluated: boolean;
  readonly issues: readonly string[];
  readonly truncated: boolean;
}

/** Walks a data subtree without resolving aliases or executing any expression. */
const scanUnevaluated = (root: Node | null | undefined): UnevaluatedScan => {
  const issues: string[] = [];
  let visited = 0;
  let unevaluated = false;
  let truncated = false;

  const visit = (node: Node | null | undefined, depth: number): void => {
    if (node === null || node === undefined || truncated) {
      return;
    }
    visited += 1;
    if (visited > EXPECTED_NODE_MAX || depth > EXPECTED_DEPTH_MAX) {
      truncated = true;
      issues.push('config subtree exceeds the bounded scan');
      return;
    }
    if (isAlias(node)) {
      unevaluated = true;
      if (issues.length < 8) {
        issues.push('alias in config subtree is not resolved');
      }
      return;
    }
    if (hasCustomTag(node)) {
      unevaluated = true;
      if (issues.length < 8) {
        issues.push('explicit tag in config subtree is not interpreted');
      }
      // The tagged scalar is data; its children (none for scalars) are not
      // traversed, which is exactly "preserve, never evaluate".
      if (!isScalar(node) && (isMap(node) || isSeq(node))) {
        for (const child of childNodes(node)) {
          visit(child, depth + 1);
        }
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items as readonly (Node | null | undefined)[]) {
        visit(item, depth + 1);
      }
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key as Node | null | undefined;
        if (key !== null && key !== undefined && isScalar(key) && key.value === '<<') {
          unevaluated = true;
          if (issues.length < 8) {
            issues.push('merge key in config subtree is not resolved');
          }
        }
        if (key !== null && key !== undefined && !isScalar(key) && !isAlias(key)) {
          unevaluated = true;
          if (issues.length < 8) {
            issues.push('complex mapping key in config subtree is not resolved');
          }
        }
        visit(pair.value as Node | null | undefined, depth + 1);
      }
    }
  };

  visit(root, 0);
  return { unevaluated, issues, truncated };
};

const childNodes = (node: Node): readonly (Node | null | undefined)[] => {
  if (isSeq(node)) {
    return node.items as readonly (Node | null | undefined)[];
  }
  if (isMap(node)) {
    return node.items.map((pair) => pair.value as Node | null | undefined);
  }
  return [];
};

const readConfig = (
  body: string,
  node: Node | null | undefined,
  state: MutableParseState,
  groupLabel: string,
): ExpectedCompositionRow['config'] => {
  const range = rangeText(body, node);
  if (range === null) {
    // No source range: keep the row honest rather than fabricating config text.
    pushDiagnostic(state, 'unresolved-construct', 'config subtree has no source range', groupLabel, lineOf(node));
    return undefined;
  }
  const scan = scanUnevaluated(node);
  for (const issue of scan.issues) {
    pushDiagnostic(state, 'unresolved-construct', issue, groupLabel, lineOf(node));
  }
  return {
    text: range.text,
    truncated: range.truncated,
    unevaluated: scan.unevaluated,
  };
};

const readRow = (
  body: string,
  item: Node | null | undefined,
  state: MutableParseState,
  groupLabel: string,
): ExpectedCompositionRow | undefined => {
  if (item === null || item === undefined) {
    return undefined;
  }
  if (isAlias(item)) {
    pushDiagnostic(state, 'row-ignored', 'alias row is not resolved', groupLabel, lineOf(item));
    return undefined;
  }
  if (hasCustomTag(item)) {
    pushDiagnostic(state, 'row-ignored', 'explicit tag on row is not interpreted', groupLabel, lineOf(item));
    return undefined;
  }
  if (!isMap(item)) {
    pushDiagnostic(state, 'row-ignored', 'entry is not a mapping', groupLabel, lineOf(item));
    return undefined;
  }

  let id: string | null = null;
  let idKnown = false;
  let name: string | null = null;
  let nameKnown = false;
  let disabled: boolean | null = null;
  let disabledKnown = false;
  let config: ExpectedCompositionRow['config'];

  for (const pair of item.items) {
    const key = pair.key as Node | null | undefined;
    if (key === null || key === undefined || !isScalar(key) || typeof key.value !== 'string') {
      pushDiagnostic(state, 'row-ignored', 'row key is not a scalar', groupLabel, lineOf(key));
      continue;
    }
    if (key.value === '<<') {
      pushDiagnostic(state, 'unresolved-construct', 'merge key is not resolved', groupLabel, lineOf(key));
      continue;
    }
    if (key.value === 'id') {
      const read = readIdentity(pair.value as Node | null | undefined, 'id');
      id = read.value;
      idKnown = read.known;
      if (read.issue !== null) {
        pushDiagnostic(state, 'row-ignored', read.issue, groupLabel, lineOf(pair.value as Node));
      }
      continue;
    }
    if (key.value === 'name') {
      const read = readIdentity(pair.value as Node | null | undefined, 'name');
      name = read.value;
      nameKnown = read.known;
      if (read.issue !== null) {
        pushDiagnostic(state, 'unresolved-construct', read.issue, groupLabel, lineOf(pair.value as Node));
      }
      continue;
    }
    if (key.value === 'disabled') {
      const read = readDisabled(pair.value as Node | null | undefined);
      disabled = read.value;
      disabledKnown = read.known;
      if (read.issue !== null) {
        pushDiagnostic(state, 'unresolved-construct', read.issue, groupLabel, lineOf(pair.value as Node));
      }
      continue;
    }
    if (key.value === 'config') {
      config = readConfig(body, pair.value as Node | null | undefined, state, groupLabel);
    }
  }

  if (!idKnown) {
    pushDiagnostic(state, 'row-ignored', 'row has no literal id', groupLabel, lineOf(item));
    return undefined;
  }

  const row: ExpectedCompositionRow = {
    id,
    name,
    nameKnown,
    disabled,
    disabledKnown,
    ...(config === undefined ? {} : { config }),
  };
  return row;
};

/**
 * Parses one grouped `--dump-config` text into `(id, name, disabled, config?)`
 * rows. Malformed sections, malformed rows and unevaluated constructs become
 * explicit diagnostics; nothing is silently dropped.
 */
export const parseExpectedCompositionDump = (raw: string): ExpectedCompositionParsedDump => {
  const state: MutableParseState = {
    diagnostics: [],
    rows: 0,
    diagnosticsTruncated: false,
    viewTruncated: false,
    truncationMessage: null,
  };
  if (raw.length > EXPECTED_DUMP_MAX) {
    pushDiagnostic(state, 'truncated', 'dump exceeds the bounded parse size', null, 1);
    return { groups: [], diagnostics: state.diagnostics, rowCount: 0 };
  }

  const lines = raw.split('\n');
  const sections: { label: string; body: string; startLine: number }[] = [];
  let currentLabel: string | null = null;
  let currentBody: string[] = [];
  let currentStart = 0;
  let preamble: string[] = [];

  const flush = (): void => {
    if (currentLabel !== null) {
      sections.push({ label: currentLabel, body: currentBody.join('\n'), startLine: currentStart });
    }
    currentBody = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = GROUP_HEADER.exec(line);
    if (match !== null) {
      flush();
      currentLabel = (match[1] ?? '').trim() || 'unnamed section';
      currentStart = index + 2; // first body line is 1-based next line
      continue;
    }
    if (currentLabel === null) {
      preamble.push(line);
    } else {
      currentBody.push(line);
    }
  }
  flush();

  if (preamble.some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))) {
    pushDiagnostic(state, 'preamble-ignored', 'content before the first section header was ignored', null, 1);
  }

  const groups: ExpectedCompositionGroup[] = [];
  for (const section of sections) {
    if (groups.length >= EXPECTED_GROUPS_MAX) {
      pushDiagnostic(state, 'truncated', 'more sections than the bounded view keeps', null, section.startLine);
      break;
    }
    let body = section.body;
    const hasContent = body
      .split('\n')
      .some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
    if (!hasContent) {
      groups.push({ label: section.label.slice(0, 256), rows: [] });
      continue;
    }
    const parsed = parseSection(section.label, section.startLine, body, state);
    if (parsed === undefined) {
      groups.push({ label: section.label.slice(0, 256), rows: [] });
      continue;
    }
    body = parsed.source;
    const rows: ExpectedCompositionRow[] = [];
    for (const item of parsed.items) {
      if (state.rows >= EXPECTED_ROWS_MAX) {
        pushDiagnostic(state, 'truncated', 'more rows than the bounded view keeps', section.label, section.startLine);
        break;
      }
      const row = readRow(body, item, state, section.label);
      if (row !== undefined) {
        rows.push(row);
        state.rows += 1;
      }
    }
    groups.push({ label: section.label.slice(0, 256), rows });
    if (state.viewTruncated) {
      break;
    }
  }

  ensureTruncationDiagnostic(state);

  return { groups, diagnostics: state.diagnostics, rowCount: state.rows };
};

interface ParsedSection {
  readonly source: string;
  readonly items: readonly (Node | null | undefined)[];
}

const parseSection = (
  label: string,
  startLine: number,
  body: string,
  state: MutableParseState,
): ParsedSection | undefined => {
  let documents;
  try {
    documents = parseAllDocuments(body, {
      uniqueKeys: true,
      prettyErrors: false,
      strict: true,
      logLevel: 'silent',
    });
  } catch {
    pushDiagnostic(state, 'group-parse-failed', 'section could not be parsed', label, startLine);
    return undefined;
  }
  if (documents.length !== 1) {
    pushDiagnostic(state, 'group-parse-failed', 'section is not exactly one YAML document', label, startLine);
    return undefined;
  }
  const document = documents[0];
  if (document === undefined || document.errors.length > 0) {
    pushDiagnostic(state, 'group-parse-failed', 'section contains a YAML error', label, startLine);
    return undefined;
  }
  const contents = document.contents as Node | null | undefined;
  if (contents === null || contents === undefined) {
    return { source: body, items: [] };
  }
  if (!isSeq(contents)) {
    pushDiagnostic(state, 'group-parse-failed', 'section root is not a sequence', label, startLine);
    return undefined;
  }
  return { source: body, items: contents.items as readonly (Node | null | undefined)[] };
};

// ---------------------------------------------------------------------------
// Managed invocation
// ---------------------------------------------------------------------------

export interface ExpectedCompositionDumpRequest {
  /** Managed Node executable of the active generation. */
  readonly nodeExecutable: string;
  /** Managed DSH `lib/bin.js` entrypoint of the active generation. */
  readonly dshEntrypoint: string;
  /** Published managed profile name (`hdsl-<generationId>`). */
  readonly profileName: string;
  /** Environment-scoped DSH home (`$DSH_HOME`/`$HOME`). */
  readonly homeDirectory: string;
  /** Environment-scoped process cwd. */
  readonly cwd: string;
  /** Bounded child timeout. */
  readonly timeoutMs?: number;
}

export interface ExpectedCompositionDumpResult {
  readonly groups: readonly ExpectedCompositionGroup[];
  readonly diagnostics: readonly ExpectedCompositionDiagnostic[];
  readonly rowCount: number;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly observedAt: string;
}

export interface ExpectedCompositionPort {
  describeExpectedComposition(
    request: ExpectedCompositionDumpRequest,
    signal: AbortSignal,
  ): Promise<PortOutcome<ExpectedCompositionDumpResult>>;
}

export interface ExpectedCompositionPortOptions {
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_DUMP_TIMEOUT_MS = 60_000;

/** Bound on captured stdout/stderr, so a runaway dump cannot grow unbounded. */
const MAX_DUMP_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Managed `--dump-config` adapter. It runs the managed Node + DSH entrypoint in
 * an isolated HOME/DSH_HOME with no credential variables, captures stdout and
 * stderr, and parses the grouped stream. It never evaluates `!!js`, never runs
 * plugin code, never resolves aliases and never writes desired config, entries,
 * packages or versions. The managed child journal is disabled: this is a
 * read-only inspection, not an install/process owner.
 */
export const createExpectedCompositionPort = (
  options: ExpectedCompositionPortOptions = {},
): ExpectedCompositionPort => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DUMP_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  return {
    async describeExpectedComposition(
      request: ExpectedCompositionDumpRequest,
      signal: AbortSignal,
    ): Promise<PortOutcome<ExpectedCompositionDumpResult>> {
      if (
        typeof request.nodeExecutable !== 'string' ||
        request.nodeExecutable === '' ||
        request.nodeExecutable === process.execPath
      ) {
        return portFail('INTERNAL_ERROR', 'the generation has no usable managed Node executable');
      }
      if (!existsSync(request.nodeExecutable)) {
        return portFail('INTERNAL_ERROR', 'the managed Node executable does not exist');
      }
      if (typeof request.dshEntrypoint !== 'string' || !existsSync(request.dshEntrypoint)) {
        return portFail('INTERNAL_ERROR', 'the managed DSH entrypoint does not exist');
      }
      if (typeof request.profileName !== 'string' || request.profileName.trim() === '') {
        return portFail('INTERNAL_ERROR', 'the generation has no profile name');
      }

      const nodeBin = dirname(request.nodeExecutable);
      const temporaryDirectory = join(request.homeDirectory, '.tmp');
      try {
        mkdirSync(temporaryDirectory, { recursive: true });
      } catch {
        return portFail('INTERNAL_ERROR', 'the isolated temporary directory could not be prepared');
      }
      // Nothing is inherited from the host: HOME/DSH_HOME/TMPDIR/PATH are the
      // managed mapping and no credential variable is ever added.
      const environment: Record<string, string> = {
        HOME: request.homeDirectory,
        DSH_HOME: request.homeDirectory,
        DSH_AGENTS_HOME: join(request.homeDirectory, 'agents'),
        PATH: [nodeBin, ...MANAGED_PATH_ENTRIES].join(':'),
        TMPDIR: temporaryDirectory,
        DSH_TELEMETRY_DISABLED: '1',
        NODE_NO_WARNINGS: '1',
      };

      try {
        const run = await runCommand(
          request.nodeExecutable,
          [request.dshEntrypoint, '--profile', request.profileName, '--dump-config'],
          {
            cwd: request.cwd,
            env: environment,
            timeoutMs: request.timeoutMs ?? timeoutMs,
            signal,
            maxOutputBytes: MAX_DUMP_OUTPUT_BYTES,
            journalProcess: false,
          },
        );
        const parsed = parseExpectedCompositionDump(run.stdout);
        return portOk({
          groups: parsed.groups,
          diagnostics: parsed.diagnostics,
          rowCount: parsed.rowCount,
          stderr: run.stderr,
          stdoutBytes: Buffer.byteLength(run.stdout, 'utf8'),
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          observedAt: now().toISOString(),
        });
      } catch {
        return portFail('INTERNAL_ERROR', 'the managed dump could not be run');
      }
    },
  };
};
