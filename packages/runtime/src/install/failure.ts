import type { ErrorCode } from '@hdsl/contracts';
import { portFail, portOk, type PortOutcome } from '@hdsl/contracts';

/** Internal failure carrying a frozen contract error code. */
export class InstallFailure extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'InstallFailure';
    this.code = code;
  }
}

/** Maps any thrown value to the controlled `PortOutcome` failure shape. */
export const toFailure = <T>(error: unknown): PortOutcome<T> => {
  if (error instanceof InstallFailure) {
    return portFail(error.code, error.message);
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return portFail('DISK_FULL', 'the disk is full');
  }
  return portFail('INTERNAL_ERROR', error instanceof Error ? error.message : 'managed install failed');
};

export const failureOutcome = <T>(code: ErrorCode, message: string): PortOutcome<T> =>
  portFail(code, message);

export const successOutcome = <T>(value: T): PortOutcome<T> => portOk(value);
