/**
 * OPT-IN real macOS main-flow evidence (T006 / issue #6).
 *
 * Runs the real desktop composition root — audited install, real macOS keychain
 * resolution through the strict credential port, real managed DSH process,
 * readiness, authenticated WebUI bootstrap (main-only), progress, stop and
 * diagnostics export — without Electron, so it can run headlessly on macOS.
 *
 * It creates one disposable random canary keychain item (deleted in `finally`),
 * uses an isolated data root, and never makes a model call. Run:
 *
 *   HDSL_REAL_MAIN_FLOW=1 node apps/desktop/scripts/real-main-flow-evidence.mjs
 *
 * Optional: HDSL_EVIDENCE_KEEP=1 keeps the data root; HDSL_REAL_MAIN_FLOW_DATA_ROOT
 * reuses a data root.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { portOk } from '@hdsl/contracts';
import { createDesktopComposition } from '../dist/main/composition.js';
import { applyCredentialFile } from '../dist/main/credential-import.js';
import { createVerifiedWebUiOpener } from '../dist/main/webui.js';

const enabled = process.env['HDSL_REAL_MAIN_FLOW'] === '1';
if (!enabled) {
  console.log('skipped: set HDSL_REAL_MAIN_FLOW=1 to run the real macOS main flow');
  process.exit(0);
}
if (process.platform !== 'darwin') {
  console.log('skipped: real main-flow evidence currently runs on macOS only');
  process.exit(0);
}

const KEEP = process.env['HDSL_EVIDENCE_KEEP'] === '1';
const DATA_ROOT =
  process.env['HDSL_REAL_MAIN_FLOW_DATA_ROOT'] ?? mkdtempSync(join(tmpdir(), 'hdsl-t006-flow-'));
const SECURITY = '/usr/bin/security';
const timeoutMs = 30 * 60_000;

const runSecurity = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(SECURITY, args, {
      env: { HOME: homedir(), PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('security CLI did not answer'));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });

const snapshotDshHome = () => {
  const dshHome = join(homedir(), '.dsh');
  if (!existsSync(dshHome)) {
    return [];
  }
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (entries.length >= 200) {
        return;
      }
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        entries.push(`dir:${path.replace(dshHome, '')}`);
        walk(path);
      } else {
        entries.push(`file:${path.replace(dshHome, '')}:${String(stat.size)}:${String(Math.trunc(stat.mtimeMs))}`);
      }
    }
  };
  walk(dshHome);
  return entries;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async () => {
  const canary = `hdsl-t006-canary-${randomBytes(12).toString('hex')}`;
  const service = `hdsl-t006-evidence-${randomBytes(6).toString('hex')}`;
  const account = 't006';
  const homeBefore = snapshotDshHome();
  let keychainCreated = false;
  const openedUrls = [];
  let composition;
  let pendingSummary;
  let keychainCleanup = { existedBefore: false, deleteExitCode: null, absentAfter: false };

  try {
    const add = await runSecurity(
      ['add-generic-password', '-a', account, '-s', service, '-w'],
      `${canary}\n${canary}\n`,
    );
    if (add.exitCode !== 0) {
      throw new Error(`keychain canary creation failed: ${add.stderr}`);
    }
    keychainCreated = true;

    const importFile = join(DATA_ROOT, 'credential-import.json');
    mkdirSync(DATA_ROOT, { recursive: true });
    writeFileSync(
      importFile,
      JSON.stringify(
        {
          schemaVersion: '1',
          bindings: [
            {
              name: 'DEEPSEEK_API_KEY',
              reference: { id: 't006-evidence', store: 'keychain', key: `${service}#${account}` },
            },
          ],
        },
        null,
        2,
      ),
    );
    const exportPath = join(DATA_ROOT, 'diagnostics.json');

    composition = await createDesktopComposition({
      dataRoot: DATA_ROOT,
      appInfo: {
        name: 'HDSL',
        version: '0.0.0',
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        electron: 'n/a',
      },
      openWebUi: createVerifiedWebUiOpener(async (url) => {
        openedUrls.push(url);
      }),
      pathChooser: { chooseExportPath: () => exportPath },
    });
    if (!composition.available) {
      throw new Error('data-root lease was not acquired');
    }

    const catalog = composition.port.listCatalog();
    if (!catalog.ok || catalog.value[0] === undefined) {
      throw new Error('no verified catalog combination');
    }
    const combination = catalog.value[0];

    const created = composition.port.createEnvironment({
      requestId: `t006-create-${Date.now()}`,
      name: 't006-evidence',
      combination,
    });
    if (!created.ok) {
      throw new Error(`create refused: ${created.code}`);
    }
    const createSnapshot = await composition.service.waitForOperation(created.value.operationId, {
      timeoutMs,
    });
    if (createSnapshot.status !== 'succeeded') {
      throw new Error(`create failed: ${JSON.stringify(createSnapshot)}`);
    }

    const listed = composition.port.listEnvironments();
    if (!listed.ok || listed.value[0] === undefined) {
      throw new Error('environment was not listed');
    }
    const environment = listed.value[0];

    const imported = applyCredentialFile(composition.service, environment.id, importFile);
    if (!imported.ok) {
      throw new Error(`credential import failed at ${imported.stage}`);
    }

    const refreshed = composition.port.findEnvironment(environment.id);
    if (!refreshed.ok) {
      throw new Error('environment disappeared before start');
    }

    const started = composition.port.startEnvironment({
      requestId: `t006-start-${Date.now()}`,
      environmentId: environment.id,
      expectedRevision: refreshed.value.revision,
    });
    if (!started.ok) {
      throw new Error(`start refused: ${started.code}`);
    }
    const phases = new Set();
    let startSnapshot;
    for (;;) {
      const snapshot = composition.port.findOperation(started.value.operationId);
      if (!snapshot.ok) {
        throw new Error('start operation disappeared');
      }
      phases.add(snapshot.value.phase);
      if (['succeeded', 'failed', 'cancelled'].includes(snapshot.value.status)) {
        startSnapshot = snapshot.value;
        break;
      }
      await wait(200);
    }
    if (startSnapshot.status !== 'succeeded') {
      throw new Error(`start failed: ${JSON.stringify(startSnapshot)}`);
    }
    const running = composition.port.findEnvironment(environment.id);
    if (!running.ok || running.value.state !== 'running') {
      throw new Error('environment did not reach running');
    }

    const opened = await composition.openWebUi(environment.id);
    if (!opened.ok) {
      throw new Error(`openWebUI failed: ${opened.code}`);
    }
    if (openedUrls.length !== 1 || !openedUrls[0].includes('token=')) {
      throw new Error('no token-bearing bootstrap URL was handed to the opener');
    }
    if (JSON.stringify(opened).includes('token=')) {
      throw new Error('the token URL leaked into the openWebUI result');
    }

    // Authenticated page evidence: bootstrap URL sets a cookie, then the
    // cookie-bearing origin returns the app HTML (not only a 303).
    const bootstrapResponse = await fetch(openedUrls[0], { redirect: 'manual' });
    const setCookie = bootstrapResponse.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0];
    const pageResponse = await fetch(opened.value.loopbackOrigin, {
      headers: { cookie },
      redirect: 'manual',
    });
    const pageText = await pageResponse.text();

    const launchRecordPath = join(DATA_ROOT, 'process', 'launches', `${environment.id}.json`);
    const launchRecord = existsSync(launchRecordPath)
      ? readFileSync(launchRecordPath, 'utf8')
      : '';
    if (launchRecord.includes('token=') || launchRecord.includes(canary)) {
      throw new Error('launch record contains a token or the canary');
    }

    const exported = composition.port.exportDiagnostics({
      requestId: `t006-export-${Date.now()}`,
      environmentId: environment.id,
    });
    if (!exported.ok) {
      throw new Error(`export failed: ${exported.code}`);
    }
    const diagnosticsText = readFileSync(exportPath, 'utf8');
    for (const forbidden of [canary, '.credentials.yaml', 'credentials.json', DATA_ROOT]) {
      if (diagnosticsText.includes(forbidden)) {
        throw new Error(`diagnostics export contains ${forbidden}`);
      }
    }

    const stopped = composition.port.stopEnvironment({
      requestId: `t006-stop-${Date.now()}`,
      environmentId: environment.id,
      expectedRevision: running.value.revision,
    });
    if (!stopped.ok) {
      throw new Error(`stop refused: ${stopped.code}`);
    }
    const stopSnapshot = await composition.service.waitForOperation(stopped.value.operationId, {
      timeoutMs,
    });
    if (stopSnapshot.status !== 'succeeded') {
      throw new Error(`stop failed: ${JSON.stringify(stopSnapshot)}`);
    }
    const stoppedEnv = composition.port.findEnvironment(environment.id);
    if (!stoppedEnv.ok || stoppedEnv.value.state !== 'stopped') {
      throw new Error('environment did not reach stopped');
    }

    const report = await composition.close();
    if (!report.released) {
      throw new Error('close did not release the data root lease');
    }

    const dshHomeUnchanged = JSON.stringify(snapshotDshHome()) === JSON.stringify(homeBefore);
    const summary = {
      dataRoot: DATA_ROOT,
      environmentId: environment.id,
      nodeVersion: combination.node.version,
      dshVersion: combination.dsh.version,
      credentialImport: { ok: true, count: imported.count },
      startPhases: [...phases],
      loopbackOrigin: opened.value.loopbackOrigin,
      bootstrapStatus: bootstrapResponse.status,
      cookiePresent: cookie.length > 0,
      pageStatus: pageResponse.status,
      pageBytes: pageText.length,
      launchRecordHasToken: false,
      diagnosticsExported: true,
      diagnosticsRedacted: true,
      stopSucceeded: true,
      dataRootReleased: report.released,
      dshHomeUnchanged,
    };
    pendingSummary = summary;
  } finally {
    if (composition !== undefined) {
      try {
        await composition.close();
      } catch {
        // already closed
      }
    }
    if (keychainCreated) {
      const deleted = await runSecurity(['delete-generic-password', '-a', account, '-s', service]);
      const absent = await runSecurity(['find-generic-password', '-a', account, '-s', service, '-w']);
      keychainCleanup = {
        existedBefore: false,
        deleteExitCode: deleted.exitCode,
        absentAfter: absent.exitCode === 44,
      };
    }
    if (!KEEP && process.env['HDSL_REAL_MAIN_FLOW_DATA_ROOT'] === undefined) {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    }
  }
  return { ...(pendingSummary ?? {}), keychainCleanup };
};

run()
  .then((result) => {
    console.log(`HDSL_REAL_MAIN_FLOW_EVIDENCE ${JSON.stringify(result, null, 2)}`);
    if (result.dshHomeUnchanged === false || result.keychainCleanup?.absentAfter !== true) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error(
      `HDSL_REAL_MAIN_FLOW_EVIDENCE_FAILED ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
