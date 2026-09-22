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
  GITHUB_SEARCH_RESULT_LIMIT,
  isPlainRecord,
  PLUGIN_SEARCH_PAGE_SIZE,
  portFail,
  portOk,
  type PluginInspection,
  type PluginRepositoryDetail,
  type PluginSearchHit,
  type PluginSearchResult,
  type PluginSourceSelector,
  type PortOutcome,
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
}

export interface GitHubPluginSource {
  search(query: string, signal: AbortSignal): Promise<PortOutcome<PluginSearchResult>>;
  inspect(
    source: PluginSourceSelector,
    signal: AbortSignal,
  ): Promise<PortOutcome<PluginInspection>>;
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
  const description = nonEmpty(asString(item['description']));
  const defaultBranch = nonEmpty(asString(item['default_branch'])) ?? 'HEAD';
  const updatedAt = nonEmpty(asString(item['updated_at'])) ?? 'unknown';
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
    license: asLicense(item['license']),
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
    description: nonEmpty(asString(item['description'])),
    htmlUrl,
    stars: Math.max(0, Math.trunc(asNumber(item['stargazers_count']) ?? 0)),
    topics: asTopics(item['topics']),
    defaultBranch: nonEmpty(asString(item['default_branch'])) ?? 'HEAD',
    updatedAt: nonEmpty(asString(item['updated_at'])) ?? 'unknown',
    archived: asBoolean(item['archived']) ?? false,
    fork: asBoolean(item['fork']) ?? false,
    license: asLicense(item['license']),
    homepage: asHomepage(item['homepage']),
  };
};

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

type RequestOutcome =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'unreachable' };

export const createGitHubPluginSource = (
  options: GitHubPluginSourceOptions,
): GitHubPluginSource => {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageSize = options.pageSize ?? PLUGIN_SEARCH_PAGE_SIZE;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  let lastRequestUrl: string | null = null;

  const request = async (url: string, signal: AbortSignal): Promise<RequestOutcome> => {
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
      return { kind: 'response', response };
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

  const readJson = async (response: Response): Promise<unknown | undefined> => {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  };

  return {
    async search(query, signal) {
      const url = `${apiBase}/search/repositories?q=${encodeURIComponent(query)}&per_page=${String(pageSize)}&page=1`;
      const outcome = await request(url, signal);
      if (outcome.kind === 'unreachable') {
        return portFail('NETWORK_UNAVAILABLE', 'the GitHub search request could not connect');
      }
      if (!outcome.response.ok) {
        return failureForStatus(outcome.response);
      }
      const body = await readJson(outcome.response);
      const record = asRecord(body);
      if (record === undefined) {
        return portFail('DOWNLOAD_FAILED', 'the GitHub search response was not a JSON object');
      }
      const items = Array.isArray(record['items']) ? record['items'] : [];
      const hits = items
        .map(mapSearchHit)
        .filter((hit): hit is PluginSearchHit => hit !== undefined);
      const totalCount = Math.max(0, Math.trunc(asNumber(record['total_count']) ?? 0));
      const reachable = Math.min(totalCount, GITHUB_SEARCH_RESULT_LIMIT);
      return portOk({
        query,
        hits,
        totalCount,
        incompleteResults: asBoolean(record['incomplete_results']) ?? false,
        hasMore: hits.length < reachable,
        fetchedAt: now().toISOString(),
        fromCache: false,
      });
    },

    async inspect(source, signal) {
      const url = `${apiBase}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.name)}`;
      const outcome = await request(url, signal);
      if (outcome.kind === 'unreachable') {
        return portFail('NETWORK_UNAVAILABLE', 'the GitHub repository request could not connect');
      }
      if (!outcome.response.ok) {
        return failureForStatus(outcome.response);
      }
      const body = await readJson(outcome.response);
      const repository = mapRepositoryDetail(body);
      if (repository === undefined) {
        return portFail('DOWNLOAD_FAILED', 'the GitHub repository response was malformed');
      }
      return portOk({
        source,
        repository,
        fetchedAt: now().toISOString(),
        fromCache: false,
      });
    },

    lastRequestUrl: () => lastRequestUrl,
  };
};
