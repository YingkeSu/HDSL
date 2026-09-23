/**
 * Frozen IPC channel names shared by the main process and the type-checked
 * preload surface (T006 / issue #6).
 *
 * There is exactly one request channel, one one-way selection notification for
 * the native credential menu, and two fixed push channels owned by
 * `@hdsl/contracts`: `operation.updated` and the process-exit projection
 * `environment.updated`. The sandboxed preload runtime is a CommonJS file that
 * cannot import this ESM module; `tests/desktop/preload-surface.test.ts` pins
 * its literals to these constants so the two cannot drift.
 */
import { ENVIRONMENT_UPDATED_CHANNEL, OPERATION_UPDATED_CHANNEL } from '@hdsl/contracts';

export const HDSL_CONTRACT_CHANNEL = 'hdsl:contract';
export const HDSL_SELECTION_CHANNEL = 'hdsl:selection';
export const HDSL_OPERATION_UPDATED_CHANNEL = OPERATION_UPDATED_CHANNEL;
export const HDSL_ENVIRONMENT_UPDATED_CHANNEL = ENVIRONMENT_UPDATED_CHANNEL;
