/**
 * Test-injection lane: the T006 headless QA entry (`dist/main/qa-entry.js`).
 *
 * Independent QA (hdsl-25). This lane is **not** the native menu or the native
 * save/open dialogs. It exercises the candidate's explicit, test-only entry,
 * which is excluded from the published `files` and is not the package `main`,
 * so the real native GUI path stays separately marked as unverified/manual.
 *
 * Every assertion here is about the injected entry's observable effects
 * (export file content, credential record on disk, stderr status line). None of
 * them is used as evidence that the native menu/dialog works.
 *
 * Opt-in with `HDSL_E2E_DESKTOP=1`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { appHarness, bootApp, cleanupAllHarnesses } from './support/app-harness.js';
import { createCanary, plantUpstreamCredentialArtifacts } from './support/canary.js';
import { QA_ENTRY } from './support/electron-app.js';
import { callContract, readJsonIfPresent, waitForFile } from './support/desktop-ui.js';
import { waitFor } from './support/gates.js';
import {
  clonePreparedDataRoot,
  prepareEnvironment,
  type PreparedEnvironment,
} from './support/prepared-environment.js';
import { QaResourceRegistry } from './support/resources.js';

const ENABLED = process.env['HDSL_E2E_DESKTOP'] === '1';
const COMBINATION = 'darwin-arm64-node22_19_0-dsh0_1_5-rc_2';

describe.skipIf(!ENABLED)('desktop test-injection lane (qa-entry; separate from native UI)', () => {
  let prepRegistry: QaResourceRegistry;
  let prepared: PreparedEnvironment;

  beforeAll(async () => {
    prepRegistry = new QaResourceRegistry();
    prepared = await prepareEnvironment(prepRegistry, 'qa-prep', 'qa-prep-env', COMBINATION);
  }, 25 * 60_000);

  afterAll(async () => {
    const report = await prepRegistry.cleanup();
    expect(report.failed, JSON.stringify(report.failed)).toEqual([]);
  });

  afterEach(cleanupAllHarnesses);

  it('E2E-QAENTRY-DIAG-01: export writes a redacted bundle with no canary or excluded files', async () => {
    const harness = appHarness();
    const dataRoot = clonePreparedDataRoot(harness.registry, prepared, 'diag01-data');
    const environmentDir = join(dataRoot, 'environments', prepared.environmentId);
    const environmentJson = readJsonIfPresent(join(environmentDir, 'environment.json')) as
      | { readonly activeGenerationId?: string }
      | null;
    const generationId = environmentJson?.activeGenerationId ?? '';
    expect(generationId).not.toBe('');

    // Plant secrets only in locations the export must never read.
    const canary = createCanary('diag01');
    const homeDir = join(environmentDir, 'generations', generationId, 'home');
    mkdirSync(homeDir, { recursive: true });
    plantUpstreamCredentialArtifacts(homeDir, canary);
    const credentialsFile = join(environmentDir, 'credentials.json');
    writeFileSync(credentialsFile, `${JSON.stringify({ note: canary })}\n`, { mode: 0o600 });
    chmodSync(credentialsFile, 0o600);

    const exportPath = join(dataRoot, 'qa-export.json');
    const { cdp } = await bootApp(harness, 'diag01', {
      entry: QA_ENTRY,
      dataRoot,
      extraArgs: ['--hdsl-qa-export-path', exportPath],
    });

    const result = await callContract(cdp, 'diagnostics.export', {
      requestId: 'diag01-export',
      environmentId: prepared.environmentId,
    });
    expect(result.ok).toBe(true);
    const value = result.value as {
      readonly exportId?: string;
      readonly exported?: boolean;
      readonly redacted?: boolean;
    };
    expect(value.exported).toBe(true);
    expect(value.redacted).toBe(true);
    expect(typeof value.exportId).toBe('string');

    await waitForFile(exportPath, { timeoutMs: 10_000, label: 'diagnostics export file' });
    const content = readFileSync(exportPath, 'utf8');
    expect(content).not.toContain(canary);
    expect(content).not.toContain('.credentials.yaml');
    expect(content).not.toContain('credentials.json');
    expect(content).not.toContain(dataRoot);
    expect(content).toContain(prepared.environmentId);

    // Replaying the same requestId must not rewrite the file.
    const before = statSync(exportPath).mtimeMs;
    const replay = await callContract(cdp, 'diagnostics.export', {
      requestId: 'diag01-export',
      environmentId: prepared.environmentId,
    });
    expect(replay.ok).toBe(true);
    expect((replay.value as { exportId?: string }).exportId).toBe(value.exportId);
    expect(statSync(exportPath).mtimeMs).toBe(before);
    // The chosen path is never returned to the renderer.
    expect(JSON.stringify(result)).not.toContain(exportPath);
  }, 180_000);

  it('E2E-QAENTRY-CRED-01: injected import writes reference-only config, no secret value', async () => {
    const harness = appHarness();
    const dataRoot = clonePreparedDataRoot(harness.registry, prepared, 'cred01-data');
    const configPath = join(dataRoot, 'qa-credential-references.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: '1',
          bindings: [
            {
              name: 'HDSL_QA_CANARY_KEY',
              reference: { id: 'cred-qa-inject-1', store: 'keychain', key: 'hdsl-qa-24-canary#t006' },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const booted = await bootApp(harness, 'cred01', {
      entry: QA_ENTRY,
      dataRoot,
      extraArgs: [
        '--hdsl-qa-import-path',
        configPath,
        '--hdsl-qa-import-environment',
        prepared.environmentId,
      ],
    });
    await waitFor(() => booted.app.output().includes('credential-import: applied'), {
      timeoutMs: 16_000,
      label: 'credential import applied',
    });

    const credentialsPath = join(
      dataRoot,
      'environments',
      prepared.environmentId,
      'credentials.json',
    );
    await waitForFile(credentialsPath, { timeoutMs: 5_000, label: 'credentials record' });
    const record = readFileSync(credentialsPath, 'utf8');
    expect(record).toContain('cred-qa-inject-1');
    expect(record).toContain('hdsl-qa-24-canary#t006');
    expect(record).not.toContain('secret');
    expect(record).not.toContain('sk-');
    const mode = statSync(credentialsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 180_000);

  it('E2E-QAENTRY-CRED-02: a document carrying a secret field is rejected and writes nothing', async () => {
    const harness = appHarness();
    const dataRoot = clonePreparedDataRoot(harness.registry, prepared, 'cred02-data');
    const configPath = join(dataRoot, 'qa-bad-references.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: '1',
          bindings: [
            {
              name: 'HDSL_QA_CANARY_KEY',
              value: 'sk-live-must-not-be-stored',
              reference: { id: 'cred-qa-inject-2', store: 'keychain', key: 'hdsl-qa-24-canary#t006' },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const booted = await bootApp(harness, 'cred02', {
      entry: QA_ENTRY,
      dataRoot,
      extraArgs: [
        '--hdsl-qa-import-path',
        configPath,
        '--hdsl-qa-import-environment',
        prepared.environmentId,
      ],
    });
    await waitFor(() => booted.app.output().includes('credential-import: rejected'), {
      timeoutMs: 16_000,
      label: 'credential import rejected',
    });
    expect(existsSync(join(dataRoot, 'environments', prepared.environmentId, 'credentials.json'))).toBe(
      false,
    );
    // The rejected document is never copied and the raw secret is never logged.
    expect(booted.app.output()).not.toContain('sk-live-must-not-be-stored');
  }, 180_000);
});
