/**
 * Desired-config boundary for the runtime entry axis (#116 E1a, ADR 0005 D15).
 *
 * This module manages the **documented public surface** DSH reads: the profile
 * patch file (`cordis.patch.yml`) whose root is a top-level YAML **array** of
 * patch entries (`- insert: [...]` rows and `- id: X` overrides). It provides
 * exactly four edits — `enable`, `disable`, `config`, `remove` — and persists
 * them atomically, anchored to a profile root.
 *
 * ## What a successful write does and does NOT mean
 *
 * A saved file only means **desired config was persisted**. It does NOT mean the
 * running DSH process reached the matching ACTIVE set:
 *
 *   - DSH only hot-reloads when the profile declares `patchReload=live`; and even
 *     then there is a real, observed **warm-up window** right after ready during
 *     which writes can be silently ignored (see
 *     `docs/development/plugin-runtime-entry-validation.md`),
 *   - the hot-reload callback swallows parse errors (G8), so an invalid patch is
 *     a silent no-op unless HDSL validates it first,
 *   - there is **no verified public runtime-confirmation surface** yet
 *     (`pluginInventory/list` needs an official WebUI session; HDSL must not
 *     forge one or add a private bridge).
 *
 * The result therefore reports `saved: true` with
 * `runtime: 'pending'` / `runtimeVerification: 'unavailable'` and an
 * `activation` of `restart-required` or `live-reload-unverified`. Callers MUST
 * NOT upgrade that to "active". A restart deterministically applies the saved
 * desired config.
 *
 * ## Parsing rules (fail closed, explainable)
 *
 * - Exactly one YAML document; its root must be a top-level array. A missing
 *   body, a 0-byte file, multiple documents, a mapping root or a malformed
 *   `insert` is `INVALID_INPUT`. A legal empty array (`[]`) is valid and means
 *   "no overlay" — deliberately distinct from a 0-byte file.
 * - `insert` must be a sequence of mapping rows. Unresolvable constructs in
 *   **identity positions** (`id`/`name`) are reported as diagnostics and never
 *   collapse into a literal name (a tagged/aliased `name: !!js …` is not a
 *   package). Tags/aliases inside `config` are data and are preserved verbatim
 *   by the AST round-trip (so `!!js` survives an edit of an unrelated row).
 *
 * ## Row matching (explicit, not a safety claim)
 *
 * Rows are matched by profile-local row `id` only, in **file order** across
 * `insert` rows and `- id:` overrides. A repeated id is last-write-wins, which
 * matches how DSH composes the layers (a later override replaces the earlier
 * entry's whole config). This module does **not** match `name`, so a repeated id
 * carrying different names is not disambiguated; that is documented, not guarded.
 * Read-modify-write has no lock/CAS here; concurrent writers are a product-wiring
 * concern (see the E1 spec).
 *
 * Bundle/dependency changes are NOT part of this surface: they live in
 * `package.json` and, per upstream G6, need a restart
 * ({@link activationOf} with scope `composition`).
 */
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Node,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { isPlainRecord, portFail, portOk, type PortOutcome } from '@hdsl/contracts';
import { PATCH_SCAN_MAX } from './patch-references.js';

/** How the profile asks DSH to react to patch-file changes. */
export type PatchReloadMode = 'live' | 'startup' | 'unknown';

/** The four supported desired-config edits. */
export type PatchEditKind = 'enable' | 'disable' | 'config' | 'remove';

/** Whether the change is inside the patch file or changes composition identity. */
export type PatchChangeScope = 'patch-entry' | 'composition';

/** How a saved change can reach the running process. Never a success claim. */
export type PatchActivation = 'restart-required' | 'live-reload-unverified';

export type PatchDiagnosticCode =
  | 'entry-not-mapping'
  | 'insert-row-not-mapping'
  | 'row-id-missing'
  | 'row-id-not-plain-scalar'
  | 'row-name-not-plain-scalar'
  | 'row-disabled-not-boolean'
  | 'entry-without-id-or-insert'
  | 'alias-not-resolved';

export interface PatchDiagnostic {
  readonly code: PatchDiagnosticCode;
  readonly line: number;
  readonly detail: string;
}

export interface PatchRowView {
  readonly id: string;
  readonly kind: 'insert' | 'override';
  /** Package name from a plain scalar `name`; `undefined` when unknown. */
  readonly name: string | undefined;
  /**
   * `false` when `name` exists but is not a plain string literal (tagged,
   * aliased, block scalar, non-string). Such a row must never be treated as if
   * the raw text were a package name (issue #107 fact correction / #116 AC4).
   */
  readonly nameKnown: boolean;
  readonly disabled: boolean | undefined;
  readonly hasConfig: boolean;
}

export interface PatchEditOperation {
  readonly kind: PatchEditKind;
  readonly rowId: string;
  /** Required for `kind: 'config'`; the whole config map is replaced. */
  readonly config?: unknown;
}

export interface PatchWriteResult {
  readonly patchPath: string;
  readonly operation: PatchEditKind;
  /** Desired config was persisted atomically. */
  readonly saved: true;
  /** The running DSH set was NOT observed by this boundary. */
  readonly runtime: 'pending';
  readonly runtimeVerification: 'unavailable';
  readonly activation: PatchActivation;
  readonly restartRequired: boolean;
  readonly reloadMode: PatchReloadMode;
  readonly rows: readonly PatchRowView[];
  /** Non-fatal structural notes (tags/aliases in identity positions, …). */
  readonly diagnostics: readonly PatchDiagnostic[];
}

const hasCustomTag = (node: Node): boolean => {
  const tag = (node as { tag?: string }).tag;
  return typeof tag === 'string' && !tag.startsWith('tag:yaml.org,2002:');
};

/**
 * True when a node carries an **explicit** tag. A plain/quoted scalar has no
 * `tag`; `!!js`, `!!str`, … do. An explicitly tagged node is therefore never a
 * literal string in an identity position (issue #107/#116 AC4).
 */
const hasExplicitTag = (node: Node): boolean => typeof (node as { tag?: string }).tag === 'string';

const lineOf = (text: string, node: Node | null | undefined): number => {
  const offset = node?.range?.[0];
  if (typeof offset !== 'number') {
    return 1;
  }
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') {
      line += 1;
    }
  }
  return line;
};

/** Normalizes the `keepScalar` form of `YAMLMap.get` to a node or `undefined`. */
const nodeOf = (value: unknown): Node | undefined =>
  value === null || value === undefined ? undefined : (value as Node);

/** Reads a plain string scalar, or `undefined` when it is not a literal. */
const plainString = (node: Node | null | undefined): string | undefined => {
  if (node === null || node === undefined || isAlias(node) || hasExplicitTag(node)) {
    return undefined;
  }
  if (!isScalar(node)) {
    return undefined;
  }
  if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
    return undefined;
  }
  return typeof node.value === 'string' ? node.value : undefined;
};

/** One row matching a target id, in document order. */
interface RowMatch {
  readonly kind: 'insert' | 'override';
  readonly map: YAMLMap;
}

/**
 * Parses and validates a patch document. The parse is deliberately stricter
 * than "it happens to be YAML": exactly one document, top-level array root, so
 * a 0-byte file, a trailing second document or a mapping cannot masquerade as
 * something it is not.
 */
export class PatchConfigDocument {
  readonly #text: string;
  readonly #document: Document.Parsed;
  readonly #root: YAMLSeq;
  readonly #diagnostics: readonly PatchDiagnostic[];
  #dirty = false;

  private constructor(text: string, document: Document.Parsed, root: YAMLSeq, diagnostics: PatchDiagnostic[]) {
    this.#text = text;
    this.#document = document;
    this.#root = root;
    this.#diagnostics = diagnostics;
  }

  static parse(text: string): PortOutcome<PatchConfigDocument> {
    if (text.length > PATCH_SCAN_MAX) {
      return portFail('INVALID_INPUT', 'the patch file exceeds the bounded parse size');
    }
    let documents: Document.Parsed[];
    try {
      documents = parseAllDocuments(text, {
        uniqueKeys: true,
        prettyErrors: false,
        strict: true,
        logLevel: 'silent',
      });
    } catch {
      return portFail('INVALID_INPUT', 'the patch file could not be parsed');
    }
    if (documents.length === 0) {
      // A missing body is a parse error upstream (`yaml.load('') === undefined`),
      // NOT an empty list. Use `[]` for "no overlay".
      return portFail('INVALID_INPUT', 'the patch file must be a top-level YAML array of loader patch entries');
    }
    if (documents.length !== 1) {
      // Editing only the first document would silently drop the rest (data
      // loss); reject instead of rewriting a multi-document file.
      return portFail('INVALID_INPUT', 'the patch file must not contain multiple YAML documents');
    }
    const document = documents[0];
    if (document === undefined || document.errors.length > 0) {
      const first = document?.errors[0];
      return portFail('INVALID_INPUT', `the patch file is not valid YAML: ${first?.message ?? 'parse error'}`);
    }
    const contents = document.contents as Node | null | undefined;
    if (contents === null || contents === undefined) {
      return portFail('INVALID_INPUT', 'the patch file must be a top-level YAML array of loader patch entries');
    }
    if (!isSeq(contents)) {
      return portFail('INVALID_INPUT', 'the patch file must be a top-level YAML array of loader patch entries');
    }
    const diagnostics: PatchDiagnostic[] = [];
    for (const entry of contents.items as readonly (Node | null | undefined)[]) {
      if (entry === null || entry === undefined) {
        continue;
      }
      if (isAlias(entry) || hasCustomTag(entry)) {
        diagnostics.push({
          code: 'alias-not-resolved',
          line: lineOf(text, entry),
          detail: 'a patch entry is an alias or tagged node and cannot be classified',
        });
        continue;
      }
      if (!isMap(entry)) {
        diagnostics.push({
          code: 'entry-not-mapping',
          line: lineOf(text, entry),
          detail: 'a patch entry is not a mapping',
        });
        continue;
      }
      const insert = nodeOf(entry.get('insert', true));
      if (insert !== undefined) {
        // A non-sequence `insert` is a structural error: rows cannot be
        // enumerated, so every edit would be unreliable. Fail closed and
        // explainable instead of silently ignoring it.
        if (isAlias(insert) || hasExplicitTag(insert) || !isSeq(insert)) {
          return portFail('INVALID_INPUT', 'the insert value must be a sequence of loader rows');
        }
        for (const row of insert.items as readonly (Node | null | undefined)[]) {
          if (row === null || row === undefined) {
            continue;
          }
          if (isAlias(row) || hasCustomTag(row) || !isMap(row)) {
            diagnostics.push({
              code: 'insert-row-not-mapping',
              line: lineOf(text, row),
              detail: 'an inserted row is not a mapping',
            });
            continue;
          }
          PatchConfigDocument.#describeRow(text, row, diagnostics);
        }
        continue;
      }
      if (entry.has('id')) {
        PatchConfigDocument.#describeRow(text, entry, diagnostics);
        continue;
      }
      diagnostics.push({
        code: 'entry-without-id-or-insert',
        line: lineOf(text, entry),
        detail: 'a patch entry has neither insert nor id',
      });
    }
    return portOk(new PatchConfigDocument(text, document, contents, diagnostics));
  }

  static #describeRow(text: string, row: YAMLMap, diagnostics: PatchDiagnostic[]): void {
    const idNode = nodeOf(row.get('id', true));
    const id = plainString(idNode);
    if (idNode === undefined) {
      diagnostics.push({ code: 'row-id-missing', line: lineOf(text, row), detail: 'a patch row has no id' });
    } else if (id === undefined || id === '') {
      diagnostics.push({
        code: 'row-id-not-plain-scalar',
        line: lineOf(text, idNode),
        detail: 'a patch row id is not a plain non-empty string',
      });
    }
    const nameNode = nodeOf(row.get('name', true));
    if (nameNode !== undefined && plainString(nameNode) === undefined) {
      diagnostics.push({
        code: 'row-name-not-plain-scalar',
        line: lineOf(text, nameNode),
        detail: 'a patch row name is not a plain string; it is data, not a literal package name',
      });
    }
    const disabledNode = nodeOf(row.get('disabled', true));
    if (
      disabledNode !== undefined &&
      (!isScalar(disabledNode) ||
        hasExplicitTag(disabledNode) ||
        isAlias(disabledNode) ||
        typeof disabledNode.value !== 'boolean')
    ) {
      diagnostics.push({
        code: 'row-disabled-not-boolean',
        line: lineOf(text, disabledNode),
        detail: 'a patch row disabled value is not a boolean literal',
      });
    }
  }

  rows(): readonly PatchRowView[] {
    const rows: PatchRowView[] = [];
    for (const entry of this.#root.items as readonly (Node | null | undefined)[]) {
      if (entry === null || entry === undefined || !isMap(entry)) {
        continue;
      }
      const insert = nodeOf(entry.get('insert', true));
      if (insert !== undefined && isSeq(insert)) {
        for (const row of insert.items as readonly (Node | null | undefined)[]) {
          const view = PatchConfigDocument.#rowView(row, 'insert');
          if (view !== undefined) {
            rows.push(view);
          }
        }
        continue;
      }
      const view = PatchConfigDocument.#rowView(entry, 'override');
      if (view !== undefined) {
        rows.push(view);
      }
    }
    return rows;
  }

  static #rowView(row: Node | null | undefined, kind: 'insert' | 'override'): PatchRowView | undefined {
    if (row === null || row === undefined || !isMap(row) || isAlias(row) || hasCustomTag(row)) {
      return undefined;
    }
    const id = plainString(nodeOf(row.get('id', true)));
    if (id === undefined || id === '') {
      return undefined;
    }
    const nameNode = nodeOf(row.get('name', true));
    const name = plainString(nameNode);
    const disabledNode = nodeOf(row.get('disabled', true));
    const disabled =
      disabledNode !== undefined &&
      isScalar(disabledNode) &&
      !hasExplicitTag(disabledNode) &&
      !isAlias(disabledNode) &&
      typeof disabledNode.value === 'boolean'
        ? disabledNode.value
        : undefined;
    return {
      id,
      kind,
      name,
      nameKnown: nameNode === undefined || name !== undefined,
      disabled,
      hasConfig: row.has('config'),
    };
  }

  diagnostics(): readonly PatchDiagnostic[] {
    return this.#diagnostics;
  }

  toText(): string {
    return this.#dirty ? this.#document.toString() : this.#text;
  }

  /** Applies one edit in place; `changed` describes the actual mutation. */
  edit(operation: PatchEditOperation): PortOutcome<{ readonly document: PatchConfigDocument; readonly changed: boolean }> {
    const target = operation.rowId;
    if (typeof target !== 'string' || target === '') {
      return portFail('INVALID_INPUT', 'a patch edit requires a non-empty row id');
    }
    if (operation.kind === 'config' && operation.config === undefined) {
      return portFail('INVALID_INPUT', 'a config edit requires a config value');
    }
    const matches = this.#matches(target);
    switch (operation.kind) {
      case 'enable':
        return this.#enable(target, matches);
      case 'disable':
        return this.#disable(target, matches);
      case 'config':
        return this.#setConfig(target, operation.config, matches);
      case 'remove':
        return this.#remove(target, matches);
    }
  }

  /**
   * All rows with this id, in **document order** across `insert` rows and
   * `- id:` overrides (so a last-write-wins edit can target the final match).
   */
  #matches(id: string): RowMatch[] {
    const matches: RowMatch[] = [];
    for (const entry of this.#root.items as readonly (Node | null | undefined)[]) {
      if (entry === null || entry === undefined || !isMap(entry)) {
        continue;
      }
      const insert = nodeOf(entry.get('insert', true));
      if (insert !== undefined && isSeq(insert)) {
        for (const row of insert.items as readonly (Node | null | undefined)[]) {
          if (row !== null && row !== undefined && isMap(row) && plainString(nodeOf(row.get('id', true))) === id) {
            matches.push({ kind: 'insert', map: row });
          }
        }
        continue;
      }
      if (plainString(nodeOf(entry.get('id', true))) === id) {
        matches.push({ kind: 'override', map: entry });
      }
    }
    return matches;
  }

  #enable(id: string, matches: readonly RowMatch[]): PortOutcome<{ document: PatchConfigDocument; changed: boolean }> {
    if (matches.length === 0) {
      return portFail('NOT_FOUND', `no patch row with id ${JSON.stringify(id)} was found to enable`);
    }
    let changed = false;
    for (const match of matches) {
      if (!match.map.has('disabled')) {
        continue;
      }
      match.map.delete('disabled');
      changed = true;
      // Only an override emptied by THIS edit becomes a no-op: drop just it,
      // never unrelated id-only overrides or their comments.
      if (match.kind === 'override' && PatchConfigDocument.#isIdOnly(match.map)) {
        this.#dropRootEntry(match.map);
      }
    }
    if (changed) {
      this.#dirty = true;
    }
    return portOk({ document: this, changed });
  }

  #disable(id: string, matches: readonly RowMatch[]): PortOutcome<{ document: PatchConfigDocument; changed: boolean }> {
    let changed = false;
    for (const match of matches) {
      if (match.map.get('disabled') !== true) {
        match.map.set('disabled', this.#document.createNode(true));
        changed = true;
      }
    }
    if (matches.length === 0) {
      // Disabling a row this patch does not insert is a legitimate override of a
      // bundle/base row; it is additive and never touches other rows.
      this.#blockStyle();
      this.#root.add(this.#document.createNode({ id, disabled: true }));
      changed = true;
    }
    if (changed) {
      this.#dirty = true;
    }
    return portOk({ document: this, changed });
  }

  #setConfig(
    id: string,
    config: unknown,
    matches: readonly RowMatch[],
  ): PortOutcome<{ document: PatchConfigDocument; changed: boolean }> {
    let created: Node;
    try {
      created = this.#document.createNode(config);
    } catch {
      return portFail('INVALID_INPUT', 'the config value cannot be represented as YAML');
    }
    // Last-write-wins: edit the LAST matching row in document order, whether it
    // is an insert row or a later `- id:` override (upstream whole-row replace).
    const target = matches[matches.length - 1];
    if (target === undefined) {
      this.#blockStyle();
      this.#root.add(this.#document.createNode({ id, config }));
    } else {
      target.map.set('config', created);
    }
    this.#dirty = true;
    return portOk({ document: this, changed: true });
  }

  #remove(id: string, matches: readonly RowMatch[]): PortOutcome<{ document: PatchConfigDocument; changed: boolean }> {
    if (matches.length === 0) {
      return portFail('NOT_FOUND', `no patch row with id ${JSON.stringify(id)} was found to remove`);
    }
    const targeted = new Set<Node>(matches.map((match) => match.map));
    const entries = this.#root.items as (Node | null | undefined)[];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === null || entry === undefined || !isMap(entry)) {
        continue;
      }
      const insert = nodeOf(entry.get('insert', true));
      if (insert !== undefined && isSeq(insert)) {
        const inserted = insert.items as (Node | null | undefined)[];
        for (let rowIndex = inserted.length - 1; rowIndex >= 0; rowIndex -= 1) {
          const row = inserted[rowIndex];
          if (row !== null && row !== undefined && targeted.has(row)) {
            inserted.splice(rowIndex, 1);
          }
        }
        if (insert.items.length === 0) {
          entries.splice(index, 1);
        }
        continue;
      }
      if (targeted.has(entry)) {
        entries.splice(index, 1);
      }
    }
    this.#dirty = true;
    return portOk({ document: this, changed: true });
  }

  /** True when a mapping has exactly one `id` key (no other data). */
  static #isIdOnly(map: YAMLMap): boolean {
    return (
      map.items.length === 1 &&
      String((map.items[0]?.key as Scalar | null | undefined)?.value ?? '') === 'id'
    );
  }

  #dropRootEntry(target: Node): void {
    const entries = this.#root.items as (Node | null | undefined)[];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index] === target) {
        entries.splice(index, 1);
        return;
      }
    }
  }

  /** Use block style once a new entry is appended to a flow-parsed (`[]`) root. */
  #blockStyle(): void {
    this.#root.flow = false;
  }
}

/** Best-effort directory fsync; some platforms (e.g. Windows) refuse it. */
const fsyncDirectoryBestEffort = (path: string): void => {
  try {
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Durability of the directory entry stays best-effort where unsupported.
  }
};

/**
 * Atomic text write: unpredictable temp name, `O_CREAT|O_EXCL|O_NOFOLLOW`, mode
 * 0600, fsync file → rename → best-effort directory fsync, temp cleaned on any
 * failure. Not exported: the public write entry is anchored ({@link writePatchFileWithinRoot}).
 */
const writePatchFileAtomicRaw = (path: string, text: string): void => {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.tmp-${randomBytes(16).toString('hex')}`;
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporary, flags, 0o600);
    writeSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    renamed = true;
    fsyncDirectoryBestEffort(directory);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor may already be closed if close succeeded above.
      }
    }
    if (!renamed) {
      rmSync(temporary, { force: true });
    }
  }
};

/** True when `candidate` is strictly inside `root` (lexical, not realpath). */
const isStrictlyWithin = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
};

/**
 * The only public write entry: verifies `patchPath` is inside `profileRoot`
 * before touching the filesystem, so a caller can never turn this boundary into
 * an arbitrary-path writer. Containment is lexical (same intent as core's
 * `assertWithin`); it is not a realpath sandbox.
 */
export const writePatchFileWithinRoot = (
  profileRoot: string,
  patchPath: string,
  text: string,
): PortOutcome<void> => {
  if (typeof profileRoot !== 'string' || profileRoot === '') {
    return portFail('INVALID_INPUT', 'a profile root is required to anchor the patch write');
  }
  if (typeof patchPath !== 'string' || !isStrictlyWithin(profileRoot, patchPath)) {
    return portFail('INVALID_INPUT', 'the patch file path must be inside the profile root');
  }
  try {
    writePatchFileAtomicRaw(patchPath, text);
    return portOk(undefined);
  } catch {
    return portFail('INTERNAL_ERROR', 'the patch file could not be written');
  }
};

/** Reads `dsh.profile.patchReload` from a profile `package.json` text. */
export const resolvePatchReloadMode = (profilePackageJsonText: string): PatchReloadMode => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(profilePackageJsonText);
  } catch {
    return 'unknown';
  }
  if (!isPlainRecord(parsed)) {
    return 'unknown';
  }
  const dsh = parsed['dsh'];
  const profile = isPlainRecord(dsh) ? dsh['profile'] : undefined;
  const value = isPlainRecord(profile) ? profile['patchReload'] : undefined;
  return value === 'live' || value === 'startup' ? value : 'unknown';
};

/**
 * Maps a change scope + reload mode to the honest activation. Composition
 * changes (bundles/dependencies) always need a restart (upstream G6); a patch
 * entry is only "possibly live" when the profile explicitly opts into live
 * reload, and even then HDSL cannot confirm the ACTIVE set.
 */
export const activationOf = (scope: PatchChangeScope, reloadMode: PatchReloadMode): PatchActivation =>
  scope === 'composition' || reloadMode !== 'live' ? 'restart-required' : 'live-reload-unverified';

/**
 * Persists one desired-config edit inside `profileRoot`. The returned activation
 * never claims the running process changed; callers surface `saved` + `pending`
 * and offer a restart as the deterministic fallback.
 */
export const applyPatchOperation = (input: {
  readonly profileRoot: string;
  readonly patchPath: string;
  readonly text: string;
  readonly operation: PatchEditOperation;
  readonly reloadMode: PatchReloadMode;
  readonly scope?: PatchChangeScope;
}): PortOutcome<PatchWriteResult> => {
  const parsed = PatchConfigDocument.parse(input.text);
  if (!parsed.ok) {
    return parsed;
  }
  const edited = parsed.value.edit(input.operation);
  if (!edited.ok) {
    return edited;
  }
  const written = writePatchFileWithinRoot(input.profileRoot, input.patchPath, edited.value.document.toText());
  if (!written.ok) {
    return written;
  }
  const activation = activationOf(input.scope ?? 'patch-entry', input.reloadMode);
  return portOk({
    patchPath: input.patchPath,
    operation: input.operation.kind,
    saved: true,
    runtime: 'pending',
    runtimeVerification: 'unavailable',
    activation,
    restartRequired: activation === 'restart-required',
    reloadMode: input.reloadMode,
    rows: edited.value.document.rows(),
    diagnostics: edited.value.document.diagnostics(),
  });
};
