/**
 * Main-process credential-reference import (T006 / issue #6).
 *
 * Design: `docs/adr/0004-main-credential-import-entry.md`.
 *
 * The renderer never supplies a path and never sees the file. The user picks a
 * JSON document through a native menu entry; main reads it, applies a strict
 * size/shape/version validator, and stores only variable names plus frozen
 * `CredentialReference` values through the existing trusted core API
 * ({@link EnvironmentService.writeEnvironmentCredentials}). A secret value is
 * not a valid input: the document has no value field, unknown fields are
 * rejected, and only OS-store references are accepted. No keychain item is
 * read, written or enumerated here.
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import {
  credentialReferenceSchema,
  formatValidationIssues,
  portFail,
  portOk,
  sArray,
  sLiteral,
  sObject,
  sString,
  type CredentialReference,
  type PortOutcome,
  type ValidationIssue,
} from '@hdsl/contracts';
import type { CredentialBinding, EnvironmentService } from '@hdsl/core';
import { CREDENTIAL_NAME_PATTERN, RESERVED_ENVIRONMENT_NAMES } from '@hdsl/runtime';

/** Hard input cap; the document must stay a tiny reference list. */
export const CREDENTIAL_IMPORT_MAX_BYTES = 16 * 1024;
export const CREDENTIAL_IMPORT_SCHEMA_VERSION = '1';
export const CREDENTIAL_IMPORT_MAX_BINDINGS = 32;

const bindingSchema = sObject({
  name: sString({ minLength: 1, maxLength: 128, pattern: CREDENTIAL_NAME_PATTERN }),
  reference: credentialReferenceSchema,
});

export const credentialImportDocumentSchema = sObject({
  schemaVersion: sLiteral(CREDENTIAL_IMPORT_SCHEMA_VERSION),
  bindings: sArray(bindingSchema, {
    minLength: 1,
    maxLength: CREDENTIAL_IMPORT_MAX_BINDINGS,
  }),
});

export interface CredentialImportDocument {
  readonly schemaVersion: '1';
  readonly bindings: readonly CredentialBinding[];
}

export type CredentialImportParse =
  | { readonly ok: true; readonly document: CredentialImportDocument }
  | { readonly ok: false; readonly reason: string };

const reason = (message: string): CredentialImportParse => ({
  ok: false,
  reason: message,
});

/**
 * Parses the JSON text. Size, JSON validity, object shape, schema version and
 * every nested field are checked before any environment is touched.
 */
export const parseCredentialImportDocument = (text: string): CredentialImportParse => {
  if (Buffer.byteLength(text, 'utf8') > CREDENTIAL_IMPORT_MAX_BYTES) {
    return reason(`配置文件过大（上限 ${String(CREDENTIAL_IMPORT_MAX_BYTES)} 字节）`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return reason('配置文件不是合法 JSON');
  }
  const issues: ValidationIssue[] = [];
  const parsed = credentialImportDocumentSchema(raw, 'credentialImport', issues);
  if (parsed === undefined) {
    return reason(`配置文件结构无效：${formatValidationIssues(issues)}`);
  }
  const seen = new Set<string>();
  for (const binding of parsed.bindings) {
    if (RESERVED_ENVIRONMENT_NAMES.has(binding.name)) {
      return reason(`变量名 "${binding.name}" 保留给启动器，不能绑定`);
    }
    if (seen.has(binding.name)) {
      return reason(`变量名 "${binding.name}" 重复`);
    }
    seen.add(binding.name);
    if (binding.reference.store !== 'keychain') {
      return reason(
        `引用存储 "${binding.reference.store}" 在当前实现上不可用（仅支持 keychain）`,
      );
    }
  }
  return {
    ok: true,
    document: { schemaVersion: '1', bindings: parsed.bindings },
  };
};

export interface ApplyCredentialImportOptions {
  readonly service: EnvironmentService;
  readonly environmentId: string;
  readonly document: CredentialImportDocument;
}

/**
 * Freshly re-reads the target environment and writes the bindings through the
 * trusted core API. The environment id came from a validated selection, but it
 * is re-resolved here so a stale selection cannot import into a removed or
 * running environment.
 */
export const applyCredentialImport = (
  options: ApplyCredentialImportOptions,
): PortOutcome<{ readonly revision: number }> => {
  const environment = options.service.findEnvironment(options.environmentId);
  if (!environment.ok) {
    return portFail('NOT_FOUND', 'the selected environment no longer exists');
  }
  const state = environment.value.state;
  if (state === 'creating' || state === 'starting' || state === 'running' || state === 'stopping') {
    return portFail('ENVIRONMENT_BUSY', 'the environment is not in a configurable state');
  }
  const outcome = options.service.writeEnvironmentCredentials({
    environmentId: environment.value.id,
    bindings: options.document.bindings,
    expectedRevision: environment.value.revision,
  });
  if (!outcome.ok) {
    return outcome;
  }
  return portOk({ revision: outcome.value.revision });
};

/** Display-only reference label; never includes a secret value. */
export const credentialReferenceForDisplay = (reference: CredentialReference): string =>
  `${reference.store}:${reference.id}`;

/**
 * True when the environment has a readable launch credential binding. Used by
 * main to show an explicit "configure credentials first" prompt before a start;
 * it reads only the reference record and never resolves a keychain item.
 */
export const hasLaunchCredentialReference = async (
  service: EnvironmentService,
  environmentId: string,
): Promise<boolean> => {
  try {
    await service.launchCredentialRequest(environmentId);
    return true;
  } catch {
    return false;
  }
};

export type CredentialImportFileResult =
  | { readonly ok: true; readonly revision: number; readonly count: number }
  | {
      readonly ok: false;
      readonly stage: 'read' | 'parse' | 'apply';
      readonly message: string;
    };

export type BoundedReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads a credential-reference file with pre-read limits: the path must be a
 * regular file (not a symlink, FIFO, device or directory) and at most
 * {@link CREDENTIAL_IMPORT_MAX_BYTES}. `O_NOFOLLOW` rejects a symlink without
 * following it, `O_NONBLOCK` prevents a special file from blocking, `fstat`
 * checks the type and size before any read, and the read is bounded to the cap
 * plus one byte so an oversized file is rejected without unbounded allocation.
 */
export const readBoundedCredentialFile = (path: string): BoundedReadResult => {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlock = constants.O_NONBLOCK ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      return { ok: false, reason: '不支持符号链接配置文件' };
    }
    return { ok: false, reason: '无法读取所选配置文件' };
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      return { ok: false, reason: '配置文件必须是常规文件' };
    }
    if (stat.size > CREDENTIAL_IMPORT_MAX_BYTES) {
      return {
        ok: false,
        reason: `配置文件过大（上限 ${String(CREDENTIAL_IMPORT_MAX_BYTES)} 字节）`,
      };
    }
    const buffer = Buffer.alloc(CREDENTIAL_IMPORT_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read === 0) {
        break;
      }
      offset += read;
    }
    if (offset > CREDENTIAL_IMPORT_MAX_BYTES) {
      return {
        ok: false,
        reason: `配置文件过大（上限 ${String(CREDENTIAL_IMPORT_MAX_BYTES)} 字节）`,
      };
    }
    return { ok: true, text: buffer.subarray(0, offset).toString('utf8') };
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Reads and applies one credential-reference file. The path always comes from
 * a native chooser or an operator-controlled hook, never from the renderer.
 * The original file is never copied and the text is never logged. The default
 * reader applies the pre-read type/size/symlink limits above.
 */
export const applyCredentialFile = (
  service: EnvironmentService,
  environmentId: string,
  filePath: string,
  readText: (path: string) => BoundedReadResult = readBoundedCredentialFile,
): CredentialImportFileResult => {
  const read = readText(filePath);
  if (!read.ok) {
    return { ok: false, stage: 'read', message: read.reason };
  }
  const parsed = parseCredentialImportDocument(read.text);
  if (!parsed.ok) {
    return { ok: false, stage: 'parse', message: parsed.reason };
  }
  const applied = applyCredentialImport({ service, environmentId, document: parsed.document });
  if (!applied.ok) {
    return { ok: false, stage: 'apply', message: `导入失败（${applied.code}）` };
  }
  return { ok: true, revision: applied.value.revision, count: parsed.document.bindings.length };
};
