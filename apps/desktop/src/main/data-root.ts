/**
 * Data-root resolution for the desktop entry (T006 / issue #6).
 *
 * Priority: `--hdsl-data-root <path>`/`--hdsl-data-root=<path>` flag, then
 * `HDSL_DATA_ROOT`, then the Electron `userData` directory. The flag/env seam
 * exists so QA can point a controlled instance at a disposable root and so two
 * instances can be forced to contend for the same root. This module is pure (no
 * Electron, no fs).
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
 * neither is present with a non-empty value.
 *
 * Both the space form (`--hdsl-data-root <path>`) and the Chromium-style equals
 * form (`--hdsl-data-root=<path>`) are accepted. Rejecting the equals form would
 * only be safe if it failed closed; accepting it removes a silent fallback to
 * the default profile. A flag without a value and an empty environment variable
 * are "not provided", matching {@link resolveDataRoot}. Duplicate inputs are
 * deterministic: the first space form wins, then the first equals form, then the
 * environment.
 */
export const explicitDataRoot = (input: DataRootOverrideInput): string | undefined => {
  const flagIndex = input.argv.indexOf(DATA_ROOT_FLAG);
  if (flagIndex >= 0) {
    const candidate = input.argv[flagIndex + 1];
    if (candidate !== undefined && candidate.trim() !== '') {
      return candidate;
    }
  }
  const equalsPrefix = `${DATA_ROOT_FLAG}=`;
  for (const argument of input.argv) {
    if (argument.startsWith(equalsPrefix)) {
      const value = argument.slice(equalsPrefix.length);
      if (value.trim() !== '') {
        return value;
      }
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
