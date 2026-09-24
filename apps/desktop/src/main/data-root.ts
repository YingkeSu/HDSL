/**
 * Data-root resolution for the desktop entry (T006 / issue #6).
 *
 * Priority: `--hdsl-data-root <path>` flag, then `HDSL_DATA_ROOT`, then the
 * Electron `userData` directory. The flag/env seam exists so QA can point a
 * controlled instance at a disposable root and so two instances can be forced
 * to contend for the same root. This module is pure (no Electron, no fs).
 */
import { resolve } from 'node:path';

export const DATA_ROOT_ENV = 'HDSL_DATA_ROOT';
export const DATA_ROOT_FLAG = '--hdsl-data-root';

export interface ResolveDataRootInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataDirectory: string;
}

/** Input shared by the data-root override readers. */
export interface DataRootOverrideInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The explicit `--hdsl-data-root`/`HDSL_DATA_ROOT` value, or `undefined` when
 * neither is present with a non-empty value. A flag without a following value
 * and an empty environment variable are treated as "not provided", matching
 * {@link resolveDataRoot}'s fallback so a malformed override never silently
 * becomes an isolated run.
 */
export const explicitDataRoot = (input: DataRootOverrideInput): string | undefined => {
  const flagIndex = input.argv.indexOf(DATA_ROOT_FLAG);
  if (flagIndex >= 0) {
    const candidate = input.argv[flagIndex + 1];
    if (candidate !== undefined && candidate.trim() !== '') {
      return candidate;
    }
  }
  const fromEnv = input.env[DATA_ROOT_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv;
  }
  return undefined;
};

export const resolveDataRoot = (input: ResolveDataRootInput): string => {
  const override = explicitDataRoot(input);
  return override === undefined ? resolve(input.userDataDirectory) : resolve(override);
};
