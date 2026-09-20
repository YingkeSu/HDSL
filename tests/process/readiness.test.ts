import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReadyEndpoint, parseReadyTarget, probeLoopbackTcp } from '@hdsl/runtime';

describe('readiness parsing', () => {
  it('parses the upstream ready line into a token-free canonical loopback origin', () => {
    const endpoint = parseReadyEndpoint(
      'some log\ndsh web: http://127.0.0.1:53123/?token=super-secret-value\nmore\n',
    );
    expect(endpoint).toEqual({ origin: 'http://127.0.0.1:53123', host: '127.0.0.1', port: 53123 });
    expect(JSON.stringify(endpoint)).not.toContain('super-secret-value');
  });

  it('accepts the IPv6 loopback form', () => {
    const endpoint = parseReadyEndpoint('dsh web: http://[::1]:42000/?token=x');
    expect(endpoint).toEqual({ origin: 'http://[::1]:42000', host: '[::1]', port: 42000 });
  });

  it('rejects a non-loopback host', () => {
    expect(parseReadyEndpoint('dsh web: http://0.0.0.0:53123/?token=x')).toBeUndefined();
    expect(parseReadyEndpoint('dsh web: http://example.com:53123/?token=x')).toBeUndefined();
  });

  it('rejects a non-canonical or out-of-range port', () => {
    expect(parseReadyEndpoint('dsh web: http://127.0.0.1:00080/?token=x')).toBeUndefined();
    expect(parseReadyEndpoint('dsh web: http://127.0.0.1:0/?token=x')).toBeUndefined();
    expect(parseReadyEndpoint('dsh web: http://127.0.0.1:99999/?token=x')).toBeUndefined();
  });

  it('rejects URL credentials', () => {
    expect(parseReadyEndpoint('dsh web: http://user:pass@127.0.0.1:53123/?token=x')).toBeUndefined();
  });

  it('returns undefined when the line is absent', () => {
    expect(parseReadyEndpoint('nothing here')).toBeUndefined();
  });
});

describe('bootstrap target parsing', () => {
  it('keeps the process-scoped bootstrap URL alongside the token-free origin', () => {
    const target = parseReadyTarget(
      'dsh web: http://127.0.0.1:53123/?token=process-scoped-grant\n',
    );
    expect(target?.origin).toBe('http://127.0.0.1:53123');
    expect(target?.bootstrapUrl).toBe('http://127.0.0.1:53123/?token=process-scoped-grant');
  });

  it('rejects a non-loopback bootstrap host', () => {
    expect(parseReadyTarget('dsh web: http://example.com:53123/?token=x')).toBeUndefined();
  });

  it('rejects URL credentials and non-http schemes', () => {
    expect(parseReadyTarget('dsh web: http://user:pass@127.0.0.1:53123/?token=x')).toBeUndefined();
    expect(parseReadyTarget('dsh web: file://127.0.0.1:53123/?token=x')).toBeUndefined();
  });

  it('rejects a non-canonical or out-of-range port', () => {
    expect(parseReadyTarget('dsh web: http://127.0.0.1:00080/?token=x')).toBeUndefined();
    expect(parseReadyTarget('dsh web: http://127.0.0.1:0/?token=x')).toBeUndefined();
  });
});

describe('loopback probe', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  const listen = async (): Promise<number> =>
    new Promise((resolve) => {
      const server = createServer();
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address === 'object' && address !== null) {
          resolve(address.port);
        }
      });
    });

  it('resolves true for a listening loopback port', async () => {
    const port = await listen();
    await expect(probeLoopbackTcp('127.0.0.1', port, 1_000)).resolves.toBe(true);
  });

  it('resolves false for a closed port', async () => {
    const port = await listen();
    await new Promise<void>((resolve) => {
      servers.pop()?.close(() => {
        resolve();
      });
    });
    await expect(probeLoopbackTcp('127.0.0.1', port, 500)).resolves.toBe(false);
  });
});
