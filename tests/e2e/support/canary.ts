/**
 * Canary and diagnostics-exclusion oracles for the desktop E2E slice.
 *
 * Two credential classes are in scope (ADR 0002):
 *
 * 1. **Managed user credentials** — stored only as OS-store *references*
 *    (ADR 0003). The reference config file that main imports through its native
 *    menu MUST contain references only; a value/secret field is a rejection, not
 *    a value to store.
 * 2. **Upstream-generated local credentials** — DSH writes
 *    `<env home>/.credentials.yaml` (0600, Web grant secret) and `logs/**`. HDSL
 *    treats the whole environment home as secret-bearing.
 *
 * Everything here is a QA oracle: `findSecretHits` plants a clearly-fake
 * `hdsl-e2e-canary-*` value into fixture artifacts, and the scenario plan
 * asserts the eventual launcher never surfaces it in renderer state, diagnostics
 * exports, operation records or logs. No real keychain, API key or user DSH
 * instance is ever read.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_SCAN_BYTES = 512 * 1024;

/** A fixture-only value; never a real credential. */
export const createCanary = (label: string): string => `hdsl-e2e-canary-${label}-${randomUUID()}`;

export interface UpstreamCredentialArtifacts {
  readonly credentialFile: string;
  readonly logFile: string;
  readonly canaryValue: string;
}

/**
 * Writes the upstream-shaped secret artifacts into an isolated environment
 * home: a 0600 `.credentials.yaml` grant secret plus a startup log line. Both
 * are fixtures, not a real DSH run.
 */
export const plantUpstreamCredentialArtifacts = (
  homeDir: string,
  canaryValue: string,
): UpstreamCredentialArtifacts => {
  const credentialFile = join(homeDir, '.credentials.yaml');
  const logDir = join(homeDir, 'logs');
  const logFile = join(logDir, 'boot.log');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(credentialFile, `web:\n  grantSecret: ${canaryValue}\n`, { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  writeFileSync(logFile, `[boot] ready (token=${canaryValue})\n`, { mode: 0o600 });
  return { credentialFile, logFile, canaryValue };
};

/** Walks a tree and returns every relative path whose text content holds `needle`. */
export const findSecretHits = (root: string, needle: string): readonly string[] => {
  const hits: string[] = [];
  if (!existsSync(root)) {
    return hits;
  }
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const relPath = prefix === '' ? name : `${prefix}/${name}`;
      const stats = statSync(full, { throwIfNoEntry: false });
      if (stats === undefined) {
        continue;
      }
      if (stats.isDirectory()) {
        visit(full, relPath);
      } else if (stats.isFile() && stats.size <= MAX_SCAN_BYTES) {
        try {
          if (readFileSync(full, 'utf8').includes(needle)) {
            hits.push(relPath);
          }
        } catch {
          // Binary/unreadable fixture file: not a text leak surface.
        }
      }
    }
  };
  visit(root, '');
  return hits.sort();
};

/**
 * Patterns the launcher's diagnostics export MUST exclude by default (ADR 0002,
 * ADR 0003, `contracts/local-api.md` secret boundary). Kept as QA expectations
 * so a candidate that ships a permissive default export fails a scenario rather
 * than passing silently.
 */
export const DEFAULT_DIAGNOSTICS_EXCLUSIONS: readonly string[] = [
  'environments/*/home/.credentials.yaml',
  'environments/*/home/logs/**',
  'environments/*/credentials.json',
];

const globToRegExp = (pattern: string): RegExp => {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*';
        index += 1;
      } else {
        out += '[^/]*';
      }
    } else {
      out += (char as string).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
};

/** True when a diagnostics-relative path falls under the default exclusion set. */
export const isDefaultExcluded = (relPath: string): boolean =>
  DEFAULT_DIAGNOSTICS_EXCLUSIONS.some((pattern) => globToRegExp(pattern).test(relPath));

/** Reference-only config limits. The exact byte cap is frozen by #6; QA enforces *a* bound. */
export const CREDENTIAL_CONFIG_MAX_BYTES_EXPECTED = 64 * 1024;

export interface CredentialReferenceEntry {
  readonly id: string;
  readonly store: string;
  readonly key: string;
}

export interface CredentialBindingEntry {
  readonly name: string;
  readonly referenceId: string;
}

/**
 * A valid reference-only config file body: references and bindings, no values.
 * Mirrors the `CredentialReference` shape frozen in ADR 0003 without importing
 * production code (this is an independent oracle).
 */
export const buildReferenceOnlyConfig = (
  references: readonly CredentialReferenceEntry[],
  bindings: readonly CredentialBindingEntry[],
): string => `${JSON.stringify({ schemaVersion: 1, references, bindings }, null, 2)}\n`;

const FORBIDDEN_CONFIG_KEYS = new Set([
  'value',
  'secret',
  'secretvalue',
  'token',
  'password',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
]);

/** Object keys that must never appear in a reference-only credential config. */
export const findForbiddenConfigKeys = (content: string): readonly string[] => {
  const found = new Set<string>();
  for (const match of content.matchAll(/"([^"]+)"\s*:/g)) {
    const key = match[1];
    if (key === undefined) {
      continue;
    }
    const normalized = key.replace(/[-\s]/g, '').toLowerCase();
    if (FORBIDDEN_CONFIG_KEYS.has(normalized)) {
      found.add(key);
    }
  }
  return [...found].sort();
};

export const isWithinCredentialConfigLimit = (
  content: string,
  limitBytes: number = CREDENTIAL_CONFIG_MAX_BYTES_EXPECTED,
): boolean => Buffer.byteLength(content, 'utf8') <= limitBytes;
