/**
 * Data-root resolution for the desktop entry (T006 / issue #6).
 *
 * Priority: `--hdsl-data-root <path>` / `--hdsl-data-root=<path>` flag, then
 * `HDSL_DATA_ROOT`, then the Electron `userData` directory. The flag/env seam
 * exists so QA can point a controlled instance at a disposable root and so two
 * instances can be forced to contend for the same root. This module is pure (no
 * Electron, no fs).
 *
 * An override that is *present but invalid* (a dangling flag, an empty value, a
 * switch used as the value, or an empty environment variable) is reported
 * through {@link dataRootOverrideProblem}. The production entry refuses to start
 * on it, so a typo can never fall back to the real default profile.
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

/** Why an explicitly provided data-root override cannot be used. */
export type DataRootOverrideProblem = 'missing-value' | 'empty-value' | 'switch-value';

interface DataRootParse {
  readonly value?: string | undefined;
  readonly problem?: DataRootOverrideProblem | undefined;
}

const EQUALS_PREFIX = `${DATA_ROOT_FLAG}=`;

/**
 * Single reader for both flag spellings and the environment.
 *
 * Valid duplicates follow first-wins (the first value in `argv` order). Any
 * invalid occurrence anywhere — even if a later value is valid — makes the whole
 * override invalid, so an earlier mistake is never silently rescued by a later
 * valid value.
 */
const parseDataRoot = (input: DataRootOverrideInput): DataRootParse => {
  let value: string | undefined;
  let problem: DataRootOverrideProblem | undefined;
  for (let index = 0; index < input.argv.length; index += 1) {
    const argument = input.argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === DATA_ROOT_FLAG) {
      const next = input.argv[index + 1];
      if (next === undefined || next.trim() === '') {
        problem ??= 'missing-value';
      } else if (next.startsWith('-')) {
        problem ??= 'switch-value';
      } else {
        value ??= next.trim();
      }
      continue;
    }
    if (argument.startsWith(EQUALS_PREFIX)) {
      const equalsValue = argument.slice(EQUALS_PREFIX.length).trim();
      if (equalsValue === '') {
        problem ??= 'empty-value';
      } else {
        value ??= equalsValue;
      }
    }
  }
  if (problem !== undefined) {
    return { problem };
  }
  if (value !== undefined) {
    return { value };
  }
  const fromEnv = input.env[DATA_ROOT_ENV];
  if (fromEnv === undefined) {
    return {};
  }
  // An unset variable means "no override"; a set-but-blank one is a mistake the
  // operator would otherwise mistake for an isolated run.
  return fromEnv.trim() === '' ? { problem: 'empty-value' } : { value: fromEnv.trim() };
};

/** The usable explicit data root, or `undefined` when absent or invalid. */
export const explicitDataRoot = (input: DataRootOverrideInput): string | undefined =>
  parseDataRoot(input).value;

/** The reason a present override is unusable, or `undefined` when usable/absent. */
export const dataRootOverrideProblem = (
  input: DataRootOverrideInput,
): DataRootOverrideProblem | undefined => parseDataRoot(input).problem;

export const resolveDataRoot = (input: ResolveDataRootInput): string => {
  const override = explicitDataRoot(input);
  return override === undefined ? resolve(input.userDataDirectory) : resolve(override);
};
