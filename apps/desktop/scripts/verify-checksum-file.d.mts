/**
 * Types for the checksum-file verifier in `verify-checksum-file.mjs`. The script
 * stays plain ESM so the Windows workflow can run it with `node` without a
 * build step.
 */

export declare const verifyChecksumFile: (
  filePath: string,
  expectedFilename?: string,
) => string[];
