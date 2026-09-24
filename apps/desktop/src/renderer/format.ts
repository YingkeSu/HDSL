/**
 * Display-only labels and formatting for the renderer (T006a).
 *
 * These helpers never rewrite contract data: error text is the already
 * sanitized `ContractError.message` from `@hdsl/contracts`. The renderer adds a
 * stable error code and a retry hint, and never renders a port message, a token
 * URL or a local path of its own.
 */
import {
  formatHostPlatform,
  VERIFIED_HOSTS,
  type ContractError,
  type EnvironmentState,
  type OperationStatus,
} from '@hdsl/contracts';

/**
 * Human-readable list of the hosts this build has real runtime evidence for.
 * Derived from the frozen `VERIFIED_HOSTS` matrix, so it can never claim a host
 * that the platform gate does not actually allow.
 */
export const VERIFIED_HOST_LABEL = VERIFIED_HOSTS.map(formatHostPlatform).join('、');

export const ENVIRONMENT_STATE_LABELS: Record<EnvironmentState, string> = {
  creating: '创建中',
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  error: '错误',
};

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
};

export const OPERATION_KIND_LABELS: Record<string, string> = {
  create: '创建',
  start: '启动',
  stop: '停止',
  switch: '切换版本',
  restore: '恢复代际',
  openWebUI: '打开 WebUI',
  export: '导出诊断',
  search: '检索插件',
  inspect: '查看仓库详情',
  versions: '读取 DSH 版本',
};

/** Display label for an operation kind; unknown kinds fall back to the raw value. */
export const formatOperationKind = (kind: string | null): string =>
  kind === null ? '操作' : (OPERATION_KIND_LABELS[kind] ?? kind);

/**
 * Deterministic, locale-free display of an ISO timestamp. The renderer never
 * reinterprets the contract value, so tests are stable across hosts.
 */
export const formatTimestamp = (value: string): string =>
  value.replace('T', ' ').replace(/Z$/, ' UTC');

/** `CODE：sanitized message（可重试）`, never a raw downstream message. */
export const describeError = (error: ContractError): string =>
  `${error.code}：${error.message}${error.retryable ? '（可重试）' : ''}`;

/**
 * Copy for the create flow when this build has no installable combination for
 * the current host (a Windows/Linux preview build, or a host without runtime
 * evidence). It states the support boundary instead of letting the user fill in
 * a form that must fail at `environments.create`.
 */
export const NO_INSTALLABLE_COMBINATION_NOTICE = `当前平台没有可安装的受审运行时组合，暂时无法创建环境。本构建仅在 ${VERIFIED_HOST_LABEL} 提供受审运行时；其他平台（含 Windows / Linux）目前仅提供界面预览，创建与启动尚未验证。`;

export const clampProgress = (progress: number): number =>
  Math.min(100, Math.max(0, progress));

/** Digest prefix for display; the full digest stays in the model. */
export const shortDigest = (digest: string): string =>
  digest.length <= 12 ? digest : `${digest.slice(0, 12)}…`;
