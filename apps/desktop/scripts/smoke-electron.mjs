/**
 * Bounded macOS Electron smoke check (T006 / issue #6).
 *
 * Launches the built desktop app against a disposable data root and user-data
 * dir with a free CDP port, then evaluates a few assertions in the real
 * renderer through the Chrome DevTools Protocol:
 *  - the sandboxed preload exposed `window.hdsl` with only the three bridge
 *    members;
 *  - `window.require`, `window.process` and `window.ipcRenderer` are absent;
 *  - the React app mounted (the root element rendered content).
 *
 * It is a launch/steering aid for local acceptance and for QA, not a substitute
 * for the independent E2E suite. It never creates an environment or starts a
 * managed process.
 *
 * Usage (after `pnpm run build:desktop`):
 *   node apps/desktop/scripts/smoke-electron.mjs [--data-root <dir>] [--keep]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const executableIndex = process.argv.indexOf('--executable');
const packagedExecutable = executableIndex < 0 ? undefined : process.argv[executableIndex + 1];
if (executableIndex >= 0 && !packagedExecutable) throw new Error('--executable requires a path');
const electronPath = packagedExecutable ?? require('electron');
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const dataRootIndex = args.indexOf('--data-root');
const ownedRoot = dataRootIndex < 0;
const dataRoot =
  dataRootIndex >= 0 && args[dataRootIndex + 1] !== undefined
    ? args[dataRootIndex + 1]
    : mkdtempSync(join(tmpdir(), 'hdsl-smoke-'));
const userData = mkdtempSync(join(tmpdir(), 'hdsl-smoke-userdata-'));

const freePort = async () =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchTargets = async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    return await response.json();
  } catch {
    return [];
  }
};

const evaluate = async (webSocketDebuggerUrl, expression) =>
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('CDP evaluate timed out'));
    }, 5000);
    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }),
      );
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) {
        return;
      }
      clearTimeout(timer);
      socket.close();
      if (message.error !== undefined) {
        reject(new Error(JSON.stringify(message.error)));
        return;
      }
      resolve(message.result?.result?.value);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP socket error'));
    });
  });

const port = await freePort();
const child = spawn(
  electronPath,
  [
    ...(packagedExecutable === undefined ? [appRoot] : []),
    '--hdsl-data-root',
    dataRoot,
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${port}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});
const exited = new Promise((resolve) => {
  child.once('exit', resolve);
});

const killChild = async () => {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(2000)]);
  }
};

const finish = async (code, result) => {
  await killChild();
  if (ownedRoot && !keep) {
    rmSync(dataRoot, { recursive: true, force: true });
  }
  if (!keep) {
    rmSync(userData, { recursive: true, force: true });
  }
  console.log(JSON.stringify(result, null, 2));
  if (output.trim() !== '') {
    console.log('--- electron output ---');
    console.log(output.trim());
  }
  process.exit(code);
};

try {
  let target;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const targets = await fetchTargets(port);
    target = targets.find((entry) => entry.type === 'page');
    if (target !== undefined) {
      break;
    }
    if (child.exitCode !== null) {
      await finish(1, { ok: false, reason: `electron exited early (code ${String(child.exitCode)})` });
    }
    await delay(500);
  }
  if (target === undefined) {
    await finish(1, { ok: false, reason: 'no renderer page target appeared' });
  }
  // Give React a moment to mount after the document loads.
  await delay(1500);
  const bridgeShape = await evaluate(
    target.webSocketDebuggerUrl,
    "JSON.stringify({ hasBridge: typeof window.hdsl === 'object' && window.hdsl !== null, members: window.hdsl ? Object.keys(window.hdsl).sort() : [], hasRequire: typeof window.require !== 'undefined', hasProcess: typeof window.process !== 'undefined', hasIpc: typeof window.ipcRenderer !== 'undefined' })",
  );
  const rootLength = await evaluate(
    target.webSocketDebuggerUrl,
    "(document.getElementById('root')?.textContent ?? '').length",
  );
  const parsed = JSON.parse(bridgeShape);
  const ok =
    parsed.hasBridge === true &&
    parsed.hasRequire === false &&
    parsed.hasProcess === false &&
    parsed.hasIpc === false &&
    typeof rootLength === 'number' &&
    rootLength > 0 &&
    parsed.members.join(',') ===
      'call,onEnvironmentUpdated,onOperationUpdated,selectEnvironment';
  await finish(ok ? 0 : 1, {
    ok,
    dataRoot,
    bridge: parsed,
    rootTextLength: rootLength,
  });
} catch (error) {
  await finish(1, { ok: false, reason: error instanceof Error ? error.message : String(error) });
}
