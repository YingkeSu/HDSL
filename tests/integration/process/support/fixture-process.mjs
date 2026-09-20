#!/usr/bin/env node
/**
 * Deterministic, self-identifying fixture process for process-lifecycle QA.
 *
 * This is a *test fixture*, not launcher behavior. It models the external
 * contract a managed DSH process presents (a PID, a readiness signal, a
 * loopback listener, SIGTERM shutdown, an optionally orphaned grandchild, and a
 * crash that leaves a tree behind) so the T005 QA can be driven against
 * something real without installing DSH or calling a model.
 *
 * Safety rules encoded here:
 * - Every process carries `HDSL_QA_PROC_TOKEN` in its own environment *and* in
 *   its command line, so a QA cleanup can verify identity before signalling.
 * - The process writes its PID + `ps lstart` start time + token to a record
 *   file before becoming ready; `support/identity.ts` refuses to signal a PID
 *   whose start time or token does not match.
 * - The fixture never reads or writes the host HOME. All paths come from argv.
 *
 * Modes:
 *   hold         become ready, then wait. SIGTERM stops the grandchild (if any)
 *                and exits 0.
 *   stubborn     like hold, but SIGTERM/SIGINT are ignored and counted in
 *                `<record>.<label>.signals`. Only SIGKILL stops it.
 *   crash        become ready, then `process.exit(exitCode)` *without* stopping
 *                the grandchild: a deliberate orphan for ownership/restart QA.
 *   never-ready  start and wait, but never write the ready file.
 *   bind         listen on loopback (`--port`, 0 = ephemeral), write the ready
 *                file with `url=`, then wait. A port already in use exits 40
 *                with `EADDRINUSE` on stderr.
 *
 * Usage (normally through `support/spawn-fixture.ts`):
 *   HDSL_QA_PROC_TOKEN=... node fixture-process.mjs \
 *     --role parent --mode hold --label case-1 \
 *     --record-dir <dir> --ready-file <file> --grandchild 1
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const READY_MARKER = 'HDSL_QA_READY';

const parseArgs = (argv) => {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === undefined || !key.startsWith('--')) {
      continue;
    }
    const name = key.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      out[name] = '1';
    } else {
      out[name] = next;
      index += 1;
    }
  }
  return out;
};

const args = parseArgs(process.argv.slice(2));
// A managed-DSH invocation (`node <entrypoint> web --no-open ...`) does not
// receive the QA token from the launcher; identity for those scenarios comes
// from the launcher's own record (pid + kernel start token + fragment).
const isDshWeb = process.argv.includes('web');
// The token appears in argv as well as the environment: `ps` exposes the
// command line but not the environment, and identity verification needs a
// value an unrelated process cannot accidentally share.
const token =
  args.token ?? process.env.HDSL_QA_PROC_TOKEN ?? (isDshWeb ? `hdsl-qa-dsh-${String(process.pid)}` : undefined);
if (!token) {
  process.stderr.write('HDSL_QA_PROC_TOKEN (or --token) is required\n');
  process.exit(64);
}

const role = args.role ?? 'parent';
const mode = args.mode ?? 'hold';
const label = (args.label ?? 'default').replace(/[^a-z0-9-]/gi, '-');
const recordDir = args['record-dir'] ?? process.cwd();
const readyFile = args['ready-file'];
const spawnGrandchild = args.grandchild === '1';
const exitCode = Number(args['exit-code'] ?? 3);
const bindPort = args.port === undefined ? undefined : Number(args.port);
const recordEnv = args['record-env'] === '1';

mkdirSync(recordDir, { recursive: true });

const startTime = (() => {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
})();

const recordPath = join(recordDir, `${role}-${label}.json`);
const signalPath = join(recordDir, `${role}-${label}.signals`);

const writeAtomic = (path, contents) => {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
};

let grandchildPid;
let grandchildProcess;

const record = {
  token,
  role,
  mode,
  label,
  pid: process.pid,
  ppid: process.ppid,
  execPath: process.execPath,
  argv: process.argv.slice(2),
  startedAt: Date.now(),
  startTime,
};

if (recordEnv) {
  record.env = {
    HOME: process.env.HOME,
    DSH_HOME: process.env.DSH_HOME,
    HDSL_DATA_ROOT: process.env.HDSL_DATA_ROOT,
  };
}

const persistRecord = () => writeAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
// DSH-mode children are spawned by the launcher with cwd under the managed
// root; they must not drop a non-DSH record into the current directory.
if (!isDshWeb) {
  persistRecord();
}

const waitForFile = async (path, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
};

const stopGrandchild = (signal = 'SIGTERM') => {
  if (grandchildProcess === undefined || grandchildProcess.exitCode !== null) {
    return;
  }
  try {
    // We spawned this child ourselves; sending the signal directly is exact
    // ownership, not a PID guess.
    grandchildProcess.kill(signal);
  } catch {
    // already gone
  }
};

const spawnChildFixture = async () => {
  const grandchildLabel = `${label}-g`;
  const childArgs = [
    SCRIPT,
    '--role',
    'grandchild',
    '--mode',
    'hold',
    '--label',
    grandchildLabel,
    '--record-dir',
    recordDir,
    '--token',
    token,
  ];
  if (args['grandchild-stubborn'] === '1') {
    childArgs.push('--mode', 'stubborn');
  }
  grandchildProcess = spawn(process.execPath, childArgs, {
    env: { HDSL_QA_PROC_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  grandchildProcess.stdout.on('data', () => {});
  grandchildProcess.stderr.on('data', () => {});
  const grandchildRecord = join(recordDir, `grandchild-${grandchildLabel}.json`);
  const appeared = await waitForFile(grandchildRecord, 10_000);
  if (!appeared) {
    process.stderr.write('grandchild did not record readiness\n');
    process.exit(65);
  }
  grandchildPid = JSON.parse(readFileSync(grandchildRecord, 'utf8')).pid;
  record.grandchildPid = grandchildPid;
  persistRecord();
  grandchildProcess.stdout.destroy();
  grandchildProcess.stderr.destroy();
  grandchildProcess.unref();
};

const ready = async () => {
  if (mode === 'never-ready' || readyFile === undefined) {
    return;
  }
  if (mode === 'bind') {
    return;
  }
  writeAtomic(readyFile, `ready\n`);
  if (role !== 'grandchild') {
    process.stdout.write(`${READY_MARKER} ${process.pid}\n`);
  }
};

const startBoundServer = () =>
  new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on('data', () => {
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
      });
    });
    server.on('error', (error) => {
      process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
      process.exit(40);
    });
    server.listen(bindPort ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      record.boundPort = port;
      persistRecord();
      if (readyFile !== undefined) {
        writeAtomic(readyFile, `url=http://127.0.0.1:${port}\nport=${port}\n`);
      }
      if (role !== 'grandchild') {
        process.stdout.write(`${READY_MARKER} ${process.pid} port=${port}\n`);
      }
      resolve(server);
    });
  });

const bumpSignal = (name) => {
  const previous = existsSync(signalPath) ? JSON.parse(readFileSync(signalPath, 'utf8')) : {};
  previous[name] = (previous[name] ?? 0) + 1;
  previous.lastAt = Date.now();
  writeAtomic(signalPath, `${JSON.stringify(previous)}\n`);
};

const installTermination = (ignore) => {
  const onSignal = (name) => {
    bumpSignal(name);
    if (ignore) {
      return;
    }
    stopGrandchild('SIGTERM');
    // Give the grandchild a beat to exit, then leave. The harness verifies the
    // tree is gone with identity-checked liveness reads, not by timing.
    setTimeout(() => process.exit(0), 50);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
};

const readDshFlag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

/**
 * DSH-compatible managed mode: mirrors the observable contract the launcher's
 * process manager depends on (`dsh web: http://127.0.0.1:<port>/?token=...` on
 * stdout, loopback bind, SIGTERM shutdown, EADDRINUSE, grandchild). It is a QA
 * fixture and is never cited as evidence that real DSH ran.
 */
const runDshWeb = async () => {
  const host = readDshFlag('--host', '127.0.0.1');
  const portArgument = Number(readDshFlag('--port', '0'));
  const generation = readDshFlag('--generation', undefined);
  const dshMode = process.env.HDSL_QA_DSH_MODE ?? 'ready';
  const noGrandchild = process.env.HDSL_QA_NO_GRANDCHILD === '1';
  // The launcher's credential port never lets us pick a path, so default the
  // info file under the managed HOME when no explicit path was injected.
  const infoFile =
    process.env.HDSL_QA_INFO_FILE ??
    (process.env.HOME !== undefined ? join(process.env.HOME, '.hdsl-qa-fixture.json') : undefined);

  let grandchild;
  if (!noGrandchild) {
    grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  }

  const info = {
    pid: process.pid,
    grandchildPid: grandchild?.pid ?? null,
    home: process.env.HOME ?? null,
    dshHome: process.env.DSH_HOME ?? null,
    mode: dshMode,
    generation: generation ?? null,
    receivedTerm: false,
    canary: {
      name: 'DSH_QA_CANARY',
      present: (process.env.DSH_QA_CANARY ?? '').length > 0,
      sha256:
        (process.env.DSH_QA_CANARY ?? '').length > 0
          ? createHash('sha256').update(process.env.DSH_QA_CANARY ?? '').digest('hex')
          : null,
    },
    hostLeak: process.env.__HDSL_HOST_LEAK__ ?? null,
    managedEnv: {
      HOME: process.env.HOME ?? null,
      DSH_HOME: process.env.DSH_HOME ?? null,
      DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? null,
      PATH: process.env.PATH ?? null,
      TMPDIR: process.env.TMPDIR ?? null,
    },
  };
  const writeInfo = (extra = {}) => {
    if (infoFile === undefined) {
      return;
    }
    try {
      writeFileSync(infoFile, `${JSON.stringify({ ...info, ...extra }, null, 2)}\n`);
    } catch {
      // best effort
    }
  };
  writeInfo();

  const stopGrandchild = () => {
    try {
      grandchild?.kill('SIGKILL');
    } catch {
      // already gone
    }
  };

  const server = createHttpServer((request, response) => {
    response.statusCode = 200;
    response.end('ok');
  });
  server.on('error', (error) => {
    process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
    process.exit(40);
  });

  const onReady = () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    writeInfo({ boundPort: port });
    if (dshMode === 'never-ready') {
      return;
    }
    process.stdout.write(`dsh web: http://${host}:${port}/?token=hdsl-qa-${String(process.pid)}\n`);
    if (dshMode === 'crash') {
      // `HDSL_QA_DSH_CRASH_ORPHAN=1` abandons the grandchild (the real crash
      // shape the launcher must reap); without it the fixture cleans up first.
      if (process.env.HDSL_QA_DSH_CRASH_ORPHAN !== '1') {
        stopGrandchild();
      }
      process.exit(Number(process.env.HDSL_QA_DSH_EXIT ?? '3'));
    }
  };

  const shutdown = (signal) => ({
    close: () => {
      writeInfo({ receivedTerm: true });
      stopGrandchild();
      server.close();
      process.exit(signal === 'SIGTERM' ? 0 : 130);
    },
  });
  if (dshMode === 'stubborn') {
    process.on('SIGTERM', () => {
      writeInfo({ receivedTerm: true, stubborn: true });
    });
  } else {
    process.on('SIGTERM', () => shutdown('SIGTERM').close());
    process.on('SIGINT', () => shutdown('SIGINT').close());
  }

  server.listen(portArgument, host, onReady);
  setInterval(() => {}, 1_000);
};

const main = async () => {
  if (role === 'grandchild') {
    // A grandchild never nests further and never writes a ready file of its
    // own; its record file is the readiness signal.
    if (mode === 'stubborn') {
      installTermination(true);
    } else {
      installTermination(false);
    }
    setInterval(() => {}, 1_000);
    return;
  }

  if (spawnGrandchild) {
    await spawnChildFixture();
  }

  if (mode === 'bind') {
    installTermination(false);
    await startBoundServer();
    return;
  }

  await ready();

  if (mode === 'stubborn') {
    installTermination(true);
  } else {
    installTermination(false);
  }

  if (mode === 'crash') {
    // Deliberately abandon the grandchild: the whole point of this fixture.
    // Nudge it to keep running independently, then exit.
    process.exit(exitCode);
  }

  setInterval(() => {}, 1_000);
};

if (isDshWeb) {
  runDshWeb().catch((error) => {
    process.stderr.write(`fixture failure: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(70);
  });
} else {
  main().catch((error) => {
    process.stderr.write(`fixture failure: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(70);
  });
}
