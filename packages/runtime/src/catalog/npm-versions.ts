/**
 * Read-only npm registry adapter for upstream DSH version discovery
 * (`versions.dsh`, A1 / #113).
 *
 * Boundaries:
 * - **public, unauthenticated** registry metadata reads only. It never reads a
 *   credential or token, never sends an `Authorization` header and never
 *   inherits anything from an environment home.
 * - exactly one allowlisted host (`registry.npmjs.org`) and one package
 *   (`@deepseek-ai/dsh`). A non-allowlisted base is refused before any request.
 * - it downloads **metadata JSON only**: no tarball, no package code, no
 *   install, no execution.
 * - the concrete `fetch`/clock is injected so default CI runs against a
 *   controlled response and never touches the real network (a real registry
 *   probe is opt-in and bounded).
 *
 * Catalog coverage is marked from the injected audited combination table: an
 * upstream version becomes `supported: true` only when a verified combination
 * pins that exact version. `latest` is never equated with compatibility, so
 * unaudited versions are reported as `supported: false`.
 *
 * Error mapping: connection/deadline/abort → `NETWORK_UNAVAILABLE`; `429` →
 * `RATE_LIMITED` (with `retry-after` when present); `403` → `SOURCE_ACCESS_DENIED`;
 * `404` → `SOURCE_NOT_FOUND`; any other established HTTP or parse failure →
 * `DOWNLOAD_FAILED`. Only the classification is trusted downstream; no response
 * or error text crosses the port.
 */
import {
  DSH_UPSTREAM_VERSIONS_MAX,
  DSH_VERSION_TAGS_MAX,
  dshVersionListingSchema,
  isPlainRecord,
  portFail,
  portOk,
  type DshVersionListing,
  type PortOutcome,
  type RuntimeCombination,
} from '@hdsl/contracts';

/** Narrow fetch seam; the global `fetch` is structurally compatible. */
export type VersionFetchLike = (
  input: string,
  init?: {
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
  },
) => Promise<Response>;

export interface NpmDshVersionSourceOptions {
  readonly fetch: VersionFetchLike;
  /** Audited combinations used to mark upstream versions (`combinations.ts`). */
  readonly catalog: readonly RuntimeCombination[];
  /** Default `https://registry.npmjs.org`; any other host is refused. */
  readonly registryBase?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export interface NpmDshVersionSource {
  listVersions(signal: AbortSignal): Promise<PortOutcome<DshVersionListing>>;
  /** Exact URL of the most recent request; test/diagnostic only. */
  lastRequestUrl(): string | null;
}

const DEFAULT_REGISTRY_BASE = 'https://registry.npmjs.org';
const ALLOWED_REGISTRY_HOST = 'registry.npmjs.org';
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'HDSL/0.0.0 (+https://github.com/YingkeSu/HDSL)';

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const isVersionLabel = (value: string): boolean => value.length <= 64 && VERSION_PATTERN.test(value);

/** Rejects as soon as the signal aborts, so a stalled body read cannot hang. */
const rejectOnAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

const retryAfterFrom = (headers: { get(name: string): string | null }): number | undefined => {
  const value = headers.get('retry-after');
  return value !== null && /^\d{1,7}$/.test(value) ? Number(value) : undefined;
};

/**
 * Audited combination ids per upstream version for the injected catalog. A
 * combination is "verified" by contract (`catalog.list`); the adapter does not
 * upgrade an `unverified` one.
 */
const auditedByVersion = (
  catalog: readonly RuntimeCombination[],
): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const combination of catalog) {
    if (combination.compatibility.status !== 'verified') {
      continue;
    }
    const ids = map.get(combination.dsh.version) ?? [];
    ids.push(combination.id);
    map.set(combination.dsh.version, ids);
  }
  return map;
};

const buildListing = (
  body: unknown,
  options: {
    readonly catalog: readonly RuntimeCombination[];
    readonly fetchedAt: string;
    readonly registry: string;
  },
): DshVersionListing | undefined => {
  if (!isPlainRecord(body)) {
    return undefined;
  }
  const rawVersions = isPlainRecord(body['versions']) ? body['versions'] : undefined;
  if (rawVersions === undefined) {
    return undefined;
  }
  const rawDistTags = isPlainRecord(body['dist-tags']) ? body['dist-tags'] : {};
  const rawTime = isPlainRecord(body['time']) ? body['time'] : {};

  // dist-tags: tag -> version (deterministic, bounded).
  const distTags: { tag: string; version: string }[] = [];
  for (const tag of Object.keys(rawDistTags).sort()) {
    const version = asString(rawDistTags[tag]);
    if (version === undefined || !isVersionLabel(version)) {
      continue;
    }
    distTags.push({ tag: tag.slice(0, 64), version });
    if (distTags.length >= DSH_VERSION_TAGS_MAX) {
      break;
    }
  }
  const tagsByVersion = new Map<string, string[]>();
  for (const entry of distTags) {
    const list = tagsByVersion.get(entry.version) ?? [];
    list.push(entry.tag);
    tagsByVersion.set(entry.version, list);
  }

  const audited = auditedByVersion(options.catalog);
  // Newest first: the registry returns versions in publish order, so reverse.
  const versions = Object.keys(rawVersions).filter(isVersionLabel).reverse().slice(0, DSH_UPSTREAM_VERSIONS_MAX);
  const entries = versions.map((version) => {
    const publishedAt = asString(rawTime[version]);
    const catalogCombinationIds = audited.get(version) ?? [];
    return {
      version,
      distTags: tagsByVersion.get(version) ?? [],
      publishedAt: publishedAt === undefined ? null : publishedAt.slice(0, 64),
      supported: catalogCombinationIds.length > 0,
      catalogCombinationIds: catalogCombinationIds.slice(0, DSH_VERSION_TAGS_MAX),
    };
  });

  const candidate: unknown = {
    source: { registry: options.registry, packageName: DSH_PACKAGE_NAME },
    fetchedAt: options.fetchedAt,
    distTags,
    versions: entries,
  };
  return dshVersionListingSchema(candidate, 'versions', []) as DshVersionListing | undefined;
};

export const createNpmDshVersionSource = (
  options: NpmDshVersionSourceOptions,
): NpmDshVersionSource => {
  const registryBase = options.registryBase ?? DEFAULT_REGISTRY_BASE;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  let lastRequestUrl: string | null = null;

  const url = `${registryBase}/${DSH_PACKAGE_NAME.replace('/', '%2f')}`;

  const listVersions = async (signal: AbortSignal): Promise<PortOutcome<DshVersionListing>> => {
    // Allowlist enforcement before any request (A1 acceptance: no non-allowlisted host).
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return portFail('SOURCE_ACCESS_DENIED', 'the registry base is not a valid URL');
    }
    if (host !== ALLOWED_REGISTRY_HOST) {
      return portFail('SOURCE_ACCESS_DENIED', 'the registry host is not allowlisted');
    }
    if (signal.aborted) {
      return portFail('NETWORK_UNAVAILABLE', 'the registry request was aborted');
    }
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
      let response: Response;
      try {
        response = await options.fetch(url, {
          signal: inner.signal,
          headers: { accept: 'application/json', 'user-agent': userAgent },
        });
      } catch {
        return portFail('NETWORK_UNAVAILABLE', 'the registry request could not connect');
      }
      if (!response.ok) {
        const status = response.status;
        if (status === 429) {
          const retryAfterSeconds = retryAfterFrom(response.headers);
          return portFail(
            'RATE_LIMITED',
            'the registry returned HTTP 429',
            retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
          );
        }
        if (status === 403) {
          return portFail('SOURCE_ACCESS_DENIED', 'the registry denied access with HTTP 403');
        }
        if (status === 404) {
          return portFail('SOURCE_NOT_FOUND', 'the registry has no such package');
        }
        return portFail('DOWNLOAD_FAILED', `the registry returned HTTP ${String(status)}`);
      }
      let body: unknown;
      try {
        body = await Promise.race([response.json(), rejectOnAbort(inner.signal)]);
      } catch {
        if (inner.signal.aborted || signal.aborted) {
          return portFail('NETWORK_UNAVAILABLE', 'the registry request was aborted');
        }
        return portFail('DOWNLOAD_FAILED', 'the registry response was not JSON');
      }
      const listing = buildListing(body, {
        catalog: options.catalog,
        fetchedAt: now().toISOString(),
        registry: registryBase,
      });
      return listing === undefined
        ? portFail('DOWNLOAD_FAILED', 'the registry response was malformed')
        : portOk(listing);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    }
  };

  return { listVersions, lastRequestUrl: () => lastRequestUrl };
};

/**
 * Catalog coverage helper (host-independent): the exact DSH versions the
 * audited table pins. Exposed so callers/tests can assert the marking without a
 * registry response.
 */
export const auditedDshVersions = (
  catalog: readonly RuntimeCombination[],
): readonly string[] => [...auditedByVersion(catalog).keys()].sort();
