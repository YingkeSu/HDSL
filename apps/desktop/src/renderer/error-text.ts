/**
 * Chinese, user-facing error copy for the desktop UI (#145).
 *
 * The contract already guarantees that `ContractError.message` is a sanitized,
 * value-free structural message: validators never echo the received value and
 * downstream port text is replaced by a controlled per-code message
 * (`@hdsl/contracts` `errors.ts` / `redaction.ts`). This module keeps that
 * boundary intact:
 *
 * - the primary line is a stable Chinese explanation per error code, so the UI
 *   never leads with `CODE：english message`;
 * - the original `code：message` is still shown, but as an expandable 技术详情 so
 *   operators keep the diagnostic capability;
 * - the detail is passed through `sanitizeContractMessage` again as defence in
 *   depth, so a suspected token / private path / upstream text cannot leak even
 *   if a future error bypassed the construction-time pass.
 */
import { sanitizeContractMessage, type ContractError, type ErrorCode } from '@hdsl/contracts';

/** One-line Chinese title per frozen error code (never the raw port message). */
export const ERROR_CODE_TITLES: Record<ErrorCode, string> = {
  INVALID_INPUT: '输入不合法',
  NOT_FOUND: '未找到目标资源',
  IDEMPOTENCY_CONFLICT: '重复请求的参数与原请求不一致',
  CONTRACT_VERSION_MISMATCH: '界面与主进程的接口版本不一致',
  UNSUPPORTED_COMBINATION: '当前平台不支持该运行时组合',
  REVISION_CONFLICT: '环境组成已变化，请刷新后重试',
  ENVIRONMENT_BUSY: '环境忙碌或有其它事务进行中',
  WEBUI_UNAVAILABLE: '受管工作界面暂不可用',
  DOWNLOAD_FAILED: '运行时下载或校验失败',
  DIGEST_MISMATCH: '产物摘要与受审记录不符',
  DISK_FULL: '磁盘空间不足',
  START_TIMEOUT: '受管进程未在时限内就绪',
  PORT_UNAVAILABLE: '请求的端口不可用',
  PROCESS_EXITED: '受管进程意外退出',
  CANNOT_CANCEL: '操作已提交，无法取消',
  EXPORT_FAILED: '诊断导出失败',
  INTERNAL_ERROR: '内部错误',
  RATE_LIMITED: '上游服务已限流',
  NETWORK_UNAVAILABLE: '网络不可用',
  SOURCE_ACCESS_DENIED: '上游拒绝访问（权限、认证或滥用防护）',
  SOURCE_NOT_FOUND: '上游未找到该仓库、引用、提交或包',
  SOURCE_MANIFEST_INVALID: '来源清单不可读或无效',
  NOT_A_PLUGIN: '该来源未声明 DSH 插件补丁',
  PLAN_EXPIRED: '变更计划已过期',
  PLAN_STALE: '变更计划与当前输入不再匹配',
  PLAN_CONSUMED: '变更计划已被其它请求使用',
  EXECUTOR_UNAVAILABLE: '受管包执行器缺失或与记录不符',
  BUILD_NOT_AUTHORIZED: '该来源需要显式授权构建脚本',
  AUTHORIZATION_MISMATCH: '构建授权与变更计划不匹配',
  UNAUTHORIZED_SCRIPT_EXECUTION: '检测到未授权的安装脚本执行',
  BUILTIN_BUNDLE_PROTECTED: '目标是内置包，不能移除',
  REFERENCED_BY_OTHER: '仍被其它包或用户补丁引用',
  PLUGIN_INTEGRITY_MISMATCH: '重新解析的内容与已记录计划不符',
};

/** Field path → readable Chinese label for structured `INVALID_INPUT` issues. */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  'input.name': '环境名称',
  'input.query': '检索关键词',
  'input.catalogCombinationId': '运行时组合',
  'input.environmentId': '环境',
  'input.expectedRevision': '环境修订号',
  'input.operationId': '操作',
  'input.subscriptionId': '订阅',
  'input.generationId': '代际',
  'input.planId': '变更计划',
  'input.targetGenerationId': '目标代际',
  'input.source.owner': '仓库所有者',
  'input.source.name': '仓库名称',
  'input.source.ref': '引用（ref）',
  'input.operation.rowId': '配置行 id',
  'input.operation.config': '配置 JSON',
  'input.action.source.owner': '仓库所有者',
  'input.action.source.name': '仓库名称',
  'input.action.source.ref': '引用（ref）',
  'input.action.pluginId': '插件',
};

/** Readable Chinese text for the structural issue wording the schemas produce. */
const ISSUE_TRANSLATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^is required$/, '不能为空（缺少该字段）'],
  [/^must be a string$/, '必须是字符串'],
  [/^must be a boolean$/, '必须是布尔值'],
  [/^must be an integer$/, '必须是整数'],
  [/^must be a safe integer$/, '必须是安全整数'],
  [/^must be a finite number$/, '必须是有限数值'],
  [/^is outside the allowed range$/, '超出允许范围'],
  [/^must be a plain object$/, '必须是普通对象'],
  [/^must be an object$/, '必须是对象'],
  [/^must be an array$/, '必须是数组'],
  [/^unknown field$/, '包含未知字段'],
  [/^has an invalid format$/, '格式不正确'],
  [/^must not start or end with whitespace$/, '首尾不能有空白字符'],
  [/^must not contain control characters$/, '不能包含控制字符'],
  [/^must not contain path separators$/, '不能包含路径分隔符（/ 或 \\）'],
  [/^must not be a reserved path segment$/, '不能是保留路径片段（. 或 ..）'],
  [/^must be (\d+)-(\d+) characters$/, '长度需为 $1–$2 个字符'],
  [/^must be at least (\d+) characters$/, '至少需要 $1 个字符'],
  [/^must be at most (\d+) characters$/, '最多 $1 个字符'],
  [/^must have at least (\d+) items$/, '至少需要 $1 项'],
  [/^must have at most (\d+) items$/, '最多 $1 项'],
  [/^must be one of: (.+)$/, '只能是以下之一：$1'],
  [/^must be (.+)$/, '必须为 $1'],
  [/^(\d+) more issue\(s\)$/, '还有 $1 个问题未显示'],
  [/^(\d+) more unknown field\(s\)$/, '还有 $1 个未知字段未显示'],
];

const withCaptures = (template: string, match: RegExpExecArray): string =>
  template.replace(/\$(\d)/g, (_whole, index: string) => match[Number(index)] ?? '');

/** Translates one structural issue text; unknown wording falls back verbatim. */
export const translateIssue = (issue: string): string => {
  for (const [pattern, template] of ISSUE_TRANSLATIONS) {
    const match = pattern.exec(issue);
    if (match !== null) {
      return withCaptures(template, match);
    }
  }
  return issue;
};

/** Parses `invalid input (a: x; b: y)` into readable `label：issue` parts. */
const FIELD_ISSUE_PATTERN = /^invalid input \((.*)\)$/s;

export const fieldHintFromMessage = (message: string): string | null => {
  const match = FIELD_ISSUE_PATTERN.exec(message);
  if (match === null) {
    return null;
  }
  const parts = (match[1] ?? '').split('; ');
  const rendered: string[] = [];
  for (const part of parts) {
    if (part === '') {
      continue;
    }
    const separator = part.indexOf(': ');
    const path = separator === -1 ? part : part.slice(0, separator);
    const issue = separator === -1 ? part : part.slice(separator + 2);
    const label = FIELD_LABELS[path] ?? (path.startsWith('input.') ? path.slice(6) : path);
    rendered.push(`${label}：${translateIssue(issue)}`);
  }
  return rendered.length === 0 ? null : rendered.join('；');
};

export interface LocalizedError {
  /** Short Chinese explanation of the code. */
  readonly title: string;
  /** Field-level Chinese hint for `INVALID_INPUT`, or null. */
  readonly fieldHint: string | null;
  /** Whether the user may retry this failure. */
  readonly retryHint: string;
  /** `CODE：sanitized message` for the expandable technical detail. */
  readonly detail: string;
  readonly code: string;
  readonly retryable: boolean;
}

export const describeErrorLocalized = (error: ContractError): LocalizedError => {
  // Defence in depth: the contract already sanitized `message`, but the value
  // renders inside a new surface, so it is passed through the shared redaction
  // again. This never widens what can be shown.
  const message = sanitizeContractMessage(error.message);
  return {
    title: ERROR_CODE_TITLES[error.code] ?? '操作失败',
    fieldHint: fieldHintFromMessage(message),
    retryHint: error.retryable ? '该失败可重试。' : '该失败不可重试。',
    detail: `${error.code}：${message}`,
    code: error.code,
    retryable: error.retryable,
  };
};
