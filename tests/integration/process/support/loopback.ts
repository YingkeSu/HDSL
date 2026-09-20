/**
 * Real loopback listeners for process QA.
 *
 * The managed DSH binds a loopback HTTP port and reports a readiness URL. These
 * helpers allocate a real ephemeral port, occupy it to force a conflict, detect
 * whether a port is bound, and issue a bounded HTTP probe — all on `127.0.0.1`
 * only. Nothing here binds a non-loopback interface.
 */
import { connect, createServer, type Server } from 'node:net';
import { request as httpRequest } from 'node:http';

export interface OccupiedPort {
  readonly port: number;
  close(): Promise<void>;
}

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        resolve(address.port);
      } else {
        reject(new Error('listener has no TCP address'));
      }
    });
  });

/** Allocates and immediately releases a free loopback port. */
export const getFreeLoopbackPort = async (): Promise<number> => {
  const server = createServer();
  const port = await listen(server, 0);
  await closeServer(server);
  return port;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

/** Holds a loopback port open so a second bind fails with EADDRINUSE. */
export const occupyLoopbackPort = async (port = 0): Promise<OccupiedPort> => {
  const server = createServer();
  const boundPort = await listen(server, port);
  return { port: boundPort, close: () => closeServer(server) };
};

/** True when the port currently accepts a loopback TCP connection. */
export const isLoopbackPortBound = async (port: number, timeoutMs = 500): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const finish = (bound: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(bound);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

export interface HttpProbeResult {
  readonly status: number;
  readonly body: string;
}

/** Bounded HTTP GET against a loopback URL; rejects on timeout or transport error. */
export const httpProbe = (url: string, timeoutMs = 2_000): Promise<HttpProbeResult> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP probe timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
