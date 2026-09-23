/**
 * Method registry: the frozen whitelist, each method's strict input schema and
 * its idempotency/read-only metadata.
 *
 * The renderer may only call these names; there is no generic `invoke`
 * channel. Read-only methods carry no `requestId` (and are never deduplicated);
 * every other method is idempotent on `requestId` + identical parameters.
 */
import {
  catalogCombinationIdSchema,
  environmentIdSchema,
  generationIdSchema,
  nameSchema,
  operationIdSchema,
  planIdSchema,
  requestIdSchema,
  revisionSchema,
  subscriptionIdSchema,
} from './ids.js';
import {
  buildAuthorizationSchema,
  changePlanActionSchema,
  pluginSourceSelectorSchema,
  PLUGIN_QUERY_MAX_LENGTH,
  PLUGIN_QUERY_MIN_LENGTH,
} from './dto.js';
import { sLiteral, sObject, sOptional, sString, type Infer, type Schema } from './schema.js';

export const CONTRACT_METHODS = [
  'catalog.list',
  'environments.list',
  'environments.create',
  'environments.start',
  'environments.stop',
  // 1.1 addition (#114, A2): in-environment composition switch transaction.
  'environments.switchCombination',
  'environments.openWebUI',
  'operations.get',
  'operations.cancel',
  'operations.subscribe',
  'operations.unsubscribe',
  'diagnostics.export',
  // 1.1 plugin discovery (ADR 0005 D4).
  'plugins.search',
  'plugins.inspect',
  // 1.1 plugin transactions (ADR 0005 D4).
  'changes.preview',
  'changes.apply',
  // 1.1 read-only installed-plugin list (ADR 0005 D4/D15, S3).
  'plugins.installed',
  // 1.1 read-only generation read (ADR 0005 D4).
  'generations.list',
  'generations.restore',
  // 1.1 addition (#113, A1): read-only upstream DSH version discovery.
  'versions.dsh',
  // 1.1 addition (#118): read-only expected composition from `--dump-config`.
  'compositions.expected',
] as const;

export type ContractMethod = (typeof CONTRACT_METHODS)[number];

export const contractMethodSchema = sLiteral(...CONTRACT_METHODS);

export const isContractMethod = (value: unknown): value is ContractMethod =>
  typeof value === 'string' && (CONTRACT_METHODS as readonly string[]).includes(value);

export const methodInputSchemas = {
  'catalog.list': sObject({}),
  'environments.list': sObject({}),
  'environments.create': sObject({
    requestId: requestIdSchema,
    name: nameSchema,
    catalogCombinationId: catalogCombinationIdSchema,
  }),
  'environments.start': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
    expectedRevision: revisionSchema,
  }),
  'environments.stop': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
    expectedRevision: revisionSchema,
  }),
  'environments.switchCombination': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
    expectedRevision: revisionSchema,
    catalogCombinationId: catalogCombinationIdSchema,
  }),
  'environments.openWebUI': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
  }),
  'operations.get': sObject({
    operationId: operationIdSchema,
  }),
  'operations.cancel': sObject({
    requestId: requestIdSchema,
    operationId: operationIdSchema,
  }),
  'operations.subscribe': sObject({
    requestId: requestIdSchema,
    operationId: sOptional(operationIdSchema),
  }),
  'operations.unsubscribe': sObject({
    requestId: requestIdSchema,
    subscriptionId: subscriptionIdSchema,
  }),
  'diagnostics.export': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
  }),
  'plugins.search': sObject({
    requestId: requestIdSchema,
    query: sString({ minLength: PLUGIN_QUERY_MIN_LENGTH, maxLength: PLUGIN_QUERY_MAX_LENGTH }),
  }),
  'plugins.inspect': sObject({
    requestId: requestIdSchema,
    source: pluginSourceSelectorSchema,
  }),
  'changes.preview': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
    expectedRevision: revisionSchema,
    action: changePlanActionSchema,
  }),
  'changes.apply': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
    expectedRevision: revisionSchema,
    planId: planIdSchema,
    buildAuthorization: sOptional(buildAuthorizationSchema),
  }),
  'plugins.installed': sObject({
    environmentId: environmentIdSchema,
  }),
  'generations.list': sObject({
    environmentId: environmentIdSchema,
  }),
  'generations.restore': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
    expectedRevision: revisionSchema,
    targetGenerationId: generationIdSchema,
  }),
  'versions.dsh': sObject({
    requestId: requestIdSchema,
  }),
  'compositions.expected': sObject({
    requestId: requestIdSchema,
    environmentId: environmentIdSchema,
  }),
} satisfies Record<ContractMethod, Schema<unknown>>;

export type MethodInputs = {
  [M in ContractMethod]: Infer<(typeof methodInputSchemas)[M]>;
};

export interface MethodDefinition {
  readonly name: ContractMethod;
  readonly input: Schema<unknown>;
  /** True when the method carries `requestId` and must be deduplicated. */
  readonly idempotent: boolean;
  /** True for pure queries: no side effect and no `requestId`. */
  readonly readOnly: boolean;
}

const define = (
  name: ContractMethod,
  options: { readonly readOnly: boolean; readonly idempotent: boolean },
): MethodDefinition => ({
  name,
  input: methodInputSchemas[name],
  readOnly: options.readOnly,
  idempotent: options.idempotent,
});

export const METHOD_DEFINITIONS: Record<ContractMethod, MethodDefinition> = {
  'catalog.list': define('catalog.list', { readOnly: true, idempotent: false }),
  'environments.list': define('environments.list', { readOnly: true, idempotent: false }),
  'environments.create': define('environments.create', { readOnly: false, idempotent: true }),
  'environments.start': define('environments.start', { readOnly: false, idempotent: true }),
  'environments.stop': define('environments.stop', { readOnly: false, idempotent: true }),
  'environments.switchCombination': define('environments.switchCombination', {
    readOnly: false,
    idempotent: true,
  }),
  'environments.openWebUI': define('environments.openWebUI', {
    readOnly: false,
    idempotent: true,
  }),
  'operations.get': define('operations.get', { readOnly: true, idempotent: false }),
  'operations.cancel': define('operations.cancel', { readOnly: false, idempotent: true }),
  'operations.subscribe': define('operations.subscribe', { readOnly: false, idempotent: true }),
  'operations.unsubscribe': define('operations.unsubscribe', { readOnly: false, idempotent: true }),
  'diagnostics.export': define('diagnostics.export', { readOnly: false, idempotent: true }),
  'plugins.search': define('plugins.search', { readOnly: false, idempotent: true }),
  'plugins.inspect': define('plugins.inspect', { readOnly: false, idempotent: true }),
  'changes.preview': define('changes.preview', { readOnly: false, idempotent: true }),
  'changes.apply': define('changes.apply', { readOnly: false, idempotent: true }),
  'plugins.installed': define('plugins.installed', { readOnly: true, idempotent: false }),
  'generations.list': define('generations.list', { readOnly: true, idempotent: false }),
  'generations.restore': define('generations.restore', { readOnly: false, idempotent: true }),
  'versions.dsh': define('versions.dsh', { readOnly: false, idempotent: true }),
  'compositions.expected': define('compositions.expected', {
    readOnly: false,
    idempotent: true,
  }),
};

export const validateMethodInput = <M extends ContractMethod>(
  method: M,
  value: unknown,
  issues: import('./schema.js').ValidationIssue[],
): MethodInputs[M] | undefined =>
  methodInputSchemas[method](value, 'input', issues) as MethodInputs[M] | undefined;
