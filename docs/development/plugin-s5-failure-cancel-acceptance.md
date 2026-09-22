# S5（#79）失败/取消/网络 + 幂等 验收矩阵（QA owner=33）

- 基线：main `18a5d65197a25e95914e8bd23d54d756d6177d4b`（= S4 #90 merge）；本 PR 已并入 main `0e45186e30a86ace84ac7c6e5b20223c86e0258d`（#96 / #94 合并）。自有 checkout `/tmp/qa33/checkout`；**本片只读产品、仅新增 QA 测试/报告**。
- 方法：复用既有确定性/真实证据优先；风险驱动补缺；只新增默认 CI 确定性测试；真实 desktop 仅必要时自有副本有界执行。事务边界（SIGKILL/recover/journal 对账）由 30 独立审计，本文件不重复。
- 网络面分栏：**GitHub API**（search/preview/install 解析）｜**codeload/registry 取包**（install/remove）｜**受管 pnpm**。不把不同面的失败混称。

## 矩阵（路径 × 失败/取消）

| 路径 | 失败/取消 | 判定 | 证据 |
| --- | --- | --- | --- |
| search | 403/429（可识别限流，带 x-ratelimit/retry-after） | **PASS** | `tests/plugins/github-source.test.ts`「maps 403/429 to RATE_LIMITED with a machine-readable retry delay」 |
| search | 403/429 **无 rate-limit 头部**（D11 现状：RATE_LIMITED 且不臆造 retryAfter；**权限/认证类 403 不可区分**） | **现状已断言 / 精度差异待裁决** | 新增 `tests/plugins/github-403-precision.test.ts`；条目见下「实质缺口」F1 |
| search | 离线/超时（连接前/body 停滞） | **PASS** | github-source「connection failure / timeout before response / stalled body → NETWORK_UNAVAILABLE」 |
| search | malformed / 404 | **PASS** | github-source「malformed → DOWNLOAD_FAILED；404 → SOURCE_NOT_FOUND」 |
| search | 取消（终态、无副作用、迟到结果不复活） | **PASS** | `tests/plugins/plugin-discovery.test.ts`「cancels an in-flight search」「operations.cancel hits the plugin operation」 |
| preview（GitHub 解析） | 限流/中止 | **PASS** | `tests/plugins/github-preview.test.ts`「maps rate limiting and an abort to controlled outcomes」 |
| preview | 取消（终态、无 plan、无副作用） | **PASS** | `tests/core/change-preview.test.ts`「cancels an in-flight preview as a terminal cancelled operation with no plan」 |
| install apply | pre-commit 失败→旧代不变、plan 不消费 | **PASS** | `tests/core/change-apply-guards.test.ts`「keeps the old generation unchanged and does not consume on a pre-commit failure」 |
| install apply | **pre-commit 取消**→`cancelled`、旧代活动、revision 不变、plan 未消费 | **PASS（本片新增）** | `tests/core/change-apply-cancel.test.ts`（新增） |
| install apply | 终态 op 取消→`CANNOT_CANCEL`（`isTerminalStatus` 规则） | **PASS（本片新增）** | `tests/core/change-apply-cancel.test.ts` |
| install apply | **提交窗口内取消**（指针已切、op 仍 `running`）→ `CANNOT_CANCEL`；recovery 四元一致 | **PASS（#92 已修）** | 修复 PR #93，**merge SHA `3457769f3296bfda138af1d19e8ec99615dae5b2`**。旧红：`f8d9cd04` 上 cancel 返回 `ok`、op `cancelled`、ledger 卡 `in-progress`；新绿：`80a2d9ab` 上 `CANNOT_CANCEL` + `recover()` 后 op `succeeded`/指针新代/plan 消费/ledger `completed`（精确断言，缺失失败）。回归：`tests/core/change-apply-cancel.test.ts`（含残余态用例） |
| install apply | 执行器不可用/身份漂移/锁改写等 runtime port 受控失败 | **PASS** | `tests/core/change-apply-runtime-port.test.ts` |
| remove | codeload/registry **连接前**失败 → NETWORK_UNAVAILABLE（retryable） | **PASS** | `tests/core/removal-apply.test.ts`、`tests/plugins/removal-port.test.ts` |
| remove | codeload/registry **传输/完整性**失败 → DOWNLOAD_FAILED（未提交） | **PASS** | removal-apply「registry transfer/integrity failure → DOWNLOAD_FAILED and no commit」 |
| remove | 不可识别失败 → 脱敏、非重试 INTERNAL_ERROR | **PASS** | removal-apply「unidentifiable install failure → sanitized non-retryable INTERNAL_ERROR」 |
| **install** | 上述三类网络/传输分类在**插件安装**侧成立（三阶段复用同一分类） | **PASS（#94 已修并合并）** | 修复 PR #96，**merge SHA `0e45186e30a86ace84ac7c6e5b20223c86e0258d`**（#94 已关闭）。证据：`tests/plugins/apply-install-failure-classification.test.ts`（真实 `createPluginApplyPort`、仅注入 executor；3 阶段 × 9 类，逐例断言 code + 无 stderr/canary 泄漏）＋ `tests/core/change-apply-authorized.test.ts` 新用例（真 core+runtime port、注入 executor 非零 ⇒ op failed/`NETWORK_UNAVAILABLE`、旧代/revision/plan 不变、staged 清理、新 id 重试成功）。QA 独立复核 @`d85d2e72`：作者用例 32 passed、removal 回归 27 passed、key-negative 探针（403/429/unknown → 非重试 `INTERNAL_ERROR`，无 `RATE_LIMITED`/`retryAfter`，无 canary/主机名泄漏）3 passed；30 核对 `d85d2e72…0e45186e` 逐字节空 diff |
| remove | preview/apply 取消（preview 终态无 plan；pre-commit 取消旧代不变） | **PASS** | removal-apply「cancels a removal preview…」「cancels a removal apply before the commit point…」 |
| remove | **提交窗口内取消**（同源 `cancelOperation`） | **PASS（#92 已修）** | 与 install 同代码路径；**已合并 `3457769f`** 且 QA 已独立验证（`removal-apply` 窗口用例） |
| 幂等 | 同 requestId 重放返原记录、不重复副作用 | **PASS（30 边界审计范围；本片只在网络/取消面引用）** | `tests/core/apply-idempotency-recovery.test.ts`、`tests/contracts/idempotency.test.ts` |
| 幂等 | `retryable` 失败用新 requestId 重试成功（remove） | **PASS** | removal-apply「lets a new requestId retry a pre-commit removal apply failure to success」 |
| 幂等 | **install apply**：真 dispatcher + 真 core，受控 `DOWNLOAD_FAILED` → 同 requestId 重放原终态且**不重复副作用** → **新 id 才重试成功** | **PASS（本片新增；修正后重新验证）** | `tests/core/change-apply-retryable-replay.test.ts`（`createContractRuntime` + 真 `ChangeApplyService`；harness 补 `findOperation`；`expect(first.ok)` **硬断言**、无吞失败早退；`expect(replay).toEqual(first)`、stage 计数 1→1→2、op 终态 `DOWNLOAD_FAILED`、旧代/revision/plan（`consumedBy=null`→`req-install-retry`）/ledger（`completed`）精确断言）。**更正**：该行早前曾以**空洞早退**版本记 PASS，已**撤回**（30 独立复现）；临时移除 `findOperation` 与破坏 ledger 重放的两次红检确认修正后会 **FAIL** |
| 输出/秘密 | 受控错误不泄漏 canary/路径 | **PASS** | `tests/core/plugin-operation-canary.test.ts`、`tests/contracts/plugin-output.test.ts` |

## 本片新增测试（默认 CI、确定性、无产品改动）

`tests/core/change-apply-cancel.test.ts`（**4 项**，`vitest run` 通过）：
1. pre-commit 取消 → `cancelled` 终态、旧代活动、revision 不变、plan `consumedBy=null`；
2. **终态 op** 取消 → `CANNOT_CANCEL`（`isTerminalStatus` 规则，**不是**提交窗口）；
3. **提交窗口**（指针已切、op 仍 `running`）取消 → `CANNOT_CANCEL`；显式预置 in-progress ledger，`recover()` 后**四元一致**（op `succeeded` / 指针新代 / plan 消费 / ledger `completed`；ledger 缺失即失败）；
4. **#92 残余态**（预置 `cancelled` op + committed journal + in-progress ledger）→ `recover()` **不抛异常**且四元一致。

其余新增：`tests/core/change-apply-retryable-replay.test.ts`（install 真 dispatcher 重放/新 id 重试）、`tests/plugins/github-403-precision.test.ts`（403/429 无 rate-limit 头部负控）。

原因：改前 `CANNOT_CANCEL` 仅出现在**未执行**的 scenario plan 与 fixture 码表，缺少已执行行为断言；install-apply 取消亦无确定性测试（remove 侧已有）；#92 的升级遗留态恢复无回归。

## 实质缺口 / 待编排裁决（未记 PASS）

**已修缺陷**：`#92`（提交窗口内取消/恢复分叉）由 PR #93 修复并 merge（`3457769f`）；旧红→新绿见上表。`#94`（install 侧托管安装失败未复用网络/传输分类）由 PR #96 修复并 merge（`0e45186e`），QA 独立复核 @`d85d2e72` 并已记入上表 install 行。

1. **403 区分能力（F1，已裁决 → 跟踪 issue #95）**：`packages/runtime/src/plugins/github.ts:300` 把**任意** `403||429` 映射为 `RATE_LIMITED`（retryable）。可识别限流（带 `x-ratelimit-reset`/`retry-after`）有执行证据；**无 rate-limit 头部的 403/429 负控已存在且已执行**（`tests/plugins/github-403-precision.test.ts`：D11 现状 `RATE_LIMITED` 且**不臆造** `retryAfterSeconds`）。**编排已裁决**：按 D11 现状验证、**不改 D11**；剩余**权限/认证类 403 与限流 403 不可区分**的精度差异转 **issue #95** 跟踪（契约文本 vs 行为精度，由契约 owner/编排评估）。
2. **pnpm/registry 429 不可识别**：受管 pnpm 取包失败分类（`removal-port`/`classifyManagedInstallFailure`）只产出 `NETWORK_UNAVAILABLE`/`DOWNLOAD_FAILED`/`INTERNAL_ERROR`，**无可靠 429 token，不臆造**（与 34/35 结论一致）⇒ 矩阵中「install/remove 429」**未验证为 RATE_LIMITED**，记为**能力限制/AC 覆盖差异**。
3. **remove 提交窗口内取消**：与 install 同源；已随 #93 修复并在候选上由 `removal-apply` 窗口用例覆盖（merge `3457769f`）。

## 未覆盖 / 边界

- 真实 desktop 全链（本片默认 CI 确定性优先）；Windows 未测；E9 未证；事务崩溃边界的 SIGKILL/recover 证据由 30 审计，本片未重复执行。
- 未改产品代码；未使用个人凭据/模型；历史样本未动。

## 覆盖边界（记录，不自动扩产品范围）

- **journal `planned`/`staged` 恢复**：现有 **pre-pointer 边界映射** = `pauseAt/failAt: 'verified'`（提交点前）→ `recover()` 判 rolled-back、旧代可用、plan 未消费；**删 stage 属代码路径** `#rollbackJournal`→`removePath`（install 侧由 `tests/core/change-apply-authorized.test.ts` 新用例断言 staged 代已清理；remove 侧由 `tests/core/removal-apply.test.ts:803` 断言只剩旧代），`tests/core/change-apply-guards.test.ts` 断言旧代/revision/plan 不变。真实 `SIGKILL` 证据见 `tests/core/apply-window-kill.test.ts`。**显式的 `planned`/`staged` 单独注入未在本片执行**，记为覆盖边界（不扩产品范围）。
- **损坏/不可解析 journal**：属**扩展健壮性**，非 S5 明列 AC；记录为覆盖边界，不自动加入产品范围。
- **recovery 自身中断**：`ChangeFaults` 的 `pauseAt`/`failAt`（planned/staged/verified/committed/finalized）seam 已存在，**可定向复用**；是否留下提交状态分叉**未执行**，记为覆盖边界（若缺 seam 则只报告、不改产品）。
- **remove 提交窗口内取消**：与 install 同源（缺陷 #92）；**已随 #93 合并（`3457769f`）并由 QA 独立验证**（install 侧 4 项含四元账本 + `removal-apply` 窗口用例）。
- **CI 计时稳定性（#91 观察）**：同一提交 `f646b4c2` 的 `typecheck/build/unit` 两次运行在不同重 harness 用例上各超时一次：`tests/core/a2-window-kill.test.ts > after-publish`（run `35759611456` job `106854049193`，`Test timed out in 5000ms`）与 `tests/core/creation.test.ts > creates six environments concurrently`（同 run rerun job `106854966031`，5000ms）；同提交另一运行 run `35759606141` 全绿（`998 passed`，两条分别 994ms/473ms）。35 有界诊断：失败运行整体 50.89s vs 成功 21.51s，本地（含 10 核 20 忙循环）未复现 >5s ⇒ **推测为 CI runner 资源波动下默认 5s 预算不足**；**不据此声称产品无问题**。裁决：仅对上述两条重 harness 用例设**用例级** `{ timeout: 20_000 }`（全局 `testTimeout` 5s、其它用例、CI 并行/retry/skip 均不变；断言与子进程有界清理逐行不变）。
- **真实 desktop 全链**：本 PR 走默认 CI 确定性优先，未跑；Windows 未测；E9 未证。
