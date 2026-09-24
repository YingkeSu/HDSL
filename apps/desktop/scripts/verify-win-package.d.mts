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
export declare const MIN_INSTALLER_BYTES: number;
export declare const NSIS_MARKER: string;

export interface ContentMarker {
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
}

export declare const CONTENT_MARKERS: readonly ContentMarker[];
export declare const MAX_CONTENT_SCAN_BYTES: number;

export declare const verifyInstallerFile: (installerPath: string) => string[];
export declare const scanFileContent: (filePath: string) => Array<{ id: string; why: string }>;
export declare const auditPackagedTree: (appDir: string) => {
  errors: string[];
  files: number;
  markerFiles: number;
};

export interface VerifyOptions {
  /** Test seam replacing the real directory walk. */
  readonly listFiles?: (appDir: string) => string[];
}

export declare const verifyPackagedTree: (
  appDir: string,
  options?: VerifyOptions,
) => string[];
