/**
 * Explicit ENOSPC fault injection for hosts where a tiny mounted volume is not
 * available (Linux CI). This is a **test double**, not a real disk: it exists
 * only so the disk-full terminal-state assertion can run on every platform.
 * Reports must call it `injected-enospc`, never "disk full" without the label.
 */
import type { DiskFaultMode } from './tiny-volume.js';

export const ENOSPC_MODE: DiskFaultMode = 'injected-enospc';

export const enospcError = (): NodeJS.ErrnoException =>
  Object.assign(new Error('ENOSPC: no space left on device (injected test fault)'), {
    code: 'ENOSPC',
    errno: -28,
    syscall: 'write',
  });

export interface InjectedEnospcSink {
  readonly mode: typeof ENOSPC_MODE;
  readonly limitBytes: number;
  readonly bytesWritten: number;
  write(chunk: Uint8Array): void;
}

/**
 * A sink that accepts bytes until `limitBytes` and then throws `ENOSPC`. Wire
 * it to the download transport / artifact writer once T004 confirms the
 * injection hook.
 */
export const createInjectedEnospcSink = (limitBytes: number): InjectedEnospcSink => {
  let bytesWritten = 0;
  return {
    mode: ENOSPC_MODE,
    limitBytes,
    get bytesWritten() {
      return bytesWritten;
    },
    write: (chunk: Uint8Array) => {
      if (bytesWritten + chunk.length > limitBytes) {
        throw enospcError();
      }
      bytesWritten += chunk.length;
    },
  };
};

export const isEnospc = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOSPC';
