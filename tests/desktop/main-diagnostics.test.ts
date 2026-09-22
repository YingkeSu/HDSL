/**
 * Diagnostic export whitelist + canary negative tests (T006 / issue #6).
 *
 * These drive the real exporter with an injected path chooser and file sink.
 * They prove that excluded locations (credential references, upstream
 * `.credentials.yaml`, environment home logs, sessions) are never read and that
 * an injected canary surviving in a whitelisted field is still redacted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { portFail, portOk, type EnvironmentSummary } from '@hdsl/contracts';
import {
  generationPaths,
  resolveLayout,
  type EnvironmentService,
  type InstallManifest,
  type OperationRecord,
} from '@hdsl/core';
import { createDiagnosticsExporter } from '../../apps/desktop/src/main/exporter.js';
import type { DiagnosticAppInfo } from '../../apps/desktop/src/main/diagnostics.js';

const CANARY = 'sk-canary-9f3a-DO-NOT-EXPORT';
const ENVIRONMENT_ID = 'env-abc12345';
const GENERATION_ID = 'gen-abc12345';

const roots: string[] = [];

const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'hdsl-diag-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const appInfo: DiagnosticAppInfo = {
  name: 'HDSL',
  version: '0.0.0',
  platform: 'darwin',
  arch: 'arm64',
  node: '24.21.0',
  electron: '44.4.3',
};

const summary: EnvironmentSummary = {
  id: ENVIRONMENT_ID,
  name: '演示环境',
  revision: 2,
  stateVersion: 3,
  state: 'stopped',
  activeGenerationId: GENERATION_ID,
  compositionDigest: 'a'.repeat(64),
};

const buildManifest = (homeDirectory: string) =>
  ({
    schemaVersion: '1',
    installMode: 'npm-ci',
    catalogRevision: 't004-2026-09-20.1',
    compositionDigest: 'a'.repeat(64),
    node: { version: '24.21.0', sha256: 'b'.repeat(64), executable: 'node/bin/node' },
    dsh: {
      version: '0.1.5-rc.2',
      sha256: 'c'.repeat(64),
      entrypoint: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      treeDigest: 'd'.repeat(64),
    },
    closure: {
      installed: true,
      lockSha256: 'e'.repeat(64),
      lockAsset: 'package-lock.json',
      packageCount: 3,
      rootIntegritySha512: 'f'.repeat(88),
      npmVersion: '11.7.0',
      nodeVersion: '24.21.0',
    },
    preflight: {
      skipped: false,
      passed: true,
      checks: [
        { name: 'version', exitCode: 0, stdout: `${CANARY} ${homeDirectory}/dsh /Users/operator/secret ok` },
      ],
    },
    installedAt: '2026-09-20T00:00:00.000Z',
  }) as unknown as InstallManifest;

const operationError: OperationRecord = {
  schemaVersion: '1',
  id: 'op-abc12345',
  environmentId: ENVIRONMENT_ID,
  kind: 'start',
  phase: `waiting-ready ${CANARY}`,
  status: 'failed',
  sequence: 4,
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:01.000Z',
  progress: 40,
  error: { code: 'PROCESS_EXITED', message: `spawn failed with ${CANARY}`, retryable: true },
};

const buildFixture = () => {
  const dataRoot = freshRoot();
  const layout = resolveLayout(dataRoot);
  const paths = generationPaths(layout, ENVIRONMENT_ID, GENERATION_ID);
  const manifest = buildManifest(paths.homeDirectory);
  mkdirSync(paths.generationDirectory, { recursive: true });
  mkdirSync(paths.homeDirectory, { recursive: true });
  mkdirSync(join(paths.homeDirectory, 'logs'), { recursive: true });
  mkdirSync(join(paths.homeDirectory, 'sessions'), { recursive: true });
  writeFileSync(paths.manifestPath, JSON.stringify(manifest));
  writeFileSync(
    paths.lockPath,
    JSON.stringify({
      schemaVersion: '1',
      sources: { node: { url: `https://nodejs.org/x?token=${CANARY}`, sha256: 'b'.repeat(64) } },
    }),
  );
  // Excluded decoys: these must never be read by the exporter.
  writeFileSync(join(layout.environments, ENVIRONMENT_ID, 'credentials.json'), `{"secret":"${CANARY}"}`);
  writeFileSync(join(paths.homeDirectory, '.credentials.yaml'), `secret: ${CANARY}`);
  writeFileSync(join(paths.homeDirectory, 'logs', 'dsh.log'), CANARY);
  writeFileSync(join(paths.homeDirectory, 'sessions', 'grant.json'), CANARY);

  const service = {
    findEnvironment: (environmentId: string) =>
      environmentId === ENVIRONMENT_ID
        ? portOk(summary)
        : portFail('NOT_FOUND', 'environment was not found'),
    tryReadInstallManifest: (environmentId: string) =>
      environmentId === ENVIRONMENT_ID
        ? portOk(manifest)
        : portFail('NOT_FOUND', 'environment was not found'),
  } as unknown as EnvironmentService;

  const operations = {
    list: () => [operationError],
  };

  return { dataRoot, layout, paths, service, operations };
};

describe('diagnostic export whitelist', () => {
  it('exports only the whitelisted fields and redacts every canary', () => {
    const { dataRoot, layout, service, operations } = buildFixture();
    let written = '';
    const exporter = createDiagnosticsExporter({
      service,
      layout,
      operations: operations as never,
      readLaunchRecord: () => ({
        state: 'running',
        endpointOrigin: 'http://127.0.0.1:53123',
        identityRecorded: true,
        exitCode: null,
        errorCode: null,
      }),
      app: appInfo,
      pathChooser: { chooseExportPath: () => join(dataRoot, 'export.json') },
      writeFile: (_path, content) => {
        written = content;
      },
      redactions: [CANARY],
      clock: () => new Date('2026-09-20T12:00:00.000Z'),
    });

    const outcome = exporter(ENVIRONMENT_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.exported).toBe(true);
    expect(outcome.value.redacted).toBe(true);
    expect(outcome.value.exportId).toMatch(/^exp-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    expect(written).not.toContain(CANARY);
    expect(written).not.toContain('/Users/operator/secret');
    expect(written).not.toContain(dataRoot);
    expect(written).toContain('<environment-home>');
    // Excluded file names never appear as export content.
    expect(written).not.toContain('.credentials.yaml');
    expect(written.toLowerCase()).not.toContain('credentials.json');

    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed['environment']).toMatchObject({ id: ENVIRONMENT_ID, state: 'stopped' });
    expect(parsed['launch']).toMatchObject({ loopbackOrigin: 'http://127.0.0.1:53123' });
    expect(Array.isArray(parsed['operations'])).toBe(true);
  });

  it('reports EXPORT_FAILED when the operator cancels the chooser', () => {
    const { layout, service, operations } = buildFixture();
    const exporter = createDiagnosticsExporter({
      service,
      layout,
      operations: operations as never,
      readLaunchRecord: () => null,
      app: appInfo,
      pathChooser: { chooseExportPath: () => null },
      writeFile: () => {
        throw new Error('must not be called');
      },
    });
    const outcome = exporter(ENVIRONMENT_ID);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('EXPORT_FAILED');
    }
  });

  it('reports NOT_FOUND for an unknown environment', () => {
    const { layout, service, operations } = buildFixture();
    const exporter = createDiagnosticsExporter({
      service,
      layout,
      operations: operations as never,
      readLaunchRecord: () => null,
      app: appInfo,
      pathChooser: { chooseExportPath: () => '/tmp/never.json' },
    });
    const outcome = exporter('env-unknown1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('NOT_FOUND');
    }
  });
});
