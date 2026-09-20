#!/usr/bin/env node
/**
 * Controlled stand-in for the real DSH CLI, used only by T005 process tests.
 *
 * It reproduces the observable contract the process lifecycle depends on:
 * - accepts `web --no-open --host <h> --port <p>`;
 * - prints `dsh web: http://<host>:<port>/?token=…` only after the HTTP server
 *   is listening (real readiness is verified by a loopback connect, not a
 *   sleep);
 * - exits non-zero with `EADDRINUSE` when the requested port is taken;
 * - spawns a grandchild so whole-tree termination is observable;
 * - exits 0 on SIGTERM.
 *
 * It is never cited as evidence for the real DSH; that is the opt-in
 * `real-process.evidence.test.ts` run against a real audited install.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const host = readFlag('--host', '127.0.0.1');
const portArgument = readFlag('--port', '0');
const mode = process.env.FAKE_DSH_MODE ?? 'ready';

// A grandchild that stays in this process' group unless the launcher spawned us
// detached; group termination must reach it.
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
  stdio: 'ignore',
});
// A failed grandchild spawn (for example EAGAIN under CI load) must not crash
// the fixture: an unhandled 'error' event would exit this process and turn a
// readiness-timeout scenario into a spurious early exit.
grandchild.on('error', () => {
  // observed through info.grandchildPid === null
});

const info = {
  grandchildPid: grandchild.pid ?? null,
  mode,
};
const infoFile = process.env.FAKE_DSH_INFO_FILE;
const writeInfo = (extra = {}) => {
  if (infoFile === undefined) {
    return;
  }
  try {
    writeFileSync(
      infoFile,
      `${JSON.stringify(
        {
          ...info,
          ...extra,
          pid: process.pid,
          hasCredential: (process.env.DEEPSEEK_API_KEY ?? '').length > 0,
          home: process.env.HOME ?? null,
          dshHome: process.env.DSH_HOME ?? null,
          path: process.env.PATH ?? null,
          tmpdir: process.env.TMPDIR ?? null,
          hostLeak: process.env.__HDSL_HOST_LEAK__ ?? null,
          receivedTerm: false,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // The test file is best effort; never fail the fake for it.
  }
};

let server;
const shutdown = (signal) => {
  writeInfo({ receivedTerm: true });
  try {
    grandchild.kill('SIGKILL');
  } catch {
    // ignore
  }
  server?.close();
  process.exit(signal === 'SIGTERM' ? 0 : 130);
};
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

if (mode === 'exit') {
  process.stderr.write('fake dsh: failing on purpose\n');
  process.exit(1);
}

writeInfo();

if (mode === 'never-ready') {
  setInterval(() => {}, 1 << 30);
} else {
  server = http.createServer((_request, response) => {
    response.statusCode = 401;
    response.end('unauthorized');
  });
  server.on('error', (error) => {    process.stderr.write(`fake dsh listen error: ${error.code}\n`);
    try {
      grandchild.kill('SIGKILL');
    } catch {
      // ignore
    }
    process.exit(1);
  });
  server.listen(Number(portArgument), host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : Number(portArgument);
    process.stdout.write(`dsh web: http://${host}:${String(port)}/?token=${'t'.repeat(40)}\n`);
    writeInfo({ ready: true, port });
    const exitAfter = Number(process.env.FAKE_DSH_EXIT_AFTER_READY_MS ?? '0');
    if (Number.isFinite(exitAfter) && exitAfter > 0) {
      setTimeout(() => {
        try {
          grandchild.kill('SIGKILL');
        } catch {
          // ignore
        }
        process.exit(0);
      }, exitAfter);
    }
  });
}
