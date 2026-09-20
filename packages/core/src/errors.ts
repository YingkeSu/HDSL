import type { ErrorCode } from '@hdsl/contracts';

/**
 * A managed-install failure carrying a frozen contract error code.
 *
 * The runtime adapter throws this so the environment service can persist the
 * exact terminal code (`DOWNLOAD_FAILED`, `DIGEST_MISMATCH`, `DISK_FULL`, …)
 * without string-matching messages.
 */
export class ManagedInstallError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ManagedInstallError';
    this.code = code;
  }
}

export const errorCodeFrom = (error: unknown): ErrorCode | undefined =>
  error instanceof ManagedInstallError ? error.code : undefined;
