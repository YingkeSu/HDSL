/**
 * Streaming download with an explicit size ceiling and injected faults.
 *
 * Failures map to `DOWNLOAD_FAILED`; the caller verifies the SHA-256 afterwards
 * and maps a byte mismatch to `DIGEST_MISMATCH`. A declared `content-length`
 * that the stream does not deliver is treated as a truncated download, so an
 * interrupted transfer can never be mistaken for success.
 */
import { open } from 'node:fs/promises';
import { InstallFailure } from './failure.js';

export type FetchLike = (input: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;

export interface DownloadOptions {
  readonly fetch: FetchLike;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
  /** Aborts after this many received bytes; used by the injected fault harness. */
  readonly failAfterBytes?: number;
}

const redactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return 'the artifact URL';
  }
};

export const downloadToFile = async (
  url: string,
  destination: string,
  options: DownloadOptions,
): Promise<number> => {
  let response: Response;
  try {
    response = await options.fetch(url, { signal: options.signal });
  } catch {
    throw new InstallFailure('DOWNLOAD_FAILED', `could not download from ${redactUrl(url)}`);
  }
  if (!response.ok) {
    throw new InstallFailure('DOWNLOAD_FAILED', `download from ${redactUrl(url)} failed with HTTP ${String(response.status)}`);
  }
  const body = response.body;
  if (body === null) {
    throw new InstallFailure('DOWNLOAD_FAILED', 'the download response had no body');
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  const handle = await open(destination, 'w');
  let total = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch {
        throw new InstallFailure('DOWNLOAD_FAILED', 'the download was interrupted');
      }
      if (step.done === true) {
        break;
      }
      const chunk = step.value;
      if (chunk === undefined) {
        continue;
      }
      total += chunk.byteLength;
      if (total > options.maxBytes) {
        throw new InstallFailure('DOWNLOAD_FAILED', 'the download exceeded the configured size limit');
      }
      if (options.failAfterBytes !== undefined && total >= options.failAfterBytes) {
        throw new InstallFailure('DOWNLOAD_FAILED', 'the download was interrupted (injected fault)');
      }
      await handle.write(chunk);
      if (options.signal.aborted) {
        throw new InstallFailure('DOWNLOAD_FAILED', 'the download was cancelled');
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (declared > 0 && total !== declared) {
    throw new InstallFailure('DOWNLOAD_FAILED', 'the download was truncated');
  }
  return total;
};
