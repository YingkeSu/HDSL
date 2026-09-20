/**
 * Installed-Chrome launcher for the isolated real-browser lane.
 *
 * The lane uses the system Chrome on a registered temporary profile with CDP.
 * It never uses the user's default profile, never enables the CDP `Network`
 * domain, and never dumps cookies. Failure text is sanitized before it is put
 * in an assertion message (review F6): token values and canary secrets are
 * removed and the result is truncated.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

import { connectCdp, type CdpClient } from './cdp.js';
import { waitFor } from './gates.js';
import type { QaResourceRegistry } from './resources.js';

export const CHROME_EXECUTABLE =
  process.env['HDSL_E2E_CHROME'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface ChromeInstance {
  readonly port: number;
  readonly pid: number;
  readonly cdp: CdpClient;
  output(): string;
  kill(): Promise<void>;
}

interface CdpTargetShape {
  readonly type?: string;
  readonly webSocketDebuggerUrl?: string;
}

const fetchTarget = async (port: number): Promise<CdpTargetShape | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json`, {
      signal: AbortSignal.timeout(2_000),
    });
    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) {
      return null;
    }
    return (
      (parsed as CdpTargetShape[]).find((entry) => entry.type === 'page') ?? null
    );
  } catch {
    return null;
  }
};

const freeLoopbackPort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

export const launchChrome = async (
  registry: QaResourceRegistry,
  label: string,
): Promise<ChromeInstance> => {
  if (!existsSync(CHROME_EXECUTABLE)) {
    throw new Error(`Chrome binary missing at ${CHROME_EXECUTABLE}`);
  }
  const profile = registry.registerTempRoot(`${label}-profile`);
  const port = await freeLoopbackPort();
  const child = spawn(
    CHROME_EXECUTABLE,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${String(port)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const kill = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  };
  registry.register(`${label}-chrome`, kill);

  await waitFor(async () => (await fetchTarget(port)) !== null, {
    timeoutMs: 30_000,
    intervalMs: 250,
    label: `${label} chrome CDP page target`,
  });
  const target = await fetchTarget(port);
  const wsUrl = target?.webSocketDebuggerUrl;
  if (typeof wsUrl !== 'string' || wsUrl === '') {
    throw new Error(`${label}: chrome CDP target has no websocket url`);
  }
  const cdp = await connectCdp(wsUrl);
  registry.register(`${label}-cdp`, () => cdp.close());
  return { port, pid: child.pid ?? -1, cdp, output: () => output, kill };
};

/** Navigates the page and waits for `predicate` to hold on the live document. */
export const navigateAndWait = async (
  cdp: CdpClient,
  url: string,
  predicate: () => Promise<boolean>,
  options: { readonly timeoutMs: number; readonly label: string },
): Promise<void> => {
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  await waitFor(predicate, { timeoutMs: options.timeoutMs, intervalMs: 250, label: options.label });
};

/** Removes token-bearing query values and known secrets, then truncates. */
export const sanitizeForReport = (
  text: string,
  secrets: readonly string[] = [],
  maxLength = 300,
): string => {
  let result = text.replace(/token=[^&\s"'<>]+/gi, 'token=<redacted>');
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join('<redacted>');
    }
  }
  return result.length <= maxLength ? result : `${result.slice(0, maxLength)}…`;
};
