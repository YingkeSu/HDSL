# E2（#118）契约：只读期望组成

实现：`packages/runtime/src/plugins/expected-composition.ts`（调用 + 解析）、`packages/core/src/expected-composition-service.ts`（操作与装配）。契约 DTO 与 `compositions.expected` 方法定义在 `@hdsl/contracts`；本契约不新增 preload 方法（方法白名单自动包含）以外的 IPC 面。

## 1. 方法

| 方法 | 输入 | 成功 | 失败 |
| --- | --- | --- | --- |
| `compositions.expected` | `{ requestId, environmentId }` | `OperationRef`（幂等，终态 `ExpectedCompositionView` 经 `OperationSnapshot.output`） | `NOT_FOUND`（环境/活动代不存在）、`ENVIRONMENT_BUSY`（运行中）、`INTERNAL_ERROR`（运行时/契约违规） |

只有从 `OperationSnapshot.output` 读取的终态 payload 会经 `expectedCompositionViewSchema` 校验；`operations.get` / `operation.updated` 同样校验。

## 2. 数据模型

```ts
type ExpectedCompositionDiagnosticCode =
  | 'preamble-ignored' | 'group-parse-failed' | 'row-ignored'
  | 'unresolved-construct' | 'truncated';

interface ExpectedCompositionConfig {
  text: string;          // 逐字 YAML 原文（有界）；!!js 不执行
  truncated: boolean;
  unevaluated: boolean;  // 含非字面 tag / alias / merge key
}

interface ExpectedCompositionRow {
  id: string | null;
  name: string | null;      // 普通标量包引用
  nameKnown: boolean;       // 显式 tag/alias/块标量/非字符串 → false
  disabled: boolean | null;
  disabledKnown: boolean;   // !!js / 非布尔 → false
  config?: ExpectedCompositionConfig;
}

interface ExpectedCompositionGroup { label: string; rows: ExpectedCompositionRow[] }

interface ExpectedCompositionView {
  environmentId: string; revision: number; generationId: string | null;
  profileName: string;
  basis: 'dump-config';                 // 固定：离线 dump，不是运行期
  runtimeVerification: 'unavailable';   // 固定：未观测 ACTIVE
  bundles: string[];
  patchReload: 'live' | 'startup' | 'unknown';
  groups: ExpectedCompositionGroup[];
  rowCount: number; stdoutBytes: number;
  stderr: string;                       // 有界、脱敏后原文
  exitCode: number; timedOut: boolean;
  diagnostics: ExpectedCompositionDiagnostic[];
  observedAt: string;
}
```

## 3. 解析语义

- 段落切分：行匹配 `^#\s*==\s*(.+)$`；每段独立 `parseAllDocuments` 要求**恰好一个文档**且顶层为序列。
- `id` 必须是**无显式 tag/alias/块标量**的非空字符串；缺失 → 行被忽略并记 `row-ignored`，不伪造行。
- `name`/`disabled` 的显式 tag（含 `!!js`）、alias、非标量 → 视为未知（`nameKnown`/`disabledKnown = false`）并记 `unresolved-construct`。
- `config` 用 AST `range` 取**原文片段**；子树内非字面 tag / alias / `<<` → `unevaluated: true` + 诊断；`!!js` 原文逐字保留。
- 无首段前言若有非注释内容 → `preamble-ignored`；任意超限 → `truncated`。

## 4. 调用语义

- 参数：受管 Node（该代际） + `dsh/lib/bin.js` + `--profile <published profile>` + `--dump-config`。
- 环境：`HOME=DSH_HOME=<env home>`、`DSH_AGENTS_HOME=<home>/agents`、`TMPDIR=<home>/.tmp`、`PATH=<node bin>:/usr/bin:/bin:/usr/sbin:/sbin`、`DSH_TELEMETRY_DISABLED=1`、`NODE_NO_WARNINGS=1`；**不注入凭据**。
- 禁用 install-child journal（只读 inspection，不写所有权记录）；有界超时与 abort；stdout/stderr 捕获上限。
- `nodeExecutable === process.execPath` 被拒绝（避免 Electron 宿主二进制）。

## 5. 明确排除

- 不提供 ACTIVE/`fiberPhase`/会话接入；不新增私有 Remote。
- 不写 desired config / entry / package / version。
- 不声明 dump 与运行期加载集合等价（E9 未证）。
