/** Opaque identifier generation for environment/operation/generation records. */
import { randomUUID } from 'node:crypto';

const token = (): string => randomUUID().replace(/-/g, '').slice(0, 16);

export const newEnvironmentId = (): string => `env-${token()}`;
export const newOperationId = (): string => `op-${token()}`;
export const newGenerationId = (): string => `gen-${token()}`;
export const newTransactionId = (): string => `txn-${token()}`;
export const newPlanId = (): string => `plan-${token()}`;
