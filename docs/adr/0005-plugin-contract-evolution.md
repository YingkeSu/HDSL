# 0005：插件 MVP 的共享契约演进与兼容方案

- 状态：**proposed**（待独立评审。本 ADR 只落设计：不改代码、不改 `version.ts`、不改冻结契约文件、不移动或新增契约标签）
- 日期：2026-09-21
- 关联：#74（本任务，Parent #73）；`Refs #9`（M2 插件/事务路线）；`Related #8`（Windows x64 未测门禁）；`Related #15`（契约演进缺口）
- 基线：HDSL main `78552ddf407238833d67848396345196361350a8`；上游固定 tag `dsh-v0.1.5-rc.2` = `fb2c4b9e698e30edb738bca4cf0618587db7d203`（不与 master 混用）
- 依据（可直接核对）：
  - 冻结契约 [local-api.md](../../specs/001-environment-lifecycle/contracts/local-api.md)、[data-model.md](../../specs/001-environment-lifecycle/data-model.md)
  - 可执行实现 `packages/contracts/src/{version,methods,errors,dispatcher,dto,context,digest}.ts`
  - 冻结标签 `contracts-v1.0.0` = `3e76a49694f8dcf4c8bba5d32196a6665a2f394e`（PR #28；含 PR #21 `6e267da`）
  - 上游插件边界 [dsh-compatibility.md](../research/dsh-compatibility.md) R003/R005（固定 tag 实测）
  - 专职 QA 准备与接口条件清单 §14/§15（本机临时文件，未入库；相关结论已摘写入本文）与编排技术裁决（2026-09-21）

## 0. 范围、边界与证据等级

**在范围**：契约演进机制与版本选择；新增检索/预览/变更/恢复/代际读取方法的输入、守卫、错误码、幂等、超时与取消语义；与 001 的差异清单（新增/未变/明确不改）；来源锁与摘要边界；受管 pnpm 与默认拒执行的契约面；卸载保护；离线/限流/缓存语义；`core`/`runtime`/`contracts` 边界；消费方影响；测试 seam 与真实 GitHub 路径的分栏；运行时生效观测设计。

**不在范围**：实现任何插件方法；修改 `version.ts`/`local-api.md`/`fixtures.ts`；新增、移动或重打契约标签；引入依赖；执行第三方代码或安装期脚本；真实 GitHub 或模型请求；`specs/002` 正文；`pack.*`/Registry/小程序接口。

**证据等级**（SOP §7）：对 001 的事实陈述为 **verified**（文件与标签可核对）；对上游 DSH 插件行为的陈述为 **raw**（R005，固定 tag 实测）；本文全部插件契约提案为 **spec change proposal**，**未实现、未验收**，且**不得在评审通过前用于实现 #75**。

## 1. 背景

- 001 契约已冻结并打标签 `contracts-v1.0.0`：wire 版本 `API_VERSION = "1.0"`，**完全匹配**，任何 major/minor 不一致在任何副作用前拒绝为 `CONTRACT_VERSION_MISMATCH`。
- 001 只预留了 `changes.preview` / `changes.apply` / `generations.restore` 三个名字，**未定义输入结构、未暴露为可调用方法**；`pack.*` 明确留给 003。
- 父 PRD #73 需要检索、来源预览、安装/卸载事务与恢复能力，必须在不回退 001 行为、不改冻结标签的前提下演进共享面。
- 完全匹配语义带来一个硬约束：**不存在"向后兼容的新增"**——只要共享面变化，就必须显式改版本并同步两侧（renderer 与 main 共用同一构建产物），否则新字段/新方法会被严格 unknown-field 校验拒掉。
- QA 准备（`/tmp/hdsl-plugin-qa-plan.md` §14/§15）指出：若 #74 不给机制结论，S1 的契约 fixture 无法冻结；且"预览判定脚本"与"apply 验证未执行"是两种机制，AC 表述必须拆分。本 ADR 对这两点做出契约级决定。

## 2. 事实基线（可机械核对）

| # | 事实 | 来源 |
| --- | --- | --- |
| F1 | `API_VERSION = '1.0'`，`matchesApiVersion` 为严格相等；版本不匹配 → `CONTRACT_VERSION_MISMATCH`，**不执行方法** | `packages/contracts/src/version.ts`、`dispatcher.ts` |
| F2 | 校验顺序固定：包络 → apiVersion 结构 → 完全匹配 → 方法白名单与严格输入 → 幂等 → 资源/修订/平台守卫 → in-progress 标记、端口效果、出站 DTO 复校验 | `dispatcher.ts` |
| F3 | 方法白名单恰 11 个：`catalog.list`、`environments.{list,create,start,stop,openWebUI}`、`operations.{get,cancel,subscribe,unsubscribe}`、`diagnostics.export` | `methods.ts` |
| F4 | 错误码恰 17 个；`retryable` 集合为 `ENVIRONMENT_BUSY`、`WEBUI_UNAVAILABLE`、`DOWNLOAD_FAILED`、`DISK_FULL`、`START_TIMEOUT`、`PORT_UNAVAILABLE`、`PROCESS_EXITED`、`EXPORT_FAILED` | `errors.ts` |
| F5 | 幂等账本两态：`in-progress`（守卫全通过、效果前写入；重放 → `ENVIRONMENT_BUSY`）与 `completed`（重放返回原结果）；**纯守卫拒绝不写记录**；`retryable` 重试必须用新 `requestId` | `local-api.md`、`context.ts` |
| F6 | `expectedRevision` 是**组成修订**；`stateVersion` 独立；仅创建与活动代际切换递增 | `data-model.md` |
| F7 | 摘要输入子集 = `schemaVersion` + node/dsh 的 `version/platform/arch/sha256` + 排序后的 `plugins`；`sources` 永不进入摘要；`PluginLock = {id, version, sha256}`；`CompositionLock.schemaVersion` 字面量 `'1'` | `digest.ts`、`dto.ts` |
| F8 | `packages/runtime/src/composition/digest.ts` 当前硬编码 `plugins: []` | 运行时实现 |
| F9 | `Operation.kind` 枚举为 `create/start/stop/openWebUI/export`；`OperationSnapshot` **没有结果载荷字段**；`phase` 是受控自由文本（≤64，脱敏） | `dto.ts` |
| F10 | 取消语义：`operations.cancel` 尽力取消；提交后 → `CANNOT_CANCEL`；**取消不等于系统回滚** | `local-api.md` |
| F11 | 上游插件安装是 pnpm 转发器；构成落盘三元组为 profile `package.json`（`dependencies` + `dsh.profile.bundles`）+ `pnpm-lock.yaml` + `cordis.patch.yml`；GitHub 源取源码而非构建产物；pnpm ≥10 默认阻止 `prepare`；官方要求 pin commit；运行中的 profile 必须重启才生效；隔离单元是 profile 而非 OS 沙箱 | R005（固定 tag 实测） |
| F12 | 内置 bundle 保护是上游解析顺序契约：bundle 名先按**当前 dsh 安装**解析、再按 profile 解析；启用列表出现未声明 `dsh.bundle` 的条目 → profile **加载失败** | R005 |
| F13 | `dsh --dump-config`/`--dump-default-config` 可离线查看组合树；rc.2 tag 与本仓库 `packageManager` 均为 `pnpm@11.7.0` | R003/R005 |

F13 的 pnpm 版本只是**候选**：本 ADR 不把宿主 `11.7.0` 当作产品锁定版本（见 §8 待实证 E1）。

## 3. 决策

### D1 完全匹配语义保留，禁止"同版本静默放宽"

保留 F1/F2。**禁止**在 `API_VERSION = "1.0"` 不变的前提下新增方法、字段、错误码或 `operationKind` 值。任何共享面变化 = 一次显式版本变更，同步更新 `version.ts`、`local-api.md`（文档 rev 与 wire 版本两轴）、可执行 fixture 表，并由编排者按精确 merge SHA 打**新**标签。§7 中"保持 1.0 追加"与"接受 1.x minor 兼容/协商"两个替代方案据此排除。

### D2 版本号选择是评审提案，不由本片单方面决定

本 ADR 固定**机制**（D1、D3、D5），不固定数字：推荐 `1.1`，判据见 §5.3；`1.1` 或 `2.0` 由独立评审批准后写回本 ADR（状态 `proposed → accepted`）。批准前任何实现切片**不得**改 `version.ts`。

### D3 冻结标签不可变

`contracts-v1.0.0` 及其 commit 保持只读：不移动、不删除、不重打、不 force-push。新版本用新标签，命名沿用 001 先例 `contracts-v<major>.<minor>.0`（`contracts-v1.0.0` ↔ `API_VERSION = "1.0"`）。

### D4 检索/预览/变更/恢复/代际读取的方法集

| 方法 | 类别 | 输入要点 | 返回 | 环境作用域 |
| --- | --- | --- | --- | --- |
| `plugins.search` | 长时操作（Operation） | `requestId`, `query`（严格字符串） | `OperationRef` | 全局（`environmentId` 为 `null`） |
| `plugins.inspect` | 长时操作 | `requestId`, `source {owner, name, ref?}` | `OperationRef` | 全局 |
| `changes.preview` | 长时操作 | `requestId`, `environmentId`, `expectedRevision`, `action {kind: install, source} \| {kind: remove, pluginId}` | `OperationRef` | 单环境 |
| `changes.apply` | 长时操作（事务） | `requestId`, `environmentId`, `expectedRevision`, `planId`, `buildAuthorization?` | `OperationRef` | 单环境 |
| `generations.restore` | 长时操作 | `requestId`, `environmentId`, `expectedRevision`, `targetGenerationId` | `OperationRef` | 单环境 |
| `generations.list` | 只读（无 `requestId`） | `environmentId` | `GenerationSummary[]` | 单环境 |

- 预留名字 `changes.preview` / `changes.apply` / `generations.restore` 从"仅文档预留"提升为白名单成员；`pack.inspect` / `pack.import` / `pack.export` **继续预留**，不暴露（003 定义）。
- 命名（`plugins.*` 前缀）属提案，评审可改；改名的成本与实现同步更新 `CONTRACT_METHODS`、fixture、preload 白名单与本文方法表。
- `source` 输入**只接受 GitHub 仓库引用**（`owner`/`name`/可选 `ref`）。`link:`/`file:`/本地路径/任意 URL/自由包名一律 `INVALID_INPUT`，与 PRD"源是 GitHub 公开仓库"的 Out of Scope 一致，并在入口即阻断本地路径泄漏与"用普通目录冒充来源锁"。

### D5 长时操作统一复用既有 Operation 生命周期；结果走快照的可选载荷

- 检索/预览/应用/恢复**不新增**取消、订阅或流式机制：一律返回 `OperationRef`，进度、取消、重连复用 `operations.get` / `operations.cancel` / `operations.subscribe`（含 F10 语义）。
- `OperationSnapshot` 新增**可选**字段 `output`（受 schema 校验、有长度/条目上界、出站前脱敏），承载该 operation 的终态结果（`ChangePlan` / `PluginSearchResult` / `PluginInspection` / `ChangeApplication` / `GenerationSummary`）。既有 kind 不带 `output`，001 行为不变；畸形的 `output` 按 F2 出站规则映射为 `INTERNAL_ERROR`。
- 备选（评审可改）：用"仅返回不透明 id + 每种结果一个只读方法"替代 `output`。被否理由：需要 3 个额外只读方法与 3 个额外 id 域，且 `changes.apply` 的终态摘要仍无处放置；`output` 一个可选字段即可覆盖。
- 全局操作（`environmentId: null`）与 001 的 `operations.subscribe`（省略 `operationId` 表示该窗口全部操作）兼容，无需新增订阅语义。

### D6 预览与提交分离；Change plan 是带修订与有效期的独立对象

- `changes.preview` 产出 `ChangePlan`：`planId`、`environmentId`、`baseRevision`、`action`、`createdAt`、`expiresAt`、`sourceLock`（安装时）、`actions {removals[], retention[]}`、`blockingReferences[]`、`scriptAssessment`、`requiresBuildAuthorization`、`riskItems[]`、`planInputsDigest`。
- preview **不改变**环境组成、活动代际指针、来源锁（允许写 cache/journal/临时文件，且在界面可解释；不得宣称"磁盘绝对不变"）。
- preview 运行中可以执行（只读语义 + 计划落盘），**apply 在运行中一律拒绝**（`ENVIRONMENT_BUSY`），与 PRD US15/US16 一致。

### D7 预览是"静态/解析风险摘要 + 未知项"，不是"闭包绝无脚本"的保证

依编排裁决与 QA §15.2：

- `scriptAssessment` 只有三类：`none-detected`（解析到的清单中未见安装期脚本）、`detected`（确有脚本）、`unknown`（清单不完整、锁缺失、依赖闭包未完全解析、格式不受支持等）。
- preview **不得**输出"保证不执行脚本"之类结论；`requiresBuildAuthorization` 在 `detected` 或 `unknown` 时为真。
- **权威保证来自 apply**：默认拒执行 + **执行期可失败哨兵**。apply 若观测到任何第三方安装期脚本被执行，则在提交前以 `UNAUTHORIZED_SCRIPT_EXECUTION` 失败并回滚。
- 该分工修正了 #76 AC 中"预览判定…安装过程验证到没有第三方脚本被执行"的混合表述（见 §9 最小措辞修正）。

### D8 防 TOCTOU：apply 以计划为基准重新解析与复核，全部比较先于任何写操作

- 计划记录 `commitSha`、`manifestDigest`、`closureLockDigest`、脚本集合与 `planInputsDigest`。
- apply 的顺序固定为：版本 → 输入 → 幂等 → 环境/修订 → 计划（`NOT_FOUND`/`PLAN_EXPIRED`/`PLAN_STALE`/`PLAN_CONSUMED`）→ 忙碌/运行中（`ENVIRONMENT_BUSY`）→ **重新解析并复核**（commit 可达性、manifest/闭包摘要、脚本集合、授权绑定）→ 效果（准备新代际 → 写来源锁 → 写启用引用 → 受管 pnpm）→ 验证 → 切换活动代际（提交点）。
- 复核失败映射：源内容与计划记录的摘要不符 → `PLUGIN_INTEGRITY_MISMATCH`；提交的授权未精确绑定计划的 commit + 脚本集合 → `AUTHORIZATION_MISMATCH`；环境侧非修订输入（启用集合、用户 patch 引用）漂移 → `PLAN_STALE`；`expectedRevision` 漂移 → `REVISION_CONFLICT`（复用 001 语义）。
- **所有比较在任何写操作之前完成**；`buildAuthorization` 与重新解析出的集合逐项相等（集合相等 + commit 相等），不做子集/前缀匹配。

### D9 计划过期、陈旧与消费

- `PLAN_EXPIRED`：超过 `expiresAt`。
- `PLAN_STALE`：`planInputsDigest` 失配（环境侧非修订输入漂移，含用户 patch 层引用变化——这部分不被 `revision` 覆盖）。
- `PLAN_CONSUMED`：同一 `planId` 已被另一个 `requestId` 成功消费。真正的重放（同 `requestId` + 同参数）按 F5 返回原记录结果，不触发本码。
- 三者均**非 retryable**、**无副作用**，且修复路径明确（重新 preview / 重试时用新 `requestId`）。

### D10 取消与提交边界

- **提交点 = 活动代际指针切换**。提交前取消 → 操作终态 `cancelled`，环境组成、活动代际指针与旧可用代际不变，临时 stage 清理，journal/失败证据准确写入（cache/journal 写入不算副作用）。
- 提交后取消 → 复用 `CANNOT_CANCEL`（F10）；界面与日志必须如实报告"已提交，可显式恢复到上一代际"，**不得**称已回滚。显式恢复走 `generations.restore`。
- 检索/预览路径同样支持取消（D5），取消为终态、无环境副作用；已完成的 preview 取消返回 `CANNOT_CANCEL`，其计划按 TTL 自然过期（这是允许的 cache/journal 产物）。

### D11 错误码：新增 15 个、复用 001 既有码

新增 15 个，其中仅 `RATE_LIMITED`、`NETWORK_UNAVAILABLE` 为 `retryable`，其余为确定性拒绝：

| code | 语义 | 触发点 |
| --- | --- | --- |
| `RATE_LIMITED` | GitHub 限流（403/429），携带 `retryAfterSeconds?` | `plugins.*` 网络路径 |
| `NETWORK_UNAVAILABLE` | 离线/连接中断/TLS/超时 | `plugins.*` 网络路径 |
| `SOURCE_NOT_FOUND` | 仓库、ref 或提交不存在；锁定的 commit 不可达 | inspect/preview/apply 复核 |
| `SOURCE_MANIFEST_INVALID` | manifest 不可读/非法 JSON/超出上界 | inspect/preview |
| `NOT_A_PLUGIN` | 未声明 `dsh.bundle.patch`，不得进入层栈 | 安装类 preview/apply |
| `PLAN_EXPIRED` | 计划超过有效期 | apply |
| `PLAN_STALE` | 计划输入漂移 | apply |
| `PLAN_CONSUMED` | 计划已被其它请求消费 | apply |
| `EXECUTOR_UNAVAILABLE` | 受管 pnpm 缺失或版本不符 | apply（受控失败） |
| `BUILD_NOT_AUTHORIZED` | 源需要执行脚本但未给授权 | apply（默认拒） |
| `AUTHORIZATION_MISMATCH` | 授权未精确绑定计划 commit + 脚本集合 | apply |
| `UNAUTHORIZED_SCRIPT_EXECUTION` | 执行期观测到未授权/未预期的第三方脚本 | apply（提交前失败并回滚） |
| `BUILTIN_BUNDLE_PROTECTED` | 目标是安装解析出的内置 bundle | remove preview/apply |
| `REFERENCED_BY_OTHER` | 移除会破坏其它 bundle/配置解析，或被用户 patch 层引用 | remove preview/apply |
| `PLUGIN_INTEGRITY_MISMATCH` | 复解析内容与计划记录的 manifest/闭包摘要不符 | apply 复核 |

`retryable` 集**新增** `RATE_LIMITED`、`NETWORK_UNAVAILABLE`（瞬时本地/网络状态）；其余为确定性拒绝，不可重试（与 F4 的分类原则一致）。

复用（**语义不变**）：`INVALID_INPUT`、`NOT_FOUND`、`IDEMPOTENCY_CONFLICT`、`CONTRACT_VERSION_MISMATCH`、`UNSUPPORTED_COMBINATION`（含未测平台的平台门禁）、`REVISION_CONFLICT`、`ENVIRONMENT_BUSY`、`CANNOT_CANCEL`、`DISK_FULL`、`INTERNAL_ERROR`。

失败包络新增**可选** `retryAfterSeconds`（限流重试时机需可机读；把时间塞进受控文案会让 UI 无法行动也无法断言）。这是对既有 DTO 的加字段，属评审决策点（§8-2）。

### D12 幂等与超时

- 新操作类方法沿用 F5：`in-progress` 重放 → `ENVIRONMENT_BUSY`（不重做效果）；`completed` 重放 → 原结果；守卫拒绝不写记录；`retryable` 失败重试必须用新 `requestId`。
- 预览重放返回**原计划**（含已过期的计划），TTL 只在 apply 检查——重放永不重算，与 F5 一致。
- 所有网络与事务路径必须有**硬超时**；超时对当时相位映射为受控终态（网络相位 → `NETWORK_UNAVAILABLE`；事务相位 → 提交前取消/失败语义或 `CANNOT_CANCEL`），不出现"无限等待"或"无终态"。

### D13 来源锁与组成摘要边界

- **摘要身份不变**（F7）：`PluginLock = {id, version, sha256}` 仍是唯一进入组成摘要的插件身份；排序键不变。插件组成（`plugins` 非空）是**新组成**，只影响新代际的摘要，不回退既有 `plugins: []` 组成的摘要字节。
- 新增**非摘要**来源锁 `PluginSourceLock`：`{sourceKind: 'github', repository {owner, name}, commitSha(40 hex), ref?, packageName, packageVersion, manifestSha256, closureLockSha256, isBuiltin, buildAuthorization?, executor {id, version, sha256}?}`。理由与 001 的 `sources` 完全同构（issue #15 N3）：来源可供追溯，但**永不进入摘要**，镜像/URL 变化不改变组成身份。
- `CompositionLock` 新增**可选**非摘要字段 `pluginSources`；缺失 = 无插件来源记录（与既有 `plugins: []` 组成兼容）。所有路径与凭据不得进入来源锁（QA 的 canary 断言覆盖）。
- `PluginLock.id/version/sha256` 的精确推导（git 源闭包摘要）由 002 规格固定并加 fixture；本 ADR 只冻结性质：必须是**已解析安装产物**的确定性函数、平台无关、且不依赖 ref/分支名。

### D14 受管 pnpm 执行器与默认拒执行

- pnpm 版本与来源由 HDSL 确定并**显式路径**调用（参数数组，不拼 shell），不依赖宿主偶然 PATH；缺失或版本不符 → `EXECUTOR_UNAVAILABLE`（受控失败，不隐式回退宿主 pnpm）。
- pnpm 身份**不进** `RuntimeCombination`，也**不进**组成摘要；它作为执行期来源记录在 `PluginSourceLock.executor` 与操作 journal（非摘要）。理由：环境运行时是 node + DSH + 插件；解析后的闭包已由 `plugins` 摘要身份捕获，两个 pnpm 版本产出同一闭包即同一组成。若评审要求构建可复现必须包含执行器身份，则属 001 DTO 变更 → 只能 `2.0`（§8-5）。
- 默认**不放行任何第三方安装期脚本**（含依赖闭包、含 npm 包与 tarball；不因包格式视为天然安全）。需脚本的源走 #78（S4）显式授权，这是有意的 MVP 范围，不是缺陷。
- 授权绑定精确 `commitSha` + 精确脚本集合（每项含包键与脚本名），**禁通配、禁按作者信任、禁生成全局放行等价配置**（不写 `allowBuilds`/`onlyBuiltDependencies` 之类的全局开关）；commit 变化即授权失效。
- 权威保证是"默认拒执行 + 执行期观测"（D7）：具体阻断键（`--ignore-scripts` 与 pnpm ≥10 的构建许可键的差异）与"脚本确实未执行"的可观测信号属**待实证**（§8-E1），由 S2 在受管 pnpm 版本上以哨兵负控冻结，不得用宿主机 pnpm 当证据。

### D15 卸载三分支、内置保护与运行时生效观测

- **同包保留（预期）**：共享/传递依赖按 lock 保留，预览在 `retention` 中说明，不判为残留失败。
- **启用层/配置破坏（拦截）**：`REFERENCED_BY_OTHER`，预览列出 `blockingReferences`（含引用来源），apply 复核（漂移 → `PLAN_STALE`）。
- **用户 patch 引用（默认拦截 + 建议）**：`REFERENCED_BY_OTHER`（kind `userPatch`）；不改用户 patch 文件，不静默移除。
- **内置保护**：`isBuiltin` 必须由**当前受管 DSH 安装解析出的 in-box bundle 集合**判定（F12），不由客户端提供、不由 profile 同名依赖遮蔽；命中 → `BUILTIN_BUNDLE_PROTECTED`。负控必须使用**当前安装的真实 in-box 名**，禁止用同名 profile 替身造假绿。
- **精确目标**：不做通配清理；只移除本次事务的直接依赖条目与启用引用。
- **运行时生效观测**（QA §14.7）：文件检查**不构成**生效证据。生效判据由三面组合：
  1. 契约只读面：`generations.list` 返回活动代际、组成摘要与来源锁（HDSL 的权威记录）；
  2. 独立运行时解析：用受管 DSH 的**离线配置转储**（`--dump-config`/`--dump-default-config`，F13）在环境安装与 home 上得到实际组合树/加载集合，与活动代际记录比对；
  3. 时序门禁：运行中 apply → `ENVIRONMENT_BUSY`；停止并重启后实际加载集合 = 新代际，卸载后不再包含该包。
  该观测是**验证 seam**，本 MVP 不因此新增 `--dump-config` 类 IPC 方法。

### D16 离线、限流与缓存语义

- 限流（403/429）→ `RATE_LIMITED` + `retryAfterSeconds`（可机读，UI 说明重试时机）；离线/中断 → `NETWORK_UNAVAILABLE`；两者都**不改环境组成**，且**不得**退化为含糊失败。
- 缓存语义的不变量：**缓存只能用于展示发现结果，不能用于授权变更**。任何变更绑定身份（commit SHA、manifest/闭包摘要、脚本集合、授权）必须在 preview/apply 时重新解析或复核（D8），不得取自缓存。
- `PluginSearchResult` 暴露 `query`（与实际发出的查询逐字符一致，1–256 字符）、`hits[]`、`totalCount`、`incompleteResults`、`hasMore`、`fetchedAt`、`fromCache`；默认查询与过滤条件（如 topic、`fork:false archived:false`）必须体现在该字符串中。界面据此区分"确实这么少"与"结果被截断"，并显示"发现不代表可安装或安全"。
- `plugins.*` 与 `changes.*` 的输入**没有** GitHub 凭据字段；MVP 路径不使用凭据（PRD US33），也不得从环境继承或落盘任何 GitHub token。

### D17 `core` / `runtime` / `contracts` / `main` 边界

- `packages/contracts`：版本、包络、方法 schema、DTO、错误码、dispatcher 守卫与计划守卫（TTL/陈旧/已消费的判定语义；状态数据经端口读取）。
- `packages/core`：计划存储与消费标记、来源锁持久化、代际事务协调与切换、journal/reconcile；**不做网络、不起子进程、不加载插件代码**。
- `packages/runtime`：GitHub 查询/ref 解析/manifest 与闭包读取适配器、受管 pnpm 执行器（显式路径 + 参数数组）、脚本执行观测。**第三方插件代码永不进入 main/renderer 进程**。
- `apps/desktop` main：端口接线与出站脱敏；preload：仅白名单方法（**不新增**通用 `invoke`/任意通道）。
- `ContractPort` 新增能力（对齐既有 `createEnvironment` 风格）：`searchPlugins`、`inspectPluginSource`、`previewChange`、`applyChange`、`restoreGeneration`、`listGenerations`，以及计划守卫所需的 `findChangePlan`、`markChangePlanConsumed`、`findGeneration`（镜像 `readIdempotency`/`writeIdempotency` 的受信模式）。
- `tests/engineering/workspace-boundaries.test.ts` 的 core/runtime 不互相 import 约束**不得放宽**。

### D18 测试 seam 与真实 GitHub 路径分栏（本地 fixture 不可冒充真实链路）

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
4. 真实 GitHub 只读探针与显式端到端验收的 gate 命名与落点由实现切片定义（候选：`HDSL_QA_GITHUB_PROBE`、`HDSL_E2E_PLUGIN`），本 ADR 只要求"默认 CI 完全离线可复现全部失败/取消场景"和"跳过不计通过"。

### D19 用户界面可实现性（契约侧约束）

- 每个新错误码有受控、可行动的文案与 `retryable`/`retryAfterSeconds`；`INTERNAL_ERROR` 不得吞掉可分类失败。
- `ChangePlan` / `PluginInspection` / `PluginSearchResult` 必须自带 UI 所需全部字段（commit、包名/版本、manifest 摘要、依赖与许可摘要、`isPlugin`、`scriptAssessment`、脚本清单（含依赖闭包）、风险项、移除/保留项、阻塞引用、`expiresAt`、`baseRevision`），使 UI 无需第二次特权调用。
- 列表与文本有明确上界（搜索结果分页 + `totalCount`/`hasMore`、脚本条目上限、错误消息 ≤512 字符），超界以计数表示，**不静默截断**。
- 默认拒执行与显式授权的两态文案必须区分；文案必须写明"安装期在你的机器上执行该包代码，不受 DSH 或 HDSL 沙箱保护"，且**不得**写成"永不执行第三方代码"。
- Windows x64 未测：不可用平台以 `UNSUPPORTED_COMBINATION` 或等价能力门禁呈现，文案必须说明未实测，不暗示支持。

## 4. 与 001 契约的差异清单

### 4.1 新增

| 类别 | 项目 |
| --- | --- |
| 方法 | `plugins.search`、`plugins.inspect`、`changes.preview`、`changes.apply`、`generations.restore`（预留名提升）、`generations.list`（只读） |
| DTO | `PluginSearchResult`、`PluginSearchHit`、`PluginInspection`、`PluginSourceLock`、`ChangePlan`、`ChangePlanAction`、`ChangeBlockingReference`、`BuildScriptEntry`、`BuildAuthorization`、`ChangeApplication`、`GenerationSummary` |
| 既有 DTO 的加字段 | `OperationSnapshot.output?`（受控载荷）；`ContractError.retryAfterSeconds?`；`CompositionLock.pluginSources?`（非摘要） |
| 枚举 | `operationKind` 新增 `search` / `inspect` / `preview` / `apply` / `restore` |
| 错误码 | §D11 的 15 个新码；`retryable` 集新增 2 项 |
| 端口 | `ContractPort` 新增 §D17 的能力（含计划守卫读取/消费） |
| 文档 | `local-api.md` 的预留段替换为 002 规格指针；新增 002 契约差异的权威出处（见 §6） |

### 4.2 未变

- 完全匹配与校验顺序（F1/F2）；`CONTRACT_VERSION_MISMATCH` 语义。
- 既有 11 个方法的名称、输入、输出、守卫、错误码与 `readOnly`/`idempotent` 属性。
- 幂等账本语义（F5）；`expectedRevision` = 组成修订、`stateVersion` 独立（F6）。
- 摘要输入子集、规范化 JSON、64 位小写十六进制摘要（F7）；`sources` 与非摘要元数据永不进入摘要。
- 失败/成功包络结构（除新增可选字段）、消息脱敏与长度上界、错误不含栈/密钥/token/cookie/本地绝对路径。
- `operation.updated` 的每 operation `sequence`、订阅/退订语义（F9/F10）。
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

## 5. 版本选择与发布过渡

### 5.1 完全匹配下的"版本选择"

版本选择只发生在**构建/发布时**，不在运行时：main 导入 `packages/contracts/src/version.ts` 的常量并作为唯一权威；renderer/preload 把**同一构建产物**的常量写进包络。没有协商协议、没有回退、没有自动降级。运行时不匹配一律 `CONTRACT_VERSION_MISMATCH`。因此：包内不会出现混合版本；陈旧 renderer bundle 或 HMR 残留导致的不匹配是**响亮的受控失败**（安全属性，不是缺陷）。发布物必须记录本构建的 `API_VERSION` 与对应标签，便于诊断（不因此新增 wire 方法）。

### 5.2 演进机制（决定，不随数字变化）

1. 只在需要改共享面时显式改 `API_VERSION`；同一次变更同步更新 `version.ts`、`local-api.md`（文档 rev + wire 版本两轴）、`fixtures.ts`。
2. 由编排者按精确 merge SHA 打**新**标签；旧标签只读（D3）。
3. 一个版本一次可评审变更；不跨版本累积、不长期并存两个共享面。
4. 禁止"同版本加字段/方法/错误码"（D1）。

### 5.3 推荐 `1.1`（评审提案，非单方面决定）

- 理由：§4.1 全部为新增（方法、DTO、错误码、枚举值、可选字段、端口能力），不改变既有 11 方法语义、既有 DTO 字段类型/必填性、既有错误码含义与校验顺序。
- 若评审认为以下任一项成立，则改 `2.0`：(a) 既有方法的输入/输出/守卫/错误码语义变化；(b) 既有 DTO 字段类型、必填性或含义变化；(c) 既有错误码含义扩大或重命名；(d) 校验顺序或幂等语义变化。
- 数字经评审批准后写回本 ADR（状态转 `accepted`）；批准前不得改 `version.ts`。

### 5.4 发布过渡

1. **阶段 1（本 ADR）**：独立评审通过 → 状态 `accepted`，版本数字批准。
2. **阶段 2（S1–S4 实现）**：每个切片落地时一次性改 version + 文档 + fixture。**必须显式修改** fixture 中 `envelope-minor-mismatch`（当前字面量 `1.1`）为新版本之外的版本（如 `1.2`），否则该行会退化成 `ok`；这是对**可执行 fixture** 的必需改动，不是对冻结标签的改动，必须在实现 PR 中单列说明。允许中间构建只声明新版本而仅含部分新方法（两侧同构建产物，内部自洽；不构成兼容问题），但**不得提前打标签**未评审/未完成的面。
3. **阶段 3（闭环验收后）**：整个插件闭环（S1–S4）完成并独立验收后，编排者按精确 merge SHA 打 `contracts-v1.1.0`（或评审决定的版本）；#74 只到阶段 1。
4. 无兼容窗口：两侧同构建产物，用户升级 HDSL 时两侧一起变；撤回 = 撤回 HDSL 发布（两侧一起），但**已打的标签保留、不删除**。
5. #74 冻结前不得实现 #75 的契约变更；#79 待最终组合基线，且**不因本 ADR 通过而提前声明完成**。

## 6. 消费方影响（方法 × 消费方）

| 消费方 | 需要的变化 | 风险 |
| --- | --- | --- |
| `packages/contracts` | 方法表、输入 schema、`METHOD_DEFINITIONS`、DTO、错误码、码表、dispatcher 计划守卫、fixture 行 | 版本不匹配不再是"配置问题"而是编译期清单；遗漏 fixture 行会破坏机器表 |
| dispatcher | 新码在既有 7 步顺序中的位置；`output` 出站校验；`PLAN_*` 守卫在修订守卫之后、效果之前 | 顺序漂移会破坏"无副作用"保证 |
| `ContractPort` 实现（core/main） | 6 个新能力 + 3 个计划/代际查询；计划存储、消费标记、来源锁持久化 | 计划存储若落在 main 而非 core，会破坏边界与重启对账 |
| `runtime` | GitHub adapter（可注入 provider）、受管 pnpm 执行器、脚本观测、闭包/摘要计算 | 把测试 transport 误接进生产；pnpm 默认拒执行键未实证 |
| preload | 6 个新方法名加入白名单 | 任何"顺手"的通用通道会破坏冻结边界 |
| renderer | 消费 `OperationRef` + `output`；渲染新错误码文案、计划详情、授权两态、未测平台提示 | 需要处理"操作成功但 output 缺失/畸形"（按 `INTERNAL_ERROR`） |
| 既有 001 消费方 | `OperationSnapshot` 读方需忽略未知可选 `output`；`operationKind` 的穷尽 switch 需补新值 | 穷尽 switch 会在编译期报错（期望行为，不是回归） |
| 测试 | 契约 fixture 表新增方法行与版本行；适配器 seam 用假 provider/假执行器；真实 desktop 用本地 Git remote | 本地 fixture 不得被当作真实 GitHub 证据（D18） |
| 文档 | `local-api.md` 预留段替换、ADR 索引、002 规格/差异附录 | 双份清单漂移（本 ADR 暂为唯一权威来源，见下） |

**关于 `specs/002-plugin-transactions` 的差异附录**：本 ADR 的 §4 是差异清单的权威出处；为避免与尚未撰写的 002 规格形成两份会漂移的清单，**本片不新建 `specs/002`**。待 002 规格动工时，把 §4 与本文方法/错误码表迁入 `specs/002-plugin-transactions/contracts-delta.md`，并在此处改为指针。此为有意的范围取舍（见 §8-9）。

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
| 用 `link:`/`file:` 或本地普通目录做"来源" | 拒绝：无 commit、无 integrity，无法构成来源锁或 GitHub 全链路（D4/D18） |

## 8. 评审决策点、待实证与风险

**需评审明确批准的决策点**

1. 版本数字：`1.1` vs `2.0`（§5.3）。
2. 是否给 `ContractError` 新增可选 `retryAfterSeconds`（改既有 DTO）与 `OperationSnapshot.output?`。
3. 长时模型统一：检索/预览也是 Operation；允许全局操作（`environmentId: null`）。
4. `CompositionLock` 新增可选非摘要 `pluginSources`。
5. pnpm 身份保持非摘要（反选则需 `2.0` + 001 DTO 变更）。
6. `changes.preview` 是否要求 `expectedRevision` 并应用修订守卫（本文：要求）。
7. 错误码集合与 `retryable` 分类；`PLAN_EXPIRED` / `PLAN_STALE` / `PLAN_CONSUMED` / `PLUGIN_INTEGRITY_MISMATCH` 的四分是否过细。
8. D18 的分栏与 gate 命名（实现切片定义）。
9. 本片不新建 `specs/002`、差异清单暂留 ADR（§6）。

**待实证（禁止在本 ADR 声称已实现/已验收）**

- E1：受管 pnpm 的**精确版本与 tarball 摘要**（候选 `11.7.0`，F13），及其**本地 Git 传输支持**与**默认阻断脚本的具体配置键**；"脚本确实未执行"的可观测信号必须以哨兵负控验证。**宿主 pnpm 11.7.0 不是产品锁定证据。**
- E2：未认证 GitHub 的限流响应形态（403/429 与 `x-ratelimit-*`）、重试时机与硬超时（只读探针，显式 gate）。
- E3：离线/超时判定与缓存一致性；"缓存只用于展示"的边界落点。
- E4：git 源解析到精确 SHA 的边界（ref 不存在、锁定的 commit 不可达、浅克隆、submodule）与 manifest/闭包读取上界。
- E5：崩溃（含 `SIGKILL`）后 reconcile 对未完成 change 事务的解释，尤其提交前后分裂态。
- E6：`PluginLock.id/version/sha256` 的精确推导（git 源闭包摘要），002 规格。
- E7：用户 patch 层引用的检出与漂移检测（apply 复核）。
- E8：真实 desktop 端到端用本地受控来源（不新建公网仓库）；真实远程获取→锁→安装仍须独立 opt-in 证明。

**风险**

- 新表面较大（6 方法 + 11 DTO + 15 码），fixture 与文档漂移风险高；缓解：单一权威来源（本 ADR §4）+ 机器表逐行断言。
- `output` 载荷可能被误用做大对象传输；缓解：显式上界 + 出站校验 + 分页。
- 默认拒执行的"可失败哨兵"若无法在受管 pnpm 上稳定观测，则 S2 的权威保证不成立 → 属 E1 阻塞，必须先实证再实现，不得先用静态字段推断替代。

## 9. 需要路由的 issue 最小措辞修正（不扩产品 scope）

以下只做措辞澄清，不改范围、不改状态、不改依赖；请编排决定是否写入对应 issue：

1. **#76 AC**：现文"预览判定'安装期是否需要执行第三方脚本'…（含依赖闭包）"，与另一条"安装过程**验证到没有第三方脚本被执行**"混用了两种机制。建议改为：
   - preview 输出 `scriptAssessment ∈ {none-detected, detected, unknown}` 与脚本清单/未知项，**不承诺闭包无脚本**；
   - 权威判定在 apply 的**默认拒执行 + 执行期可失败哨兵**；未授权执行 → 提交前失败并回滚。
2. **#76 AC**："预览输出完整 commit SHA"需补一句来源语义：`link:`/`file:`/本地路径不是合法源（`INVALID_INPUT`），本地可控 Git remote 仅用于测试 adapter，产品源只有 GitHub 公开仓库。
3. **#73/#76 受管执行器**："受管 pnpm 版本与显式调用"需注明版本为**待实证候选**（候选 `11.7.0`），不得以宿主 pnpm 作为锁定证据（对齐 E1）。
4. **#76/#77 "重启生效/卸载后不再启用"**：建议补"生效判据为活动代际 + 受管 DSH 离线配置转储的实际加载集合，文件检查不构成生效证据"（对齐 D15）。
5. **#77 内置保护**：建议补"内置集合按当前受管 DSH 安装解析，负控必须使用当前安装的真实 in-box 名，不得用同名 profile 替身"（对齐 D15 / QA §15.7）。

## 10. 验证状态

- 实现：无（本 ADR 不落代码，不改 `version.ts`、不改 `local-api.md`、不改 `fixtures.ts`）。
- 已验证（文档级）：仓库结构、文档链接与既有契约/标签事实可核对（`python3 scripts/check_repository.py`）。
- 未验证：§3 全部插件契约提案（spec change）、§8 全部待实证项。
- 本 ADR 状态 `proposed`：需独立评审（reviewer 针对精确 head SHA）后才能转 `accepted`；批准前不得据此实现 #75，也不得声明 #73/#79 完成。
