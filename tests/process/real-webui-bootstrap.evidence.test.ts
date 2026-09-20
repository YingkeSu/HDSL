/**
 * OPT-IN real-DSH WebUI bootstrap evidence (T006 prerequisite).
 *
 * Verifies against a real audited rc.2 install that the managed bootstrap URL
 * establishes the `dsh-auth` cookie (303 + Set-Cookie), that the token-free
 * origin is 401 without the cookie, and that the cookie yields the
 * authenticated WebUI page. No model/API call is made.
 *
 * ```sh
 * HDSL_REAL_WEBUI_BOOTSTRAP=1 HDSL_EVIDENCE_KEEP=1 \
 * HDSL_REAL_WEBUI_BOOTSTRAP_DATA_ROOT=/tmp/hdsl-t004-evidence \
 *   pnpm exec vitest run tests/process/real-webui-bootstrap.evidence.test.ts --reporter=verbose
 * ```
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_VERSION, createContractRuntime } from '@hdsl/contracts';
import { createManagedInstall, generationPaths } from '@hdsl/core';
import {
  VERIFIED_COMBINATIONS,
  createCredentialInjection,
  createLaunchCredentialPort,
  createProcessManager,
  createRuntimePort,
} from '@hdsl/runtime';
import type { OsCredentialProvider } from '@hdsl/runtime';

const enabled = process.env['HDSL_REAL_WEBUI_BOOTSTRAP'] === '1';
const keep = process.env['HDSL_EVIDENCE_KEEP'] === '1';
const dataRoot =
  process.env['HDSL_REAL_WEBUI_BOOTSTRAP_DATA_ROOT'] ??
  mkdtempSync(join(tmpdir(), 'hdsl-t006-bootstrap-'));

describe.skipIf(!enabled)('real DSH WebUI bootstrap (opt-in evidence)', () => {
  it(
    'issues the dsh-auth cookie and serves an authenticated page, with a 401 negative',
    async () => {
      const managed = await createManagedInstall({
        dataRoot,
        catalog: VERIFIED_COMBINATIONS,
        runtime: createRuntimePort(),
        operationTimeoutMs: 30 * 60_000,
      });
      let summary = (() => {
        const listed = managed.service.listEnvironments();
        return listed.ok
          ? listed.value.find((environment) => environment.activeGenerationId !== null)
          : undefined;
      })();
      if (summary === undefined) {
        const contract = createContractRuntime({ port: managed.port });
        const created = contract.dispatch({
          apiVersion: API_VERSION,
          method: 'environments.create',
          input: {
            requestId: `t006-bootstrap-${String(Date.now())}`,
            name: 't006-bootstrap',
            catalogCombinationId: (VERIFIED_COMBINATIONS[0] as { id: string }).id,
          },
        });
        expect(created.ok, JSON.stringify(created)).toBe(true);
        if (!created.ok) {
          return;
        }
        await managed.waitForOperation((created.value as { operationId: string }).operationId, {
          timeoutMs: 30 * 60_000,
        });
        const listed = managed.service.listEnvironments();
        summary = listed.ok
          ? listed.value.find((environment) => environment.activeGenerationId !== null)
          : undefined;
      }
      expect(summary).toBeDefined();
      if (summary === undefined || summary.activeGenerationId === null) {
        return;
      }

      const paths = generationPaths(managed.service.layout, summary.id, summary.activeGenerationId);
      managed.service.writeEnvironmentCredentials({
        environmentId: summary.id,
        bindings: [
          {
            name: 'DEEPSEEK_API_KEY',
            reference: { id: 't006-bootstrap', store: 'keychain', key: 'hdsl-t006#account' },
          },
        ],
      });
      const provider: OsCredentialProvider = {
        store: 'keychain',
        read: () => Promise.resolve('hdsl-t006-canary-no-model-call'),
      };
      const credentials = createLaunchCredentialPort({
        load: (environmentId) => managed.service.launchCredentialRequest(environmentId),
        injection: createCredentialInjection({ provider }),
      });
      const manager = createProcessManager({ dataRoot, credentials });
      const request = {
        environmentId: summary.id,
        expectedRevision: summary.revision,
        generationDirectory: paths.generationDirectory,
        homeDirectory: paths.homeDirectory,
        configDirectory: paths.configDirectory,
        dataDirectory: paths.dataDirectory,
        nodeExecutable: join(paths.generationDirectory, 'node', 'bin', 'node'),
        dshEntrypoint: join(
          paths.generationDirectory,
          'dsh',
          'node_modules',
          '@deepseek-ai',
          'dsh',
          'lib',
          'bin.js',
        ),
        installMode: 'npm-ci' as const,
        signal: new AbortController().signal,
        port: 'auto' as const,
        onPhase: () => undefined,
      };

      const started = await manager.start(request);
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) {
        return;
      }
      const origin = started.value.loopbackOrigin;

      let bootstrapUrl: string | undefined;
      const consumed = await manager.consumeWebUIBootstrap(summary.id, (url) => {
        bootstrapUrl = url;
      });
      expect(consumed.ok, JSON.stringify(consumed)).toBe(true);
      expect(bootstrapUrl).toBeDefined();
      if (bootstrapUrl === undefined) {
        return;
      }
      expect(bootstrapUrl.startsWith(`${origin}/`)).toBe(true);
      expect(bootstrapUrl).toContain('?token=');

      const tokenResponse = await fetch(bootstrapUrl, { redirect: 'manual' });
      const setCookie = tokenResponse.headers.get('set-cookie') ?? '';
      const noCookie = await fetch(origin);
      const cookie = setCookie.split(';')[0] ?? '';
      const authenticated = cookie.length > 0 ? await fetch(origin, { headers: { cookie } }) : undefined;
      const body = authenticated === undefined ? '' : await authenticated.text();

      expect(tokenResponse.status).toBe(303);
      expect(setCookie.toLowerCase()).toContain('dsh-auth-');
      expect(noCookie.status).toBe(401);
      expect(authenticated?.status).toBe(200);
      expect(body.toLowerCase()).toContain('<html');

      // The secret is not persisted to the launch record.
      const record = manager.readLaunchRecord(summary.id);
      expect(JSON.stringify(record)).not.toContain('token=');

      const stopped = await manager.stop(request);
      expect(stopped.ok).toBe(true);
      const afterStop = await manager.consumeWebUIBootstrap(summary.id, () => undefined);
      expect(afterStop.ok).toBe(false);
      await manager.close();
      await managed.close();
      if (!keep) {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    3_600_000,
  );
});
