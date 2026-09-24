/**
 * Types for the runtime-agnostic archive checker in `verify-win-package.mjs`.
 * The script itself stays plain ESM so the Windows workflow can run it with
 * `node` on the runner without a build step.
 */

export interface ForbiddenRule {
  readonly id: string;
  readonly test: (relativePath: string) => boolean;
  readonly why: string;
}

export declare const REQUIRED_FILES: readonly string[];
export declare const FORBIDDEN_RULES: readonly ForbiddenRule[];
export declare const DEV_DEPENDENCY_DIRS: readonly string[];

export interface VerifyOptions {
  /** Test seam replacing the real directory walk. */
  readonly listFiles?: (appDir: string) => string[];
}

export declare const verifyPackagedTree: (
  appDir: string,
  options?: VerifyOptions,
) => string[];
