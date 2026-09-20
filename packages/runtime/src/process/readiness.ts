/**
 * Readiness detection for the managed DSH WebUI (T001 R004).
 *
 * Readiness is not "the port is open" and never a fixed sleep: DSH prints
 * `dsh web: http://127.0.0.1:<port>/?token=…` on stdout only after its Loader
 * tree settled. HDSL parses that line, rebuilds a canonical loopback origin
 * (dropping the token and query), and only then confirms the origin accepts a
 * loopback connection.
 *
 * The token never leaves this module: only the origin (`http(s)://127.0.0.1:port`
 * or `[::1]`) is returned or persisted.
 */
import { connect } from 'node:net';
import { isLoopbackOrigin } from '@hdsl/contracts';

export interface ReadyEndpoint {
  readonly origin: string;
  readonly host: string;
  readonly port: number;
}

/**
 * The verified ready target: the token-free origin plus the process-scoped
 * bootstrap URL that carries the upstream WebUI grant token. The bootstrap URL
 * is a secret (ADR 0002) and must never be persisted or exposed outside the
 * main process that opens it.
 */
export interface ReadyTarget extends ReadyEndpoint {
  readonly bootstrapUrl: string;
}

const READY_LINE_PATTERN = /dsh web:\s+(https?:\/\/[^\s]+)/;

const parseTarget = (output: string): ReadyTarget | undefined => {
  const match = READY_LINE_PATTERN.exec(output);
  if (match === null) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(match[1] ?? '');
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') {
    return undefined;
  }
  const host = url.hostname;
  if (host !== '127.0.0.1' && host !== '[::1]') {
    return undefined;
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  const origin = `http://${host}:${String(port)}`;
  if (!isLoopbackOrigin(origin)) {
    return undefined;
  }
  return { origin, host, port, bootstrapUrl: url.toString() };
};

/** Parses the upstream ready line into a canonical, token-free loopback origin. */
export const parseReadyEndpoint = (output: string): ReadyEndpoint | undefined => {
  const target = parseTarget(output);
  return target === undefined
    ? undefined
    : { origin: target.origin, host: target.host, port: target.port };
};

/**
 * Parses the ready line including the bootstrap URL. Only the runtime's
 * main-only bootstrap path may consume the returned URL.
 */
export const parseReadyTarget = (output: string): ReadyTarget | undefined => parseTarget(output);

/** Canonical loopback origin for a verified endpoint (no token/query). */
export const isManagedLoopbackOrigin = (origin: string): boolean => isLoopbackOrigin(origin);

/** Single loopback TCP connect with a bounded timeout. */
export const probeLoopbackTcp = (
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    const address = host === '[::1]' ? '::1' : host;
    const socket = connect({ host: address, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(Math.max(1, timeoutMs), () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
