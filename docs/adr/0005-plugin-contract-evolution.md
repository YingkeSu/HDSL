# 0005：插件 MVP 的共享契约演进与兼容方案

- 状态：**proposed**（独立复审中。本 ADR 只落设计：不改代码、不改 `version.ts`、不改冻结契约文件、不移动或新增契约标签）
- 修订：rev 2（纳入独立审核 `202bd7b` 的 3 项必修、决策点 1–9 结论与非阻断发现；决策与未决清单见 §5.3、§8）
- 日期：2026-09-21（rev 2：2026-09-22）
- 关联：#74（本任务，Parent #73）；`Refs #9`（M2 插件/事务路线）；`Related #8`（Windows x64 未测门禁）；`Related #15`（契约演进缺口）
- 基线：HDSL main `78552ddf407238833d67848396345196361350a8`；上游固定 tag `dsh-v0.1.5-rc.2` = `fb2c4b9e698e30edb738bca4cf0618587db7d203`（不与 master 混用）
- 依据（可直接核对）：
  - 冻结契约 [local-api.md](../../specs/001-environment-lifecycle/contracts/local-api.md)、[data-model.md](../../specs/001-environment-lifecycle/data-model.md)
  - 可执行实现 `packages/contracts/src/{version,methods,errors,dispatcher,dto,context,digest}.ts`；`packages/runtime/src/composition/digest.ts`
  - 冻结标签 `contracts-v1.0.0` = `3e76a49694f8dcf4c8bba5d32196a6665a2f394e`（PR #28；含 PR #21 `6e267da`）
  - 上游插件边界 [dsh-compatibility.md](../research/dsh-compatibility.md) R003/R005（固定 tag 实测）
- 本机临时依据（**未入库、读者不可核对**；相关结论已摘写入本文）：专职 QA 准备与接口条件清单 §14/§15；编排技术裁决（2026-09-21）。

## 0. 范围、边界与证据等级

**在范围**：契约演进机制与版本选择；新增检索/预览/变更/恢复/代际读取方法的输入、守卫、错误码、幂等、超时与取消语义；与 001 的差异清单（新增/未变/明确不改）与字面量落点；来源锁与摘要边界；受管 pnpm 与默认拒执行的契约面；卸载保护；离线/限流/缓存语义；代际与运行数据（home）边界；`core`/`runtime`/`contracts` 边界；消费方影响；测试 seam 与真实 GitHub 路径分栏；运行时生效观测设计。

**不在范围**：实现任何插件方法；修改 `version.ts`/`local-api.md`/`fixtures.ts`；新增、移动或重打契约标签；引入依赖；执行第三方代码或安装期脚本；真实 GitHub 或模型请求；`specs/002` 正文；`pack.*`/Registry/小程序接口。

**证据等级**（SOP §7）：对 001 的事实陈述标 `verified`（文件与标签可核对）；对上游 DSH 行为的陈述标 `raw`（固定 tag 实测，未实现、未验收）；本文全部插件契约提案为 **spec change proposal**。**不得在评审通过前用于实现 #75**，任何 `raw` 结论不得写成产品承诺或 issue 验收断言。

## 1. 背景

- 001 契约已冻结并打标签 `contracts-v1.0.0`：wire 版本 `API_VERSION = "1.0"`，**完全匹配**，任何 major/minor 不一致在任何副作用前拒绝为 `CONTRACT_VERSION_MISMATCH`。
- 001 只预留了 `changes.preview` / `changes.apply` / `generations.restore` 三个名字，**未定义输入结构、未暴露为可调用方法**；`pack.*` 明确留给 003。
- 父 PRD #73 需要检索、来源预览、安装/卸载事务与恢复能力，必须在不回退 001 行为、不改冻结标签的前提下演进共享面。
- 完全匹配语义带来一个硬约束：**不存在"向后兼容的新增"**——只要共享面变化，就必须显式改版本并同步两侧（renderer 与 main 共用同一构建产物），否则新字段/新方法会被严格 unknown-field 校验拒掉。
- QA 准备清单 §14/§15（本机临时依据）指出：若 #74 不给机制结论，S1 的契约 fixture 无法冻结；且"预览判定脚本"与"apply 验证未执行"是两种机制，AC 表述必须拆分。本 ADR 对这两点做出契约级决定。

## 2. 事实基线（证据等级：verified / raw）

| # | 事实 | 证据 | 来源 |
| --- | --- | --- | --- |
| F1 | `API_VERSION = '1.0'`，`matchesApiVersion` 为严格相等；版本不匹配 → `CONTRACT_VERSION_MISMATCH`，**不执行方法** | verified | `packages/contracts/src/version.ts`、`dispatcher.ts` |
| F2 | 校验顺序固定：包络 → apiVersion 结构 → 完全匹配 → 方法白名单与严格输入 → 幂等 → 资源/修订/平台守卫 → in-progress 标记、端口效果、出站 DTO 复校验 | verified | `dispatcher.ts` |
| F3 | 方法白名单恰 11 个：`catalog.list`、`environments.{list,create,start,stop,openWebUI}`、`operations.{get,cancel,subscribe,unsubscribe}`、`diagnostics.export` | verified | `methods.ts` |
| F4 | 错误码恰 17 个；`retryable` 集合为 `ENVIRONMENT_BUSY`、`WEBUI_UNAVAILABLE`、`DOWNLOAD_FAILED`、`DISK_FULL`、`START_TIMEOUT`、`PORT_UNAVAILABLE`、`PROCESS_EXITED`、`EXPORT_FAILED` | verified | `errors.ts` |
| F5 | 幂等账本两态：`in-progress`（守卫全通过、效果前写入；重放 → `ENVIRONMENT_BUSY`）与 `completed`（重放返回原结果）；**纯守卫拒绝不写记录**；`retryable` 重试必须用新 `requestId` | verified | `local-api.md`、`context.ts` |
| F6 | `expectedRevision` 是**组成修订**；`stateVersion` 独立；仅创建与活动代际切换递增 | verified | `data-model.md` |
| F7 | 摘要输入子集 = `schemaVersion` + node/dsh 的 `version/platform/arch/sha256` + 排序后的 `plugins`；`sources` 永不进入摘要；`PluginLock = {id, version, sha256}`；`CompositionLock.schemaVersion` 字面量 `'1'` | verified | `digest.ts`、`dto.ts` |
| F8 | `packages/runtime/src/composition/digest.ts` 当前硬编码 `plugins: []` | verified | 运行时实现 |
| F9 | `Operation.kind` 枚举为 `create/start/stop/openWebUI/export`；`OperationSnapshot` **没有结果载荷字段**；`phase` 是受控自由文本（≤64，脱敏）；`environmentId` 为 `sNullable` | verified | `dto.ts` |
| F10 | 取消语义：`operations.cancel` 尽力取消；提交后 → `CANNOT_CANCEL`；**取消不等于系统回滚** | verified | `local-api.md` |
| F11 | 上游插件安装是 pnpm 转发器；构成落盘三元组为 profile `package.json`（`dependencies` + `dsh.profile.bundles`）+ `pnpm-lock.yaml` + `cordis.patch.yml`；GitHub 源取源码而非构建产物；pnpm ≥10 默认阻止 `prepare`，需写 profile `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑；官方要求 pin commit；运行中的 profile 必须重启才生效；隔离单元是 profile 而非 OS 沙箱；无 `dsh.bundle` 声明的依赖只作普通依赖并 warning | raw | R005（固定 tag 实测） |
| F12a | 内置/in-box bundle 永远来自**当前受管 DSH 安装**；profile 级依赖不改变该来源 | raw（实测） | R003 |
| F12b | "bundle 名先按当前 dsh 安装解析、再按 profile 解析"的解析顺序，以及"启用列表出现未声明 `dsh.bundle` 的条目 → profile 加载失败"：**仓库内无出处**（R005 只实测"未声明 → 普通依赖 + warning"；PRD #73 的 fail-loud 表述在本仓库不可核对）。**不得作为断言，也不得写入 issue 验收文案**（§9.5 据此降级） | 无出处 | — |
| F13 | 每代目录结构为 `<generationDirectory>/home`（`homeDirectory`），且启动时 `DSH_HOME = HOME = homeDirectory`；`sessions`/`storages`/`.anonymous-user-id`/`.credentials.yaml`（0600，含密）都在其下 | verified | `packages/core/src/layout.ts`、`creation-service.ts` |
| F14 | `dsh --dump-config`/`--dump-default-config` 可**离线查看组合树**；其"不 require/执行 bundle 模块"的静态性与"运行期实际加载集合"的等价性**未验证**（列 E9） | raw | R003 |
| F15 | rc.2 tag 与本仓库 `packageManager` 均声明 `pnpm@11.7.0`（作为**产品锁定候选**的可用性未验证，见 E1） | verified（声明）+ 候选 | 仓库文件、上游 tag |

F12b 已在 rev 2 从断言降级为"无出处"；D15 的内置保护机制改以 F12a（安装解析集合）为依据，不依赖 F12b。

## 3. 决策

### D1 完全匹配语义保留，禁止"同版本静默放宽"

保留 F1/F2。**禁止**在 `API_VERSION = "1.0"` 不变的前提下新增方法、字段、错误码或 `operationKind` 值。任何共享面变化 = 一次显式版本变更，同步更新 `version.ts`、`local-api.md`（文档 rev 与 wire 版本两轴）、可执行 fixture 表，并由编排者按精确 merge SHA 打**新**标签。§7 中"保持 1.0 追加"与"接受 1.x minor 兼容/协商"两个替代方案据此排除。

### D2 版本号：评审接受 `1.1`（机制不受数字影响）

本 ADR 固定**机制**（D1、D3、D5）。评审（`5770298091`）接受推荐值 `1.1`，理由见 §5.3；本 ADR 保持 `proposed`，待编排确认后转 `accepted` 并在 §5.3 固化。批准与打标签前，任何实现切片**不得**改 `version.ts`。

### D3 冻结标签不可变

`contracts-v1.0.0` 及其 commit 保持只读：不移动、不删除、不重打、不 force-push。新版本用新标签，命名沿用 001 先例 `contracts-v<major>.<minor>.0`（`contracts-v1.0.0` ↔ `API_VERSION = "1.0"`）。

### D4 检索/预览/变更/恢复/代际读取的方法集

| 方法 | 类别 | 输入要点 | 返回 | 环境作用域 |
| --- | --- | --- | --- | --- |
| `plugins.search` | 长时操作（Operation） | `requestId`, `query`（1–256 字符） | `OperationRef` | 全局（`environmentId` 为 `null`） |
| `plugins.inspect` | 长时操作 | `requestId`, `source {owner, name, ref?}` | `OperationRef` | 全局 |
| `changes.preview` | 长时操作 | `requestId`, `environmentId`, `expectedRevision`, `action {kind: install, source} \| {kind: remove, pluginId}` | `OperationRef` | 单环境 |
| `changes.apply` | 长时操作（事务） | `requestId`, `environmentId`, `expectedRevision`, `planId`, `buildAuthorization?` | `OperationRef` | 单环境 |
| `generations.restore` | 长时操作 | `requestId`, `environmentId`, `expectedRevision`, `targetGenerationId` | `OperationRef` | 单环境 |
| `generations.list` | 只读即时查询（无 `requestId`） | `environmentId` | `GenerationSummary[]` | 单环境 |

- **返回风格规则**（解释语义一致性）：长时/网络/事务类 → `OperationRef` + 终态 `output`（D5）；只读即时查询 → 直接返回值。据此 `generations.list` 直接返回，而 `plugins.search`（网络 + 可取消）返回 `OperationRef`。
- 预留名字 `changes.preview` / `changes.apply` / `generations.restore` 从"仅文档预留"提升为白名单成员；`pack.inspect` / `pack.import` / `pack.export` **继续预留**，不暴露（003 定义）。
- 命名（`plugins.*` 前缀）属提案，评审可改；改名的成本与实现同步更新 `CONTRACT_METHODS`、fixture、preload 白名单与本文方法表。
- `source` 输入**只接受 GitHub 仓库引用**（`owner`/`name`/可选 `ref`）。`link:`/`file:`/本地路径/任意 URL/自由包名一律 `INVALID_INPUT`，与 PRD"源是 GitHub 公开仓库"的 Out of Scope 一致，并在入口即阻断本地路径泄漏与"用普通目录冒充来源锁"。

### D5 长时操作统一复用既有 Operation 生命周期；`output` 的逐 kind/state 必填规则

- 检索/预览/应用/恢复**不新增**取消、订阅或流式机制：一律返回 `OperationRef`，进度、取消、重连复用 `operations.get` / `operations.cancel` / `operations.subscribe`（含 F10 语义）。
- `OperationSnapshot` 新增**可选**字段 `output`，承载终态结果（`ChangePlan` / `PluginSearchResult` / `PluginInspection` / `ChangeApplication` / `GenerationSummary`）。**必填/缺席规则按 kind × status 固定**（评审决策点 2）：
  - `status = 'succeeded'` 且 kind ∈ {`search`, `inspect`, `preview`, `apply`, `restore`} → `output` **必须存在**且通过该 kind 的 schema；
  - `status ∈ {'queued','running'}` → `output` **必须缺席**；
  - `status ∈ {'failed','cancelled'}` → `output` **必须缺席**（终态失败信息只在 `error`）；
  - 既有 kind（`create`/`start`/`stop`/`openWebUI`/`export`）→ `output` **必须缺席**（保持 001 行为）。
  - 任何违反 = main 边界出站校验失败 → `INTERNAL_ERROR`（不把畸形载荷透传）。
- `operation.updated` **事件不携带** `output`：事件只带 `subscriptionId/operationId/sequence/phase/status/progress?`；结果只能通过 `operations.get` / `operations.cancel` 的终态快照读取。
- 结构化载荷按 D19 的**字段白名单** schema 化并设条目/长度上界；脱敏规则与其它出站值一致（受控文案 + 本地上路径/token/cookie 不出现）。
- **全局操作隔离**（评审决策点 3）：全局 `plugins.search` / `plugins.inspect` **不受任何环境 `ENVIRONMENT_BUSY` 影响**；某环境存在 in-progress 事务也不阻塞全局操作。环境级方法的 `ENVIRONMENT_BUSY` 语义不变。
- 备选（评审可改）：用"仅返回不透明 id + 每种结果一个只读方法"替代 `output`。被否理由：需要 3 个额外只读方法与 3 个额外 id 域，且 `changes.apply` 的终态摘要仍无处放置。

### D6 预览与提交分离；Change plan 是带修订与有效期的独立对象

- `changes.preview` 产出 `ChangePlan`：`planId`、`environmentId`、`baseRevision`、`action`、`createdAt`、`expiresAt`、`sourceLock`（安装时）、`actions {removals[], retention[]}`、`blockingReferences[]`、`scriptAssessment`、`requiresBuildAuthorization`、`riskItems[]`、`planInputsDigest`。
- preview **不改变**环境组成、活动代际指针、来源锁（允许写 cache/journal/临时文件，且在界面可解释；不得宣称"磁盘绝对不变"）。
- preview 运行中可以执行（只读语义 + 计划落盘），**apply 在运行中一律拒绝**（`ENVIRONMENT_BUSY`），与 PRD US15/US16 一致。
- **守卫优先级**（评审决策点 6）：修订守卫先于计划守卫——`expectedRevision` 漂移一律 `REVISION_CONFLICT`，即使该计划同时已过期/陈旧/已消费。顺序见 D8。

### D7 预览是"静态/解析风险摘要 + 未知项"，不是"闭包绝无脚本"的保证

依编排裁决与 QA §15.2：

- `scriptAssessment` 只有三类：`none-detected`（解析到的清单中未见安装期脚本）、`detected`（确有脚本）、`unknown`（清单不完整、锁缺失、依赖闭包未完全解析、格式不受支持等）。
- preview **不得**输出"保证不执行脚本"之类结论；`requiresBuildAuthorization` 在 `detected` 或 `unknown` 时为真。
- **权威保证来自 apply**：默认拒执行 + **执行期可失败哨兵**。apply 若观测到任何第三方安装期脚本被执行，则在提交前以 `UNAUTHORIZED_SCRIPT_EXECUTION` 失败并回滚。
- 该分工修正了 #76 AC 中"预览判定…安装过程验证到没有第三方脚本被执行"的混合表述（见 §9.1）。

### D8 防 TOCTOU：apply 以计划为基准重新解析与复核，全部比较先于任何写操作

- 计划记录 `commitSha`、`manifestDigest`、`closureLockDigest`、脚本集合、`executor {id, version, sha256}` 与 `planInputsDigest`。
- **`closureLockDigest` 必须取自完全 pin 的 lockfile 解析结果，不得来自 semver 范围**（评审补充；否则"同 commit 同 manifest 但依赖解析变化"只能靠提交时重算兜底；E4/E6）。
- **`executor` 身份纳入 `planInputsDigest`**（评审决策点 5）：preview→apply 之间受管 pnpm 身份变化必须可检出（`EXECUTOR_UNAVAILABLE` 或判断为计划陈旧），不允许静默换执行器。
- apply 的顺序固定为：版本 → 输入 → 幂等 → 环境/修订（`REVISION_CONFLICT`）→ 计划（`NOT_FOUND`/`PLAN_EXPIRED`/`PLAN_STALE`/`PLAN_CONSUMED`）→ 忙碌/运行中（`ENVIRONMENT_BUSY`）→ **重新解析并复核**（commit 可达性、manifest/闭包摘要、脚本集合、执行器身份、授权绑定）→ 效果（准备新代际 → 写来源锁 → 写启用引用 → 受管 pnpm）→ 验证 → 切换活动代际（提交点）。
- 复核失败映射（互斥，评审决策点 7）：源内容与计划记录的摘要不符 → `PLUGIN_INTEGRITY_MISMATCH`；提交的授权未精确绑定计划的 commit + 脚本集合 → `AUTHORIZATION_MISMATCH`；环境侧非修订输入（启用集合、用户 patch 引用）漂移 → `PLAN_STALE`；`expectedRevision` 漂移 → `REVISION_CONFLICT`（复用 001 语义，且优先于计划类错误）。
- **所有比较在任何写操作之前完成**；`buildAuthorization` 与重新解析出的集合逐项相等（集合相等 + commit 相等），不做子集/前缀匹配。

### D9 计划过期、陈旧与消费

- `PLAN_EXPIRED`：超过 `expiresAt`。
- `PLAN_STALE`：`planInputsDigest` 失配（环境侧非修订输入漂移，含用户 patch 层引用变化——这部分不被 `revision` 覆盖）。
- `PLAN_CONSUMED`：同一 `planId` 已被另一个 `requestId` 成功消费。真正的重放（同 `requestId` + 同参数）按 F5 返回原记录结果，不触发本码。
- **优先级**：`REVISION_CONFLICT` 先于以上三者（D6/D8）；四者互斥，均**无副作用**。
- 三者均**非 retryable**；修复路径明确（重新 preview / 重试时用新 `requestId`）。
- **过期重放的 UI 标注**（评审决策点 6）：重放返回的计划若已过期，UI 必须标注"已过期（重放结果，未重算）"，apply 时得到 `PLAN_EXPIRED`；重放**不得**静默重算或静默刷新有效期。

### D10 取消与提交边界

- **提交点 = 活动代际指针切换**。提交前取消 → 操作终态 `cancelled`，环境组成、活动代际指针与旧可用代际不变，临时 stage 清理，journal/失败证据准确写入（cache/journal 写入不算副作用）。
- 提交后取消 → 复用 `CANNOT_CANCEL`（F10）；界面与日志必须如实报告"已提交，可显式恢复到上一代际"，**不得**称已回滚。显式恢复走 `generations.restore`。
- 检索/预览路径同样支持取消（D5），取消为终态、无环境副作用；已完成的 preview 取消返回 `CANNOT_CANCEL`，其计划按 TTL 自然过期（这是允许的 cache/journal 产物）。

### D11 错误码：新增 15 个、复用 001 既有码

新增 15 个，其中仅 `RATE_LIMITED`、`NETWORK_UNAVAILABLE` 为 `retryable`，其余为确定性拒绝：

| code | 语义 | 触发点 |
| --- | --- | --- |
| `RATE_LIMITED` | GitHub 限流（403/429），携带 `retryAfterSeconds?` | `plugins.*` 网络路径 |
| `NETWORK_UNAVAILABLE` | 无连接/离线/连接中断/TLS 失败/整体超时（**连接建立前**） | `plugins.*` 网络路径 |
| `SOURCE_NOT_FOUND` | 仓库、ref 或提交不存在；锁定的 commit 不可达 | inspect/preview/apply 复核 |
| `SOURCE_MANIFEST_INVALID` | manifest 不可读/非法 JSON/超出上界 | inspect/preview |
| `NOT_A_PLUGIN` | 未声明 `dsh.bundle.patch`，不得进入层栈 | 安装类 preview/apply |
| `PLAN_EXPIRED` | 计划超过有效期 | apply |
| `PLAN_STALE` | 计划输入漂移 | apply |
| `PLAN_CONSUMED` | 计划已被其它请求消费 | apply |
| `EXECUTOR_UNAVAILABLE` | 受管 pnpm 缺失、版本或摘要不符（含 preview→apply 间身份变化） | apply（受控失败） |
| `BUILD_NOT_AUTHORIZED` | 源需要执行脚本但未给授权 | apply（默认拒） |
| `AUTHORIZATION_MISMATCH` | 授权未精确绑定计划 commit + 脚本集合 | apply |
| `UNAUTHORIZED_SCRIPT_EXECUTION` | 执行期观测到未授权/未预期的第三方脚本 | apply（提交前失败并回滚） |
| `BUILTIN_BUNDLE_PROTECTED` | 目标是安装解析出的内置 bundle | remove preview/apply |
| `REFERENCED_BY_OTHER` | 移除会破坏其它 bundle/配置解析，或被用户 patch 层引用 | remove preview/apply |
| `PLUGIN_INTEGRITY_MISMATCH` | 复解析内容与计划记录的 manifest/闭包摘要不符 | apply 复核 |

**下载失败 vs 网络失败的映射**（评审决策点 7）：

- **连接建立前**（DNS/离线/TLS/整体超时）→ `NETWORK_UNAVAILABLE`（新，retryable）。
- **连接已建立、传输/取物失败**（git fetch 中断、tarball/archive 部分下载、校验前后中断、磁盘写入）→ **复用既有 `DOWNLOAD_FAILED`**（retryable），不新造同义码；`DISK_FULL` 仍单独用于空间不足。
- 限流（403/429）→ `RATE_LIMITED`（新，retryable，带 `retryAfterSeconds`）。
- 对象/ref/commit 不存在 → `SOURCE_NOT_FOUND`（非 retryable）。
- 该映射同属 D16，并被 §4.1 的错误码差异清单引用。

`retryable` 集**新增** `RATE_LIMITED`、`NETWORK_UNAVAILABLE`（瞬时网络状态）；其余为确定性拒绝，不可重试（与 F4 的分类原则一致）。

复用（**语义不变**）：`INVALID_INPUT`、`NOT_FOUND`、`IDEMPOTENCY_CONFLICT`、`CONTRACT_VERSION_MISMATCH`、`UNSUPPORTED_COMBINATION`（含未测平台的平台门禁）、`REVISION_CONFLICT`、`ENVIRONMENT_BUSY`、`CANNOT_CANCEL`、`DOWNLOAD_FAILED`、`DISK_FULL`、`INTERNAL_ERROR`。

失败包络新增**可选** `retryAfterSeconds`（限流重试时机需可机读；把时间塞进受控文案会让 UI 无法行动也无法断言）。这是对既有 DTO 的加字段，属 1.1 允许类（§5.3）。

### D12 幂等与超时

- 新操作类方法沿用 F5：`in-progress` 重放 → `ENVIRONMENT_BUSY`（不重做效果）；`completed` 重放 → 原结果；守卫拒绝不写记录；`retryable` 失败重试必须用新 `requestId`。
- 预览重放返回**原计划**（含已过期的计划），TTL 只在 apply 检查——重放永不重算，与 F5 一致；UI 标注见 D9。
- 所有网络与事务路径必须有**硬超时**；超时对当时相位映射为受控终态（连接建立前 → `NETWORK_UNAVAILABLE`；传输中断 → `DOWNLOAD_FAILED`；事务相位 → 提交前取消/失败语义或 `CANNOT_CANCEL`），不出现"无限等待"或"无终态"。

### D13 来源锁与组成摘要边界

- **摘要身份不变**（F7）：`PluginLock = {id, version, sha256}` 仍是唯一进入组成摘要的插件身份；排序键不变。插件组成（`plugins` 非空）是**新组成**，只影响新代际的摘要，不回退既有 `plugins: []` 组成的摘要字节。
- 新增**非摘要**来源锁 `PluginSourceLock`：`{sourceKind: 'github', repository {owner, name}, commitSha(40 hex), ref?, packageName, packageVersion, manifestSha256, closureLockSha256, isBuiltin, buildAuthorization?, executor {id, version, sha256}?}`。理由与 001 的 `sources` 完全同构（issue #15 N3）：来源可供追溯，但**永不进入摘要**，镜像/URL 变化不改变组成身份。
- `CompositionLock` 新增**可选**非摘要字段 `pluginSources`；缺失 = 无插件来源记录（与既有 `plugins: []` 组成兼容）。**fixture 断言**（评审决策点 4）：同一组成带与不带 `pluginSources`，`compositionDigest` 字节相等。
- 所有路径与凭据不得进入来源锁（QA 的 canary 断言覆盖）。
- `PluginLock.id/version/sha256` 与 `closureLockSha256` 的精确推导（git 源闭包摘要）由 002 规格固定并加 fixture；本 ADR 只冻结性质：必须是**已解析安装产物**的确定性函数、平台无关、不依赖 ref/分支名、且来自完全 pin 的 lockfile（D8）。

### D14 受管 pnpm 执行器与默认拒执行

- pnpm 版本与来源由 HDSL 确定并**显式路径**调用（参数数组，不拼 shell），不依赖宿主偶然 PATH；缺失、版本或摘要不符 → `EXECUTOR_UNAVAILABLE`（受控失败，不隐式回退宿主 pnpm）。
- pnpm 身份**不进** `RuntimeCombination`，也**不进**组成摘要；它作为执行期来源记录在 `PluginSourceLock.executor` 与操作 journal（非摘要），并纳入 `planInputsDigest`（D8）。理由：环境运行时是 node + DSH + 插件；解析后的闭包已由 `plugins` 摘要身份捕获，两个 pnpm 版本产出同一闭包即同一组成。若评审要求构建可复现必须包含执行器身份，则属 001 DTO 变更 → 只能 `2.0`（§8-5）。
- 默认**不放行任何第三方安装期脚本**（含依赖闭包、含 npm 包与 tarball；不因包格式视为天然安全）。需脚本的源走 #78（S4）显式授权，这是有意的 MVP 范围，不是缺陷。
- 授权绑定精确 `commitSha` + 精确脚本集合（每项含包键与脚本名），**禁通配、禁按作者信任、禁生成全局放行等价配置**（不写 `allowBuilds`/`onlyBuiltDependencies` 之类的全局开关）；commit 变化即授权失效。
- 权威保证是"默认拒执行 + 执行期观测"（D7）：受管 pnpm **身份**（精确版本 + tarball 摘要）与"未执行"的**可观测信号**属待实证（E1），由 S2 在受管版本上以哨兵负控冻结（覆盖 `prepare`/`preinstall`/`install`/`postinstall` 与依赖闭包），不得用宿主机 pnpm 当证据。

### D15 卸载三分支、内置保护与运行时生效观测

- **同包保留（预期）**：共享/传递依赖按 lock 保留，预览在 `retention` 中说明，不判为残留失败。
- **启用层/配置破坏（拦截）**：`REFERENCED_BY_OTHER`，预览列出 `blockingReferences`（含引用来源），apply 复核（漂移 → `PLAN_STALE`）。
- **用户 patch 引用（默认拦截 + 建议）**：`REFERENCED_BY_OTHER`（kind `userPatch`）；不改用户 patch 文件，不静默移除。
- **内置保护**：`isBuiltin` 必须由**当前受管 DSH 安装解析出的 in-box bundle 集合**判定（F12a，verified），不由客户端提供；命中 → `BUILTIN_BUNDLE_PROTECTED`。负控必须使用**当前安装的真实 in-box 名**，禁止用同名 profile 替身造假绿。F12b（解析顺序 / fail-loud）无仓库出处，**不作为本机制的论据，也不写入 issue 文案**（§9.5）。
- **精确目标**：不做通配清理；只移除本次事务的直接依赖条目与启用引用。
- **运行时生效观测**（QA §14.7）：文件检查**不构成**生效证据。生效判据由三面组合：
  1. 契约只读面：`generations.list` 返回活动代际、组成摘要与来源锁（HDSL 的权威记录）；
  2. 独立运行时解析：用受管 DSH 的**离线配置转储**（`--dump-config`/`--dump-default-config`，F14）得到**离线解析出的组合树**；它与"运行期实际加载集合"的等价性**待实证（E9）**，在实证前不得写成唯一生效 AC 或产品承诺；
  3. 时序门禁：运行中 apply → `ENVIRONMENT_BUSY`；停止并重启后加载集合与新代际记录一致，卸载后不再包含该包。
  该观测是**验证 seam**，本 MVP 不因此新增 `--dump-config` 类 IPC 方法。

### D16 离线、限流与缓存语义

- 限流（403/429）→ `RATE_LIMITED` + `retryAfterSeconds`（可机读，UI 说明重试时机）；连接失败 → `NETWORK_UNAVAILABLE`；传输失败 → `DOWNLOAD_FAILED`（D11 映射）；都不**改环境组成**，且**不得**退化为含糊失败。
- 缓存语义的不变量：**缓存只能用于展示发现结果，不能用于授权变更**。任何变更绑定身份（commit SHA、manifest/闭包摘要、脚本集合、授权）必须在 preview/apply 时重新解析或复核（D8），不得取自缓存。
- `PluginSearchResult` 暴露 `query`（与实际发出的查询逐字符一致，1–256 字符）、`hits[]`、`totalCount`、`incompleteResults`、`hasMore`、`fetchedAt`、`fromCache`；默认查询与过滤条件（如 topic、`fork:false archived:false`）必须体现在该字符串中。界面据此区分"确实这么少"与"结果被截断"，并显示"发现不代表可安装或安全"。
- `plugins.*` 与 `changes.*` 的输入**没有** GitHub 凭据字段；MVP 路径不使用凭据（PRD US33），也不得从环境继承或落盘任何 GitHub token。

### D17 `core` / `runtime` / `contracts` / `main` 边界

- `packages/contracts`：版本、包络、方法 schema、DTO、错误码、dispatcher 守卫与计划守卫（TTL/陈旧/已消费的判定语义；状态数据经端口读取）。
- `packages/core`：计划存储与消费标记、来源锁持久化、代际事务协调与切换、journal/reconcile、运行数据（home）派生决策的落地；**不做网络、不起子进程、不加载插件代码**。
- `packages/runtime`：GitHub 查询/ref 解析/manifest 与闭包读取适配器、受管 pnpm 执行器（显式路径 + 参数数组）、脚本执行观测。**第三方插件代码永不进入 main/renderer 进程**。
- `apps/desktop` main：端口接线与出站脱敏；preload：仅白名单方法（**不新增**通用 `invoke`/任意通道）。
- `ContractPort` 新增能力（对齐既有 `createEnvironment` 风格）：`searchPlugins`、`inspectPluginSource`、`previewChange`、`applyChange`、`restoreGeneration`、`listGenerations`，以及计划守卫所需的 `findChangePlan`、`markChangePlanConsumed`、`findGeneration`（镜像 `readIdempotency`/`writeIdempotency` 的受信模式）。
- `tests/engineering/workspace-boundaries.test.ts` 的 core/runtime 不互相 import 约束**不得放宽**。

### D18 代际与运行数据（home）边界：契约级不变量 + 机制延后（#76 硬前置）

评审必修 3 指出：F13 已核 `DSH_HOME = <generation>/home`，`sessions`/`storages`/`.credentials.yaml` 都在其下；D10/D15 却承诺"旧代际可启动 / 保留用户环境数据"。

- **契约级不变量（本 ADR 决定，不延后）**：
  1. 插件安装/卸载/恢复事务**不得破坏、覆盖或丢失**当前活动代际下用户的运行数据（`sessions`、`storages`、`.anonymous-user-id`、`.credentials.yaml` 等含密产物）。
  2. 提交前失败/取消后，**旧代际必须仍可启动**且其运行数据可读。
  3. 运行数据**不因组成变更而分叉为不可达**：用户切换代际后仍能读到同一环境的会话/存储（具体共享方式见下）。
  4. 含密产物（`.credentials.yaml`）不得被复制到环境外，也不得进入导出/日志（ADR 0002 边界不变）。
- **机制（复制上一代 / 覆盖共享 / 仅 stage profile）**：**延后由 002 规格决定**，并列为 **#76 的硬前置**：**#76 开工前**，必须完成 home 派生机制、含密文件（`.credentials.yaml` 等）处理、可变运行数据（`sessions`/`storages`）归属与旧代恢复语义的**决策 + 相关实证**；该决策的 owner 归 **#76 实现设计**（本 P0 不代做）。在机制落地并实证前，上述不变量是**条件性承诺**：不得作为已交付能力声明、不得写成无条件的 #76 AC 通过证据，**本 P0 的合入也不宣称该保证已实现**。
- **可追踪性（不穿透实现门禁）**：该门禁同时登记在 §9.7，确保不因 P0 合入而被穿透；在 002/#76 给出决策与实证前，#76 的实现门禁视为未满足。
- **崩溃恢复**：该机制的崩溃边界（stage 中、home 派生后、指针切换前/后）必须有故障注入与 reconcile 说明；列入 E10。

### D19 测试 seam 与真实 GitHub 路径分栏（本地 fixture 不可冒充真实链路）

| 能力 | 测试 / 适配器 seam（默认 CI，离线确定性） | 真实 GitHub 路径（显式 gate，不进默认 CI） |
| --- | --- | --- |
| 来源解析 | 注入 provider 映射到**本地受控 Git remote**（`file://` 或 loopback `git daemon`），仍产出真实 `git rev-parse` commit | 真实 HTTPS API：搜索、计数、限流头、`codeload`、重定向、代理、TLS 错误码 |
| 安装 | 假 pnpm 执行器 + 临时 profile（默认 CI）+ 受管真实 pnpm（opt-in 真实 desktop） | 真实远程获取 → 锁 → 安装（有界授权下的端到端） |
| 能证明 | 来源锁 schema/不可变性、默认拒执行哨兵、启用对账、卸载重算、事务边界、取消语义 | 域语义、限流/离线真实形态、下载中断与清理 |
| 不能证明 | HTTPS/TLS/代理/重定向、真实限流额度与排序、`codeload` 行为 | —（反向：真实探针不能替代事务故障注入） |

硬规则：

1. **产品源语义只有公开 GitHub**；本地 Git remote 只是**测试 adapter 传输映射**，不得出现在生产 wiring，也不得让 `link:`/`file:` 普通目录伪装成来源锁或 GitHub 全链路（D4 已在输入层拒绝）。
2. 本地 fixture 必须携带真实可解析的 commit 与"预览后 head 前进/锁定 commit 不可达"用例，才能覆盖来源锁定与漂移。
3. "远程获取 → 解析精确 commit → 锁定 → 安装 → 重启生效 → 卸载"的最终证明**仍须独立 opt-in 真实链路**，本地 fixture 通过**不**构成该证明。
4. gate 命名（候选 `HDSL_QA_GITHUB_PROBE`、`HDSL_E2E_PLUGIN`）在实现切片落地前**不写入仓库/CI 配置**；本 ADR 只要求"默认 CI 完全离线可复现全部失败/取消场景"和"跳过不计通过"。

### D20 用户界面可实现性（契约侧约束）

- 每个新错误码有受控、可行动的文案与 `retryable`/`retryAfterSeconds`；`INTERNAL_ERROR` 不得吞掉可分类失败。
- `ChangePlan` / `PluginInspection` / `PluginSearchResult` / `ChangeApplication` / `GenerationSummary` 必须自带 UI 所需全部字段（commit、包名/版本、manifest 摘要、依赖与许可摘要、`isPlugin`、`scriptAssessment`、脚本清单（含依赖闭包）、风险项、移除/保留项、阻塞引用、`expiresAt`、`baseRevision`、执行器身份），使 UI 无需第二次特权调用。
- **结构化载荷按字段白名单 schema 化**（allow-list，不是 deny-list），与 D5 的 `output` 规则一致；列表与文本有明确上界（搜索结果分页 + `totalCount`/`hasMore`、脚本条目上限、错误消息 ≤512 字符），超界以计数表示，**不静默截断**。
- 默认拒执行与显式授权的两态文案必须区分；文案必须写明"安装期在你的机器上执行该包代码，不受 DSH 或 HDSL 沙箱保护"，且**不得**写成"永不执行第三方代码"。
- Windows x64 未测：不可用平台以 `UNSUPPORTED_COMBINATION` 或等价能力门禁呈现，文案必须说明未实测，不暗示支持。

## 4. 与 001 契约的差异清单

### 4.1 新增

| 类别 | 项目 |
| --- | --- |
| 方法 | `plugins.search`、`plugins.inspect`、`changes.preview`、`changes.apply`、`generations.restore`（预留名提升）、`generations.list`（只读即时） |
| DTO | `PluginSearchResult`、`PluginSearchHit`、`PluginInspection`、`PluginSourceLock`、`ChangePlan`、`ChangePlanAction`、`ChangeBlockingReference`、`BuildScriptEntry`、`BuildAuthorization`、`ChangeApplication`、`GenerationSummary` |
| 既有 DTO 的加可选字段 | `OperationSnapshot.output?`（逐 kind/state 必填规则见 D5）；`ContractError.retryAfterSeconds?`；`CompositionLock.pluginSources?`（非摘要，摘要字节不变见 D13） |
| 枚举 | `operationKind` 新增 `search` / `inspect` / `preview` / `apply` / `restore` |
| 错误码 | D11 的 15 个新码；`retryable` 集新增 2 项；复用既有 `DOWNLOAD_FAILED` 承载传输失败 |
| 端口 | `ContractPort` 新增 D17 的能力（含计划守卫读取/消费） |
| 文档 | `local-api.md` 的预留段替换为 002 规格指针；本 ADR §4 为 002 之前的权威差异出处 |

### 4.2 未变

- 完全匹配与校验顺序（F1/F2）；`CONTRACT_VERSION_MISMATCH` 语义。
- 既有 11 个方法的名称、输入、输出、守卫、错误码与 `readOnly`/`idempotent` 属性。
- 幂等账本语义（F5）；`expectedRevision` = 组成修订、`stateVersion` 独立（F6）。
- 摘要输入子集、规范化 JSON、64 位小写十六进制摘要（F7）；`sources`/`pluginSources`/pnpm 身份永不进入摘要。
- 失败/成功包络结构（除新增可选字段）、消息脱敏与长度上界、错误不含栈/密钥/token/cookie/本地绝对路径。
- `operation.updated` 的每 operation `sequence`、订阅/退订语义（F9/F10），且事件面**不携带** `output`。
- preload 白名单与"无通用 invoke"边界；core/runtime 不互相 import。

### 4.3 明确不改

- 不移动/删除/重打 `contracts-v1.0.0` 或任何既有标签；不 force-push。
- 不引入 minor 向后兼容、双向版本协商、自动降级或静默放宽。
- 不为插件能力引入第二套取消/订阅/流式机制（D5）。
- 不引入 GitHub 凭据、任意 IPC/HTTP 通道或通用 `invoke`（D16/D17）。
- 不承诺 OS 沙箱或"永不执行第三方代码"；不为插件加载加沙箱承诺。
- 不允许构建授权通配、按作者信任或全局放行配置（D14）。
- 不把 `sources`/来源锁/pnpm 身份加入组成摘要（D13/D14；除非评审按 §8-5 另决）。
- 不把 `pack.*`、Registry、小程序接口纳入本 MVP。
- 不改变既有 11 方法的任何语义来"顺便"支持插件。
- **本片不修改** `version.ts`/`local-api.md`/`fixtures.ts`/`plan.md`/`desktop-integration.md`（字面量迁移见 §4.4，由实现切片执行）。

### 4.4 版本字面量落点清单（实现切片处理；本片不改）

| 位置 | 当前字面量 | 处理 |
| --- | --- | --- |
| `packages/contracts/src/version.ts` | `'1.0'` | **改**（单一权威常量；实现切片） |
| `packages/contracts/src/testing/fixtures.ts` `envelope-minor-mismatch` / `envelope-major-mismatch` | `'1.1'` / `'2.0'` | **改**：按 §5.4 分支只改其中一行 |
| `specs/001-environment-lifecycle/contracts/local-api.md:3,11,122` | `"1.0"` | **改**：改写为当前 wire 版本；`1.0` 作为已冻结版本的历史注记保留（指向标签 `contracts-v1.0.0`），文档 rev 递增 |
| `specs/001-environment-lifecycle/contracts/local-api.md:97`（fixture 表） | `2.0` / `1.1` | **改**：按 §5.4 分支同步 |
| `specs/001-environment-lifecycle/plan.md:19` | `"1.0"` | **留作历史 + 指针**：001 实施计划为历史记录，不改写；在该行追加指向本 ADR 与当前契约文件的指针 |
| `docs/development/desktop-integration.md:186` | 示例 `apiVersion:'1.0'` | **改**：示例必须与当前 wire 版本一致（否则误导读者的可复制示例） |
| `tests/**` | 使用 `API_VERSION` 常量 | **不改**：无需逐处改字面量 |

历史保留清单：所有既有标签对象、001 spec/plan/research/tasks 的历史文本、旧 fixture 行的旧期望——通过标签 `contracts-v1.0.0` 与 Git 历史保留，不回填、不删除。

## 5. 版本选择与发布过渡

### 5.1 完全匹配下的"版本选择"

版本选择只发生在**构建/发布时**，不在运行时：main 导入 `packages/contracts/src/version.ts` 的常量并作为唯一权威；renderer/preload 把**同一构建产物**的常量写进包络。没有协商协议、没有回退、没有自动降级。运行时不匹配一律 `CONTRACT_VERSION_MISMATCH`。因此：包内不会出现混合版本；陈旧 renderer bundle 或 HMR 残留导致的不匹配是**响亮的受控失败**（安全属性，不是缺陷）。发布物必须记录本构建的 `API_VERSION` 与对应标签，便于诊断（不因此新增 wire 方法）。

### 5.2 演进机制（决定，不随数字变化）

1. 只在需要改共享面时显式改 `API_VERSION`；同一次变更同步更新 `version.ts`、`local-api.md`（文档 rev + wire 版本两轴）、`fixtures.ts` 与 §4.4 的字面量落点。
2. 由编排者按精确 merge SHA 打**新**标签；旧标签只读（D3）。
3. 一个版本一次可评审变更；不跨版本累积、不长期并存两个共享面。
4. 禁止"同版本加字段/方法/错误码"（D1）。

### 5.3 已接受 `1.1`（review `5770298091`）

- 理由：§4.1 全部为新增符号或既有 DTO 的**加可选字段**；既有 11 方法语义、既有 DTO 字段类型/必填性、既有错误码含义与校验顺序不变 → 不触发 2.0 的 (a)–(d) 判据。
- **明确规则（可审计）**：**既有 DTO 新增可选字段属于 `1.1` 允许类**；**消费者必须容忍字段缺席**（读取时按可选处理，不得因缺席报错或崩溃）。例：`OperationSnapshot.environmentId` 本就是 `sNullable`（F9），因此新增全局操作的 `environmentId: null` 不构成必填性变化。
- 若评审改判以下任一项成立，则改 `2.0`：(a) 既有方法的输入/输出/守卫/错误码语义变化；(b) 既有 DTO 字段类型、必填性或含义变化；(c) 既有错误码含义扩大或重命名；(d) 校验顺序或幂等语义变化。
- 标签约定：`contracts-v1.1.0` ↔ `API_VERSION = "1.1"`（先例 `contracts-v1.0.0` ↔ `"1.0"`）。
- 本 ADR 保持 `proposed`；编排确认并转 `accepted` 后此节即为固化结论。

### 5.4 发布过渡与 fixture 迁移（按版本分支写清）

1. **阶段 1（本 ADR）**：独立复审通过、状态 `accepted`、版本数字固化。
2. **阶段 2（S1–S4 实现）**：每个切片落地时一次性改 version + 文档 + fixture。**版本不匹配 fixture 的迁移按所选版本分支执行，两处必须同步**（`fixtures.ts` 可执行表 + `local-api.md` fixture 表；文档 rev 递增）：

   | 选 `1.1`（当前推荐） | 选 `2.0`（若改判） |
   | --- | --- |
   | `envelope-minor-mismatch` 的 `'1.1'` → `'1.2'`（`envelope-major-mismatch` 的 `'2.0'` 仍是不匹配，保持不变） | `envelope-major-mismatch` 的 `'2.0'` → `'3.0'`（`envelope-minor-mismatch` 的 `'1.1'` 仍是不匹配，保持不变） |
   | 只改 minor 行 | 只改 major 行 |

   若漏改，该行会从 `CONTRACT_VERSION_MISMATCH` 退化为 `ok`，机器表失效——因此实现 PR 必须单列该迁移。其余字面量落点见 §4.4。允许中间构建只声明新版本而仅含部分新方法（两侧同构建产物，内部自洽；不构成兼容问题），但**不得提前打标签**未评审/未完成的面。
3. **阶段 3（闭环验收后）**：整个插件闭环（S1–S4）完成并独立验收后，编排者按精确 merge SHA 打 `contracts-v1.1.0`（或评审决定的版本）；#74 只到阶段 1。
4. 无兼容窗口：两侧同构建产物，用户升级 HDSL 时两侧一起变；撤回 = 撤回 HDSL 发布（两侧一起），但**已打的标签保留、不删除**。
5. #74 冻结前不得实现 #75 的契约变更；#79 待最终组合基线，且**不因本 ADR 通过而提前声明完成**。

## 6. 消费方影响（方法 × 消费方）

| 消费方 | 需要的变化 | 风险 |
| --- | --- | --- |
| `packages/contracts` | 方法表、输入 schema、`METHOD_DEFINITIONS`、DTO、错误码、码表、dispatcher 计划守卫、fixture 行 | 版本不匹配不再是"配置问题"而是编译期清单；遗漏 fixture 行会破坏机器表 |
| dispatcher | 新码在既有 7 步顺序中的位置；`output` 逐 kind/state 校验；修订守卫先于计划守卫 | 顺序漂移会破坏"无副作用"与"优先级"保证 |
| `ContractPort` 实现（core/main） | 6 个新能力 + 3 个计划/代际查询；计划存储、消费标记、来源锁持久化、home 派生 | 计划存储或 home 派生若落在 main 而非 core，会破坏边界与重启对账 |
| `runtime` | GitHub adapter（可注入 provider）、受管 pnpm 执行器、脚本观测、闭包/摘要计算 | 把测试 transport 误接进生产；pnpm 默认拒执行键未实证 |
| preload | 6 个新方法名加入白名单 | 任何"顺手"的通用通道会破坏冻结边界 |
| renderer | 消费 `OperationRef` + 终态 `output`（缺席即错误态）；渲染新错误码文案、计划详情（含过期重放标注）、授权两态、未测平台提示 | 需要处理"操作成功但 `output` 缺席/畸形"（按 `INTERNAL_ERROR`）；无编译期保护 |
| 既有 001 消费方 | 读方需容忍新增可选 `output`/`pluginSources` 缺席；在**UI 分支与文案**上补齐新 `operationKind`（当前无对 kind 的穷尽 switch、无编译期保护：`controller.ts` 透传、诊断以字符串输出） | 漏改只会静默显示不全，需测试覆盖 |
| 测试 | 契约 fixture 表新增方法行与版本行；`pluginSources` 摘要字节不变断言；适配器 seam 用假 provider/假执行器；真实 desktop 用本地 Git remote | 本地 fixture 不得被当作真实 GitHub 证据（D19） |
| 文档 | `local-api.md` 预留段替换与字面量迁移、ADR 索引、002 规格/差异附录 | 双份清单漂移（本 ADR 暂为唯一权威来源，见下） |

**关于 `specs/002-plugin-transactions` 的差异附录**：本 ADR 的 §4 是差异清单的权威出处；为避免与尚未撰写的 002 规格形成两份会漂移的清单，**本片不新建 `specs/002`**（评审决策点 9 接受）。**可跟踪承接**：002 规格动工时把 §4 与本文方法/错误码表迁入 `specs/002-plugin-transactions/contracts-delta.md`，并在此处改为指针；该迁移作为 002 任务的一部分登记（不由本片建 issue，见 §9 路由说明）。

## 7. 替代方案

| 方案 | 结论 |
| --- | --- |
| 保持 `1.0` 并追加方法/字段 | 拒绝：静默放宽，违反 001 冻结规则与严格 unknown-field 校验 |
| 接受 `1.x` minor 兼容/双向协商 | 拒绝：更高 minor 的新字段必被严格校验拒绝，承诺不可执行（001 已排除） |
| 并行第二套 wire 版本（双 `API_VERSION`） | 暂不采用：双面维护成本与 fixture 翻倍；若插件面确需独立发布节奏可重议 |
| 扩展现有方法（如给 `environments.start` 加插件参数） | 拒绝：插件变更是不同事务类，语义与守卫不同 |
| `changes.apply` 改同步返回 | 拒绝：与 D5 冲突，事务无统一取消；US29/US30 不可机械验收 |
| 结果不透明 id + 每类只读方法（替代 `output`） | 备选保留（D5），当前不采用 |
| 构建授权走原生对话框（ADR 0004 风格） | 拒绝：授权必须是被校验、被记录、可断言的契约输入；ADR 0004 的限制针对秘密/路径，不适用 |
| 用 `link:`/`file:` 或本地普通目录做"来源" | 拒绝：无 commit、无 integrity，无法构成来源锁或 GitHub 全链路（D4/D19） |

## 8. 评审决策点、待实证与风险

**决策点结论（review `5770298091`；rev 2 已并入正文）**

1. **接受 `1.1`**；已补"既有 DTO 加可选字段属 1.1 允许类 + 消费者容忍缺席"（§5.3）。
2. **条件接受** `retryAfterSeconds?` + `output?`；已定义 `output` 逐 kind/state 必填规则、事件不带 `output`、字段白名单与上界（D5/D20）。
3. **接受** 全局操作 `environmentId: null`；已补"全局 search/inspect 不受 `ENVIRONMENT_BUSY` 影响"（D5）。
4. **接受** `pluginSources?`；已补摘要字节不变 fixture 断言（D13）。
5. **接受** pnpm 身份非摘要；已把 `executor {id,version,sha256}` 纳入 `planInputsDigest`（D8/D14）。
6. **接受** `changes.preview` 要求 `expectedRevision`；已补"修订守卫先于计划守卫"与过期重放 UI 标注（D6/D8/D9）。
7. **接受** 15 码与四分；已补映射与优先级，并消歧下载/网络（D8/D9/D11），复用 `DOWNLOAD_FAILED`。
8. **接受** D19 分栏；gate 名在实现切片落地前不写入仓库/CI（D19.4）。
9. **接受** 本片不新建 `specs/002`，并补可跟踪承接与 §4.4 字面量落点清单（§6/§4.4）。

**待实证（禁止在本 ADR 声称已实现/已验收）**

- **E1**：受管 pnpm 的**身份**（精确版本 + tarball 摘要；候选 `11.7.0`，宿主 pnpm 不作证据）与**未执行的可观测信号**（哨兵负控，覆盖 `prepare`/`preinstall`/`install`/`postinstall` 及依赖闭包）。R005 已实测 pnpm ≥10 默认阻止脚本、需写 profile `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑，但阻断键与哨兵仍须在受管版本上验证。
- **E2**：未认证 GitHub 的限流响应形态（403/429 与 `x-ratelimit-*`）、重试时机与硬超时（只读探针，显式 gate）。
- **E3**：离线/超时判定与缓存一致性；"缓存只用于展示"的边界落点。
- **E4**：git 源解析到精确 SHA 的边界（ref 不存在、锁定的 commit 不可达、浅克隆、submodule）；**`closureLockDigest` 必须来自完全 pin 的 lockfile 解析**（不得 semver 范围），需实证覆盖。
- **E5**：崩溃（含 `SIGKILL`）后 reconcile 对未完成 change 事务的解释，尤其提交前后分裂态。
- **E6**：`PluginLock.id/version/sha256` 与 `closureLockSha256` 的精确推导（git 源闭包摘要、完全 pin），002 规格 + fixture。
- **E7**：用户 patch 层引用的检出与漂移检测（apply 复核）。
- **E8**：真实 desktop 端到端用本地受控来源（不新建公网仓库）；真实远程获取→锁→安装仍须独立 opt-in 证明。
- **E9**：`--dump-config` 的**静态性**（不 require/执行 bundle 模块）与"离线解析出的组合树"和"运行期实际加载集合"（含加载失败/被拒 bundle）的**等价性**；在实证前 D15 第 2 面与 §9.4 只作"离线解析出的组合树"。
- **E10**：插件变更代的 **home 派生机制**（复制上一代 / 覆盖共享 / 仅 stage profile）与 **崩溃恢复**（stage 中、home 派生后、指针切换前/后）；在 002 决定前 D18 的"旧代可启动/数据保留"为条件性承诺，且是 **#76 硬前置**。

**风险**

- 新表面较大（6 方法 + 11 DTO + 15 码），fixture 与文档漂移风险高；缓解：单一权威来源（本 ADR §4）+ §4.4 字面量清单 + 机器表逐行断言。
- `output` 载荷可能被误用做大对象传输；缓解：逐 kind 白名单 schema + 上界 + 分页 + 出站校验。
- 默认拒执行的"可失败哨兵"若无法在受管 pnpm 上稳定观测，则 S2 的权威保证不成立 → 属 E1 阻塞，必须先实证再实现，不得先用静态字段推断替代。
- home 派生机制未定 → D18 的条件性承诺若不随 002/#76 落地，会出现"旧代际可启动"的空承诺风险；缓解：列为 #76 硬前置 + E10。

## 9. 需要路由的 issue 最小措辞修正（不扩产品 scope）

以下只做措辞澄清，不改范围、不改状态、不改依赖；**由需求 owner 在审核统一后路由**（本片不改 issue）：

1. **#76 AC**：现文"预览判定'安装期是否需要执行第三方脚本'…（含依赖闭包）"，与另一条"安装过程**验证到没有第三方脚本被执行**"混用了两种机制。建议改为：
   - preview 输出 `scriptAssessment ∈ {none-detected, detected, unknown}` 与脚本清单/未知项，**不承诺闭包无脚本**；
   - 权威判定在 apply 的**默认拒执行 + 执行期可失败哨兵**；未授权执行 → 提交前失败并回滚。
2. **#76 AC**："预览输出完整 commit SHA"需补一句来源语义：`link:`/`file:`/本地路径不是合法源（`INVALID_INPUT`），本地可控 Git remote 仅用于测试 adapter，产品源只有 GitHub 公开仓库。
3. **#73/#76 受管执行器**："受管 pnpm 版本与显式调用"需注明版本为**待实证候选**（候选 `11.7.0`），不得以宿主 pnpm 作为锁定证据（对齐 E1）。
4. **#76/#77 "重启生效/卸载后不再启用"（已按评审必修 2 降级）**：生效判据为**活动代际 + 受管 DSH 离线解析出的组合树**；该组合树与"运行期实际加载集合"的等价性待实证（E9），**文件检查不构成生效证据**，且不得先于实证写成唯一生效 AC。
5. **#77 内置保护（已按评审非阻断发现降级）**：内置集合按**当前受管 DSH 安装解析**（F12a）；负控必须使用当前安装的真实 in-box 名，不得用同名 profile 替身。**不引用**"启用列表出现未声明条目 → 加载失败"或"解析顺序"（F12b 无仓库出处）。
6. **（可选新增）** 把插件事务的**相位名与故障注入形状**（QA §14.2/§14.3，对齐既有 `CreationFaults.failBeforeCommit`/`pauseBeforeCommit`）显式挂到 #76，便于 QA 在每个提交边界做抛错与 `SIGKILL` 注入。
7. **（承接登记 + #76 硬门禁）**：(a) 002 规格动工时的差异清单迁移（§6）登记为 002 任务的一部分；(b) **#76 硬门禁**：#76 开工前必须完成 home 派生机制、含密文件处理、可变运行数据归属与旧代恢复语义的决策与实证（owner = **#76 实现设计**，见 D18/E10）；在决策与实证完成前 **#76 视为门禁未满足**，且本 P0 不宣称该保证已实现。本片不建 issue，登记由需求 owner 路由。

## 10. 后果

- 共享面从 11 个方法扩到 17 个；预期在插件闭环验收后由编排者打 `contracts-v1.1.0`（§5.4）。`version.ts`、`local-api.md`、`fixtures.ts` 与 §4.4 的字面量落点必须由实现切片同步迁移。
- 两侧同构建产物、无兼容窗口：无法只升级 renderer 或只升级 main；陈旧一侧的失败是 `CONTRACT_VERSION_MISMATCH`（受控、响亮）。
- `output` 引入异步结果面，renderer 需要处理终态缺席/畸形（按 `INTERNAL_ERROR`）；`operation.updated` 事件面不变。
- 插件组成进入组成摘要（新代际）；来源锁与 pnpm 身份保持非摘要，因此"可追溯"不等于"可复现声明"——复现声明仍受 E1/E6 约束。
- 代际与运行数据（home）派生机制延后到 002 且为 #76 硬前置（D18/E10）；在此之前"旧代际可启动/数据保留"为条件性承诺。
- 001 既有 11 方法、错误语义、摘要规范、冻结标签与 `pack.*` 预留均保持；新增能力通过新版本标签演进。
- 主要未决面：默认拒执行哨兵（E1）、dump-config 等价性（E9）、home 派生（E10）、限流形态（E2）、闭包摘要推导（E6）。

## 11. 验证状态

- 实现：无（本 ADR 不落代码，不改 `version.ts`、不改 `local-api.md`、不改 `fixtures.ts`）。
- 已验证（文档级）：仓库结构、文档链接与既有契约/标签事实可核对（`python3 scripts/check_repository.py`）；§2 的 verified 行逐条对回对应文件/标签；raw 行标注为未实机验收。
- 未验证：§3 全部插件契约提案（spec change）、§8 全部待实证项（E1–E10）。
- 本 ADR 状态 `proposed`：需独立复审（reviewer 针对精确 head SHA）后才能转 `accepted`；批准前不得据此实现 #75，也不得声明 #73/#79 完成。
- **本 P0 合入不宣称 D18 的运行数据/旧代可用保证已实现**：该保证为条件性承诺，#76 硬门禁与 E10 见 D18/§9.7。
