/**
 * Read-only GitHub adapter for plugin discovery (`plugins.search` /
 * `plugins.inspect`).
 *
 * Boundaries (ADR 0005 D16/D17/D19):
 * - **public, unauthenticated** GitHub reads only. It never reads a GitHub
 *   token, never sends an `Authorization` header and never inherits anything
 *   from an environment home.
 * - no plugin code is downloaded or executed; this adapter only reads JSON
 *   search/repository metadata.
 * - it returns `PortOutcome`, never a raw `@hdsl/contracts` wire envelope, and
 *   the concrete `fetch`/clock is injected so default CI runs against a
 *   controlled response and never touches the real network.
 * - a real GitHub probe is opt-in and explicitly bounded; a fixture response is
 *   not evidence about the real API (D19).
 *
 * Error mapping follows D11: 403/429 → `RATE_LIMITED` (+`retryAfterSeconds`),
 * 404 → `SOURCE_NOT_FOUND`, 422 → `INVALID_INPUT`, connection-before failure
 * (DNS/offline/TLS/timeout) → `NETWORK_UNAVAILABLE`, any other established
 * HTTP/parse failure → `DOWNLOAD_FAILED`.
 */
import {
  buildPreviewResolution,
  type GitProvider,
  type PluginPreviewResolution,
} from './preview-resolution.js';
export type { GitProvider, PluginPreviewResolution, ResolvedSourceManifest } from './preview-resolution.js';
import {
  GITHUB_SEARCH_RESULT_LIMIT,
  isPlainRecord,
  PLUGIN_SEARCH_PAGE_SIZE,
  pluginRepositoryDetailSchema,
  pluginSearchHitSchema,
  portFail,
  portOk,
  type PluginInspection,
  type PluginRepositoryDetail,
  type PluginSearchHit,
  type PluginSearchResult,
  type PluginSourceSelector,
  type PortOutcome,
  type Schema,
  type ExecutorIdentity,
} from '@hdsl/contracts';




/** Narrow fetch seam; the global `fetch` is structurally compatible. */
export type PluginFetchLike = (
  input: string,
  init?: {
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
  },
) => Promise<Response>;

export interface GitHubPluginSourceOptions {
  readonly fetch: PluginFetchLike;
  /** Default `https://api.github.com`; overridable only by tests. */
  readonly apiBase?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly pageSize?: number;
  readonly userAgent?: string;
  /** Managed executor identity bound into the plan inputs (E1); `null` until frozen. */
  readonly executor?: ExecutorIdentity | null;
  /** Test-only provider injection; the production default is public GitHub HTTPS. */
  readonly gitProvider?: GitProvider;
}

export interface GitHubPluginSource {
  search(query: string, signal: AbortSignal): Promise<PortOutcome<PluginSearchResult>>;
  inspect(
    source: PluginSourceSelector,
    signal: AbortSignal,
  ): Promise<PortOutcome<PluginInspection>>;
  /**
   * Read-only preview resolution: exact commit SHA -> manifest -> optional
   * pinned lockfile -> install-time script assessment. It never downloads or
   * executes plugin code.
   */
  previewSource(
    source: PluginSourceSelector,
    signal: AbortSignal,
  ): Promise<PortOutcome<PluginPreviewResolution>>;
  /** Exact URL of the most recent request; test/diagnostic only. */
  lastRequestUrl(): string | null;
}

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'HDSL/0.0.0 (+https://github.com/YingkeSu/HDSL)';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isPlainRecord(value) ? value : undefined;
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;
const nonEmpty = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

const asTopics = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [])
    .filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
    .slice(0, 50);

/**
 * Clips free-text display values to the contract bound. A clipped value gets a
 * visible ellipsis, so the result is never a silent truncation. Structural
 * identifiers and URLs are **not** clipped here: an out-of-bound one makes the
 * single hit fail the DTO and be dropped (reported through
 * `incompleteResults`), which preserves its meaning instead of corrupting it.
 */
const clipFreeText = (value: string | null, max: number): string | null => {
  if (value === null || value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
};

const asLicense = (value: unknown): string | null => {
  const record = asRecord(value);
  if (record === undefined) {
    return null;
  }
  const spdx = nonEmpty(asString(record['spdx_id']));
  if (spdx !== null && spdx !== 'NOASSERTION') {
    return spdx;
  }
  const name = nonEmpty(asString(record['name']));
  return name === 'NOASSERTION' ? null : name;
};

const asHomepage = (value: unknown): string | null => {
  const homepage = nonEmpty(asString(value));
  return homepage !== null && /^https?:\/\//.test(homepage) ? homepage : null;
};

const mapSearchHit = (value: unknown): PluginSearchHit | undefined => {
  const item = asRecord(value);
  if (item === undefined) {
    return undefined;
  }
  const ownerRecord = asRecord(item['owner']);
  const fullName = nonEmpty(asString(item['full_name']));
  const owner = nonEmpty(
    asString(ownerRecord?.['login']) ?? fullName?.split('/')[0],
  );
  const name = nonEmpty(asString(item['name']) ?? fullName?.split('/')[1]);
  const htmlUrl = nonEmpty(asString(item['html_url']));
  if (fullName === null || owner === null || name === null || htmlUrl === null) {
    return undefined;
  }
  const description = clipFreeText(nonEmpty(asString(item['description'])), 512);
  const defaultBranch = nonEmpty(asString(item['default_branch'])) ?? 'HEAD';
  const updatedAt = clipFreeText(nonEmpty(asString(item['updated_at'])), 64) ?? 'unknown';
  const license = clipFreeText(asLicense(item['license']), 128);
  return {
    fullName,
    owner,
    name,
    description,
    htmlUrl,
    stars: Math.max(0, Math.trunc(asNumber(item['stargazers_count']) ?? 0)),
    topics: asTopics(item['topics']),
    defaultBranch,
    updatedAt,
    archived: asBoolean(item['archived']) ?? false,
    fork: asBoolean(item['fork']) ?? false,
    license,
  };
};

const mapRepositoryDetail = (value: unknown): PluginRepositoryDetail | undefined => {
  const item = asRecord(value);
  if (item === undefined) {
    return undefined;
  }
  const fullName = nonEmpty(asString(item['full_name']));
  const htmlUrl = nonEmpty(asString(item['html_url']));
  if (fullName === null || htmlUrl === null) {
    return undefined;
  }
  return {
    fullName,
    description: clipFreeText(nonEmpty(asString(item['description'])), 512),
    htmlUrl,
    stars: Math.max(0, Math.trunc(asNumber(item['stargazers_count']) ?? 0)),
    topics: asTopics(item['topics']),
    defaultBranch: nonEmpty(asString(item['default_branch'])) ?? 'HEAD',
    updatedAt: clipFreeText(nonEmpty(asString(item['updated_at'])), 64) ?? 'unknown',
    archived: asBoolean(item['archived']) ?? false,
    fork: asBoolean(item['fork']) ?? false,
    license: clipFreeText(asLicense(item['license']), 128),
    homepage: asHomepage(item['homepage']),
  };
};

/** `pluginSearchHitSchema` is the authority; invalid hits are dropped, not trusted. */
const isValidAgainst = <T>(schema: Schema<T>, value: unknown): boolean =>
  schema(value, 'value', []) !== undefined;

/** Parses `retry-after` (seconds) or `x-ratelimit-reset` (epoch seconds). */
export const rateLimitRetryAfterSeconds = (
  headers: { get(name: string): string | null },
  nowMs: number,
): number | undefined => {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && /^\d{1,7}$/.test(retryAfter)) {
    return Number(retryAfter);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null && /^\d{1,12}$/.test(reset)) {
    return Math.max(1, Number(reset) - Math.floor(nowMs / 1000));
  }
  return undefined;
};

type Attempt =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'parsed'; readonly response: Response; readonly body: unknown }
  | { readonly kind: 'unparseable'; readonly response: Response }
  | { readonly kind: 'unreachable' };

/** Rejects as soon as the signal aborts, so a stalled body read cannot hang. */
const rejectOnAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

export const createGitHubPluginSource = (
  options: GitHubPluginSourceOptions,
): GitHubPluginSource => {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageSize = options.pageSize ?? PLUGIN_SEARCH_PAGE_SIZE;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  let lastRequestUrl: string | null = null;

  /**
   * One bounded request. The timeout and the caller's abort stay active through
   * `response.json()`, so the 15s hard deadline (and cancellation) covers the
   * whole exchange, not just the headers (ADR 0005 D12).
   */
  const attempt = async (url: string, signal: AbortSignal): Promise<Attempt> => {
    lastRequestUrl = url;
    const inner = new AbortController();
    const timer = setTimeout(() => {
      inner.abort();
    }, timeoutMs);
    const forward = (): void => {
      inner.abort();
    };
    signal.addEventListener('abort', forward, { once: true });
    try {
      const response = await options.fetch(url, {
        signal: inner.signal,
        headers: { accept: 'application/vnd.github+json', 'user-agent': userAgent },
      });
      if (!response.ok) {
        return { kind: 'response', response };
      }
      try {
        const body = await Promise.race([response.json(), rejectOnAbort(inner.signal)]);
        return { kind: 'parsed', response, body };
      } catch {
        // A real abort (deadline or caller) is a connection-level failure; a
        // body that simply is not JSON reuses the transfer-failure code.
        if (inner.signal.aborted || signal.aborted) {
          return { kind: 'unreachable' };
        }
        return { kind: 'unparseable', response };
      }
    } catch {
      return { kind: 'unreachable' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    }
  };

  const failureForStatus = (response: Response): PortOutcome<never> => {
    const status = response.status;
    if (status === 403 || status === 429) {
      const retryAfterSeconds = rateLimitRetryAfterSeconds(response.headers, now().getTime());
      return portFail(
        'RATE_LIMITED',
        `GitHub returned HTTP ${String(status)}`,
        retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
      );
    }
    if (status === 404) {
      return portFail('SOURCE_NOT_FOUND', 'GitHub returned HTTP 404');
    }
    if (status === 422) {
      return portFail('INVALID_INPUT', 'GitHub rejected the query as invalid');
    }
    return portFail('DOWNLOAD_FAILED', `GitHub returned HTTP ${String(status)}`);
  };

  return {
    async search(query, signal) {
      const url = `${apiBase}/search/repositories?q=${encodeURIComponent(query)}&per_page=${String(pageSize)}&page=1`;
      const outcome = await attempt(url, signal);
      if (outcome.kind === 'unreachable') {
        return portFail('NETWORK_UNAVAILABLE', 'the GitHub search request could not connect');
      }
      if (outcome.kind === 'response') {
        return failureForStatus(outcome.response);
      }
      if (outcome.kind === 'unparseable') {
        return portFail('DOWNLOAD_FAILED', 'the GitHub search response was not JSON');
      }
      const record = asRecord(outcome.body);
      if (record === undefined) {
        return portFail('DOWNLOAD_FAILED', 'the GitHub search response was not a JSON object');
      }
      const items = Array.isArray(record['items']) ? record['items'] : [];
      const hits: PluginSearchHit[] = [];
      let dropped = 0;
      for (const item of items) {
        const hit = mapSearchHit(item);
        if (hit === undefined || !isValidAgainst(pluginSearchHitSchema, hit)) {
          // A single out-of-bound hit must not fail the whole search; it is
          // surfaced through `incompleteResults` instead of silent loss.
          dropped += 1;
          continue;
        }
        hits.push(hit);
      }
      const totalCount = Math.max(0, Math.trunc(asNumber(record['total_count']) ?? 0));
      const reachable = Math.min(totalCount, GITHUB_SEARCH_RESULT_LIMIT);
      return portOk({
        query,
        hits,
        totalCount,
        incompleteResults: (asBoolean(record['incomplete_results']) ?? false) || dropped > 0,
        hasMore: hits.length < reachable,
        fetchedAt: now().toISOString(),
        fromCache: false,
      });
    },

    async inspect(source, signal) {
      const url = `${apiBase}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.name)}`;
      const outcome = await attempt(url, signal);
      if (outcome.kind === 'unreachable') {
        return portFail('NETWORK_UNAVAILABLE', 'the GitHub repository request could not connect');
      }
      if (outcome.kind === 'response') {
        return failureForStatus(outcome.response);
      }
      if (outcome.kind === 'unparseable') {
        return portFail('DOWNLOAD_FAILED', 'the GitHub repository response was not JSON');
      }
      const repository = mapRepositoryDetail(outcome.body);
      if (repository === undefined || !isValidAgainst(pluginRepositoryDetailSchema, repository)) {
        return portFail('DOWNLOAD_FAILED', 'the GitHub repository response was malformed');
      }
      return portOk({
        source,
        repository,
        fetchedAt: now().toISOString(),
        fromCache: false,
      });
    },


    async previewSource(source, signal) {
      if (options.gitProvider !== undefined) {
        const resolved = await options.gitProvider.resolveManifest(source, signal);
        return resolved.ok
          ? buildPreviewResolution({ source, resolved: resolved.value, executor: options.executor ?? null })
          : resolved;
      }
      const owner = encodeURIComponent(source.owner);
      const name = encodeURIComponent(source.name);
      const commitsUrl =
        source.ref === undefined
          ? `${apiBase}/repos/${owner}/${name}/commits?per_page=1`
          : `${apiBase}/repos/${owner}/${name}/commits/${encodeURIComponent(source.ref)}`;
      const commitAttempt = await attempt(commitsUrl, signal);
      if (commitAttempt.kind === 'unreachable') {
        return portFail('NETWORK_UNAVAILABLE', 'the GitHub commit request could not connect');
      }
      if (commitAttempt.kind === 'response') {
        return failureForStatus(commitAttempt.response);
      }
      if (commitAttempt.kind === 'unparseable') {
        return portFail('DOWNLOAD_FAILED', 'the GitHub commit response was not JSON');
      }
      const commitRecord = Array.isArray(commitAttempt.body)
        ? asRecord(commitAttempt.body[0])
        : asRecord(commitAttempt.body);
      const commitSha = asString(commitRecord?.['sha']);
      if (commitSha === undefined || !/^[0-9a-f]{40}$/.test(commitSha)) {
        return portFail('SOURCE_NOT_FOUND', 'GitHub did not return an exact 40-character commit SHA');
      }

      const readFile = async (
        path: string,
      ): Promise<{ readonly kind: 'text'; readonly text: string } | { readonly kind: 'missing' } | { readonly kind: 'failure'; readonly outcome: PortOutcome<never> }> => {
        const url = `${apiBase}/repos/${owner}/${name}/contents/${path}?ref=${commitSha}`;
        const outcome = await attempt(url, signal);
        if (outcome.kind === 'unreachable') {
          return { kind: 'failure', outcome: portFail('NETWORK_UNAVAILABLE', 'the GitHub contents request could not connect') };
        }
        if (outcome.kind === 'response') {
          return outcome.response.status === 404
            ? { kind: 'missing' }
            : { kind: 'failure', outcome: failureForStatus(outcome.response) };
        }
        if (outcome.kind === 'unparseable') {
          return { kind: 'failure', outcome: portFail('DOWNLOAD_FAILED', 'the GitHub contents response was not JSON') };
        }
        const record = asRecord(outcome.body);
        const content = asString(record?.['content']);
        if (content === undefined) {
          return { kind: 'failure', outcome: portFail('SOURCE_MANIFEST_INVALID', 'the GitHub contents response had no content') };
        }
        const text =
          asString(record?.['encoding']) === 'base64'
            ? Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8')
            : content;
        return { kind: 'text', text };
      };

      const manifestFile = await readFile('package.json');
      if (manifestFile.kind === 'failure') {
        return manifestFile.outcome;
      }
      if (manifestFile.kind === 'missing') {
        return portFail('SOURCE_MANIFEST_INVALID', 'the repository has no package.json at the resolved commit');
      }
      const lockFile = await readFile('pnpm-lock.yaml');
      if (lockFile.kind === 'failure') {
        return lockFile.outcome;
      }
      return buildPreviewResolution({
        source,
        resolved: {
          commitSha,
          manifestText: manifestFile.text,
          lockText: lockFile.kind === 'text' ? lockFile.text : null,
        },
        executor: options.executor ?? null,
      });
    },

    lastRequestUrl: () => lastRequestUrl,
  };
};
