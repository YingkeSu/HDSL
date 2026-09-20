/**
 * Controlled local download endpoint (loopback only).
 *
 * The QA suite never reaches the real network: it serves fixture tarballs from
 * an ephemeral `127.0.0.1` HTTP server and points the catalog URLs at it. Route
 * modes let the same harness reproduce a clean download, a mid-stream
 * interruption, and a content/digest mismatch without inventing transport
 * behavior inside the launcher.
 *
 * This is real HTTP I/O over a real socket; only the *artifact content* is
 * synthetic. The endpoint records every request so a test can assert, for
 * example, that a failed download did not silently retry forever or that a
 * digest mismatch still consumed exactly one full body.
 */
import { createServer, type Server } from 'node:http';

export type ServeMode =
  /** Send the full body and close cleanly. */
  | 'full'
  /** Announce the full length, send half, then reset the socket. */
  | 'truncate'
  /** Accept the request and reset the socket before sending a body. */
  | 'reset'
  /** Send the full body in two delayed halves, to force interleaving. */
  | 'slow'
  /** Truncate only the first request to this path; serve full afterwards. */
  | 'fail-first'
  /** Send headers, then wait for an explicit `release(path)` before the body. */
  | 'hold';

export interface RouteFixture {
  readonly path: string;
  readonly body: Buffer;
  readonly mode?: ServeMode;
}

export interface RequestLog {
  readonly path: string;
  bytesSent: number;
  completed: boolean;
}

export interface LocalEndpoint {
  readonly origin: string;
  url(path: string): string;
  readonly requests: readonly RequestLog[];
  /** Resolves once a request for `path` has arrived (held or otherwise). */
  waitForRequest(path: string, timeoutMs?: number): Promise<void>;
  /** Releases a route served in `hold` mode. */
  release(path: string): void;
  close(): Promise<void>;
}

export const startLocalEndpoint = async (
  routes: readonly RouteFixture[],
): Promise<LocalEndpoint> => {
  const byPath = new Map(routes.map((route) => [route.path, route]));
  const requests: RequestLog[] = [];
  const failFirstSeen = new Set<string>();
  const held = new Map<string, () => void>();
  const delayMs = 60;

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    const route = byPath.get(path);
    const log: RequestLog = { path, bytesSent: 0, completed: false };
    requests.push(log);
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    let mode = route.mode ?? 'full';
    if (mode === 'fail-first') {
      mode = failFirstSeen.has(path) ? 'full' : 'truncate';
      failFirstSeen.add(path);
    }
    if (mode === 'reset') {
      response.destroy();
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': String(route.body.length),
    });
    if (mode === 'truncate') {
      const half = Math.floor(route.body.length / 2);
      const chunk = route.body.subarray(0, half);
      log.bytesSent += chunk.length;
      response.write(chunk);
      // Destroy instead of end(): the client sees a premature close while the
      // advertised Content-Length promises more bytes.
      response.destroy();
      return;
    }
    if (mode === 'slow') {
      const half = Math.floor(route.body.length / 2);
      log.bytesSent += half;
      response.write(route.body.subarray(0, half));
      setTimeout(() => {
        const rest = route.body.subarray(half);
        log.bytesSent += rest.length;
        response.end(rest, () => {
          log.completed = true;
        });
      }, delayMs);
      return;
    }
    if (mode === 'hold') {
      // Headers are already sent, so the client's fetch resolved and its body
      // reader is blocked. The test decides exactly when the transfer ends.
      held.set(path, () => {
        log.bytesSent += route.body.length;
        response.end(route.body, () => {
          log.completed = true;
        });
      });
      return;
    }
    log.bytesSent += route.body.length;
    response.end(route.body, () => {
      log.completed = true;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('local endpoint did not bind to a TCP port');
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    url: (path: string) => `${origin}${path.startsWith('/') ? path : `/${path}`}`,
    requests,
    waitForRequest: async (path: string, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (requests.some((entry) => entry.path === path)) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(`no request observed for ${path} within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    },
    release: (path: string) => {
      const send = held.get(path);
      if (send === undefined) {
        throw new Error(`route ${path} is not held`);
      }
      held.delete(path);
      send();
    },
    close: async () => {
      for (const send of [...held.values()]) {
        send();
      }
      held.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections?.();
    },
  };
};
