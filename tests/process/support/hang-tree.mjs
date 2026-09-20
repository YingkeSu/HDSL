#!/usr/bin/env node
/**
 * Test child that spawns a grandchild in its own process group and then hangs.
 * Used to prove `runCommand` terminates the whole subtree on timeout/cancel and
 * journals a verifiable identity.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
  stdio: 'ignore',
});
// Never let a failed grandchild spawn crash the fixture (EAGAIN under CI load).
grandchild.on('error', () => {});
const pidFile = process.env.HANG_TREE_PID_FILE;
if (pidFile !== undefined && grandchild.pid !== undefined) {
  writeFileSync(pidFile, String(grandchild.pid));
}
setInterval(() => {}, 1 << 30);
