/**
 * Credential-reference import tests (T006 / issue #6).
 *
 * The document format is `{ schemaVersion: "1", bindings: [{ name, reference }] }`.
 * Every rejection path is exercised: size, JSON, schema version, unknown fields,
 * reserved/duplicate/invalid names, non-keychain stores and injected
 * `secret`/`value` fields. The apply path is proven to call the existing trusted
 * core API with references only, under fresh environment state/revision guards.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { portFail, portOk, type EnvironmentSummary, type PortOutcome } from '@hdsl/contracts';
import type { CredentialBinding, EnvironmentService } from '@hdsl/core';
import {
  applyCredentialFile,
  applyCredentialImport,
  CREDENTIAL_IMPORT_MAX_BINDINGS,
  CREDENTIAL_IMPORT_MAX_BYTES,
  hasLaunchCredentialReference,
  parseCredentialImportDocument,
  readBoundedCredentialFile,
} from '../../apps/desktop/src/main/credential-import.js';

const ENVIRONMENT_ID = 'env-abc12345';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const reference = (key = 'hdsl.dsh#account-1') => ({
  id: 'cred-abc12345',
  store: 'keychain',
  key,
});

const document = (bindings: unknown[]) => JSON.stringify({ schemaVersion: '1', bindings });

const validDocument = document([{ name: 'DEEPSEEK_API_KEY', reference: reference() }]);

const environment = (overrides: Partial<EnvironmentSummary> = {}): EnvironmentSummary => ({
  id: ENVIRONMENT_ID,
  name: '演示环境',
  revision: 2,
  stateVersion: 3,
  state: 'stopped',
  activeGenerationId: 'gen-abc12345',
  compositionDigest: 'a'.repeat(64),
  ...overrides,
});

interface RecordedWrite {
  readonly environmentId: string;
  readonly bindings: readonly CredentialBinding[];
  readonly expectedRevision?: number;
}

const fakeService = (summary: EnvironmentSummary | undefined, writes: RecordedWrite[]) => {
  const service = {
    findEnvironment: (environmentId: string): PortOutcome<EnvironmentSummary> =>
      summary !== undefined && environmentId === summary.id
        ? portOk(summary)
        : portFail('NOT_FOUND', 'environment was not found'),
    writeEnvironmentCredentials: (command: {
      environmentId: string;
      bindings: readonly CredentialBinding[];
      expectedRevision?: number;
    }): PortOutcome<{ revision: number }> => {
      writes.push(command);
      return portOk({ revision: 2 });
    },
    launchCredentialRequest: async (): Promise<never> => {
      throw new Error('no credential binding is configured for this environment');
    },
  };
  return service as unknown as EnvironmentService;
};

describe('parseCredentialImportDocument', () => {
  it('accepts a references-only document', () => {
    const parsed = parseCredentialImportDocument(validDocument);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.bindings).toEqual([
        { name: 'DEEPSEEK_API_KEY', reference: reference() },
      ]);
    }
  });

  it('rejects a non-keychain store', () => {
    const parsed = parseCredentialImportDocument(
      document([{ name: 'DEEPSEEK_API_KEY', reference: { ...reference(), store: 'secret-service' } }]),
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects an unknown field and an injected secret/value field', () => {
    for (const bad of [
      { schemaVersion: '1', bindings: [], extra: true },
      { schemaVersion: '1', bindings: [{ name: 'X', reference: reference(), value: 'secret' }] },
      { schemaVersion: '1', bindings: [{ name: 'X', reference: reference(), secret: 'secret' }] },
      { schemaVersion: '1', bindings: [{ name: 'X', reference: reference() }], value: 'secret' },
    ]) {
      expect(parseCredentialImportDocument(JSON.stringify(bad)).ok).toBe(false);
    }
  });

  it('rejects invalid json, wrong version, empty/oversized bindings', () => {
    expect(parseCredentialImportDocument('{').ok).toBe(false);
    expect(parseCredentialImportDocument(document([])).ok).toBe(false);
    expect(parseCredentialImportDocument(JSON.stringify({ schemaVersion: '2', bindings: [] })).ok).toBe(
      false,
    );
    const many = Array.from({ length: CREDENTIAL_IMPORT_MAX_BINDINGS + 1 }, (_, index) => ({
      name: `VAR_${String(index)}`,
      reference: reference(),
    }));
    expect(parseCredentialImportDocument(document(many)).ok).toBe(false);
    expect(parseCredentialImportDocument('x'.repeat(17 * 1024)).ok).toBe(false);
  });

  it('rejects reserved, duplicate and malformed variable names', () => {
    for (const name of ['PATH', 'HOME', 'DSH_HOME', '1BAD', 'bad-name', '']) {
      expect(parseCredentialImportDocument(document([{ name, reference: reference() }])).ok).toBe(
        false,
      );
    }
    const duplicate = document([
      { name: 'DEEPSEEK_API_KEY', reference: reference() },
      { name: 'DEEPSEEK_API_KEY', reference: reference() },
    ]);
    expect(parseCredentialImportDocument(duplicate).ok).toBe(false);
  });
});

describe('applyCredentialImport', () => {
  it('stores references with a freshly read revision and never touches a secret', () => {
    const writes: RecordedWrite[] = [];
    const parsed = parseCredentialImportDocument(validDocument);
    if (!parsed.ok) {
      throw new Error('fixture must parse');
    }
    const outcome = applyCredentialImport({
      service: fakeService(environment(), writes),
      environmentId: ENVIRONMENT_ID,
      document: parsed.document,
    });
    expect(outcome.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.bindings).toEqual([{ name: 'DEEPSEEK_API_KEY', reference: reference() }]);
    expect(writes[0]?.expectedRevision).toBe(2);
    expect(JSON.stringify(writes)).not.toContain('secret-value');
  });

  it('refuses an unknown environment and a busy environment', () => {
    const writes: RecordedWrite[] = [];
    const parsed = parseCredentialImportDocument(validDocument);
    if (!parsed.ok) {
      throw new Error('fixture must parse');
    }
    const missing = applyCredentialImport({
      service: fakeService(undefined, writes),
      environmentId: ENVIRONMENT_ID,
      document: parsed.document,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('NOT_FOUND');
    }

    const busy = applyCredentialImport({
      service: fakeService(environment({ state: 'running' }), writes),
      environmentId: ENVIRONMENT_ID,
      document: parsed.document,
    });
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.code).toBe('ENVIRONMENT_BUSY');
    }
    expect(writes).toHaveLength(0);
  });
});

describe('applyCredentialFile', () => {
  it('reads, validates and applies without copying or logging the file', () => {
    const writes: RecordedWrite[] = [];
    const readText = vi.fn(() => ({ ok: true, text: validDocument }) as const);
    const result = applyCredentialFile(
      fakeService(environment(), writes),
      ENVIRONMENT_ID,
      '/tmp/references.json',
      readText,
    );
    expect(result).toEqual({ ok: true, revision: 2, count: 1 });
    expect(readText).toHaveBeenCalledWith('/tmp/references.json');
    expect(writes).toHaveLength(1);
  });

  it('reports the failing stage without echoing the document', () => {
    const readFailure = applyCredentialFile(
      fakeService(environment(), []),
      ENVIRONMENT_ID,
      '/tmp/missing.json',
      () => ({ ok: false, reason: '无法读取所选配置文件' }),
    );
    expect(readFailure).toMatchObject({ ok: false, stage: 'read' });

    const parseFailure = applyCredentialFile(
      fakeService(environment(), []),
      ENVIRONMENT_ID,
      '/tmp/bad.json',
      () => ({
        ok: true,
        text: document([{ name: 'X', reference: reference(), value: 'secret' }]),
      }),
    );
    expect(parseFailure).toMatchObject({ ok: false, stage: 'parse' });
    expect(JSON.stringify(parseFailure)).not.toContain('secret');
  });
});

describe('readBoundedCredentialFile', () => {
  it('reads a small regular file', () => {
    const root = mkdtempSync(join(tmpdir(), 'hdsl-import-read-'));
    roots.push(root);
    const file = join(root, 'references.json');
    writeFileSync(file, validDocument);
    const result = readBoundedCredentialFile(file);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(validDocument);
    }
  });

  it('rejects an oversized file before reading it fully', () => {
    const root = mkdtempSync(join(tmpdir(), 'hdsl-import-read-'));
    roots.push(root);
    const file = join(root, 'big.json');
    writeFileSync(file, 'x'.repeat(CREDENTIAL_IMPORT_MAX_BYTES + 1));
    const result = readBoundedCredentialFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('过大');
    }
  });

  it('rejects a symlink without following it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hdsl-import-read-'));
    roots.push(root);
    const target = join(root, 'target.json');
    const link = join(root, 'link.json');
    writeFileSync(target, validDocument);
    try {
      symlinkSync(target, link);
    } catch {
      return; // platform without symlink support (not our supported matrix)
    }
    const result = readBoundedCredentialFile(link);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-regular file', () => {
    const root = mkdtempSync(join(tmpdir(), 'hdsl-import-read-'));
    roots.push(root);
    const result = readBoundedCredentialFile(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('常规文件');
    }
  });
});

describe('hasLaunchCredentialReference', () => {
  it('returns false when the loader rejects and never resolves a secret', async () => {
    const writes: RecordedWrite[] = [];
    await expect(
      hasLaunchCredentialReference(fakeService(environment(), writes), ENVIRONMENT_ID),
    ).resolves.toBe(false);
  });
});
