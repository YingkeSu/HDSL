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
  | 'reset';

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
  close(): Promise<void>;
}

export const startLocalEndpoint = async (
  routes: readonly RouteFixture[],
): Promise<LocalEndpoint> => {
  const byPath = new Map(routes.map((route) => [route.path, route]));
  const requests: RequestLog[] = [];

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
    const mode = route.mode ?? 'full';
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
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections?.();
    },
  };
};
