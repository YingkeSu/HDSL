# S5（#79）失败/取消/网络 + 幂等 验收矩阵（QA owner=33）

- 基线：main `18a5d65197a25e95914e8bd23d54d756d6177d4b`（= S4 #90 merge）。自有 checkout `/tmp/qa33/checkout`；**本片只读产品、仅新增 QA 测试/报告**。
- 方法：复用既有确定性/真实证据优先；风险驱动补缺；只新增默认 CI 确定性测试；真实 desktop 仅必要时自有副本有界执行。事务边界（SIGKILL/recover/journal 对账）由 30 独立审计，本文件不重复。
- 网络面分栏：**GitHub API**（search/preview/install 解析）｜**codeload/registry 取包**（install/remove）｜**受管 pnpm**。不把不同面的失败混称。

## 矩阵（路径 × 失败/取消）

| 路径 | 失败/取消 | 判定 | 证据 |
| --- | --- | --- | --- |
| search | 403/429（可识别限流，带 x-ratelimit/retry-after） | **PASS** | `tests/plugins/github-source.test.ts`「maps 403/429 to RATE_LIMITED with a machine-readable retry delay」 |
| search | 离线/超时（连接前/body 停滞） | **PASS** | github-source「connection failure / timeout before response / stalled body → NETWORK_UNAVAILABLE」 |
| search | malformed / 404 | **PASS** | github-source「malformed → DOWNLOAD_FAILED；404 → SOURCE_NOT_FOUND」 |
| search | 取消（终态、无副作用、迟到结果不复活） | **PASS** | `tests/plugins/plugin-discovery.test.ts`「cancels an in-flight search」「operations.cancel hits the plugin operation」 |
| preview（GitHub 解析） | 限流/中止 | **PASS** | `tests/plugins/github-preview.test.ts`「maps rate limiting and an abort to controlled outcomes」 |
| preview | 取消（终态、无 plan、无副作用） | **PASS** | `tests/core/change-preview.test.ts`「cancels an in-flight preview as a terminal cancelled operation with no plan」 |
| install apply | pre-commit 失败→旧代不变、plan 不消费 | **PASS** | `tests/core/change-apply-guards.test.ts`「keeps the old generation unchanged and does not consume on a pre-commit failure」 |
| install apply | **pre-commit 取消**→`cancelled`、旧代活动、revision 不变、plan 未消费 | **PASS（本片新增）** | `tests/core/change-apply-cancel.test.ts`（新增） |
| install apply | **post-commit 取消**→`CANNOT_CANCEL`、提交 op 仍 `succeeded`、新代保持活动 | **PASS（本片新增）** | `tests/core/change-apply-cancel.test.ts`（新增） |
| install apply | 执行器不可用/身份漂移/锁改写等 runtime port 受控失败 | **PASS** | `tests/core/change-apply-runtime-port.test.ts` |
| install/remove | codeload/registry **连接前**失败 → NETWORK_UNAVAILABLE（retryable） | **PASS** | `tests/core/removal-apply.test.ts`、`tests/plugins/removal-port.test.ts` |
| install/remove | codeload/registry **传输/完整性**失败 → DOWNLOAD_FAILED（未提交） | **PASS** | removal-apply「registry transfer/integrity failure → DOWNLOAD_FAILED and no commit」 |
| install/remove | 不可识别失败 → 脱敏、非重试 INTERNAL_ERROR | **PASS** | removal-apply「unidentifiable install failure → sanitized non-retryable INTERNAL_ERROR」 |
| remove | preview/apply 取消（preview 终态无 plan；pre-commit 取消旧代不变） | **PASS** | removal-apply「cancels a removal preview…」「cancels a removal apply before the commit point…」 |
| 幂等 | 同 requestId 重放返原记录、不重复副作用 | **PASS（30 边界审计范围；本片只在网络/取消面引用）** | `tests/core/apply-idempotency-recovery.test.ts`、`tests/contracts/idempotency.test.ts` |
| 幂等 | `retryable` 失败用新 requestId 重试成功 | **PASS** | removal-apply「lets a new requestId retry a pre-commit removal apply failure to success」 |
| 输出/秘密 | 受控错误不泄漏 canary/路径 | **PASS** | `tests/core/plugin-operation-canary.test.ts`、`tests/contracts/plugin-output.test.ts` |

## 本片新增测试（默认 CI、确定性、无产品改动）

`tests/core/change-apply-cancel.test.ts`（2 项，`vitest run` 通过）：
1. pre-commit 取消 → `cancelled` 终态、旧代活动、revision 不变、plan `consumedBy=null`；
2. post-commit 取消 → `CANNOT_CANCEL`、提交 op 仍 `succeeded`、新代保持活动（**提交后不断言旧组成不变**）。

原因：改前 `CANNOT_CANCEL` 仅出现在**未执行**的 scenario plan 与 fixture 码表，缺少已执行的行为断言；install-apply 的取消也无确定性测试（remove 侧已有）。

## 实质缺口 / 待编排裁决（未记 PASS）

1. **403 区分能力**：`packages/runtime/src/plugins/github.ts:300` 把**任意** `403||429` 映射为 `RATE_LIMITED`（retryable）。可识别限流（带 `x-ratelimit-reset`/`retry-after`）已有测试 PASS；但 GitHub 的 **权限/认证类 403** 与限流 403 未加区分，且无「无 rate-limit 头部的 403」测试。冻结契约 D11 原文即「403/429 → RATE_LIMITED」，故这是**契约精度 vs 编排预期**的差异，**请编排裁决**；`retryAfterSeconds` 仅在响应有可靠依据时给出、无则不编造（已核）。
2. **pnpm/registry 429 不可识别**：受管 pnpm 取包失败分类（`removal-port`/`classifyManagedInstallFailure`）只产出 `NETWORK_UNAVAILABLE`/`DOWNLOAD_FAILED`/`INTERNAL_ERROR`，**无可靠 429 token，不臆造**（与 34/35 结论一致）⇒ 矩阵中「install/remove 429」**未验证为 RATE_LIMITED**，记为**能力限制/AC 覆盖差异**。
3. **remove post-commit 取消**的已执行 `CANNOT_CANCEL` 断言缺失（与 install 同形；remove 侧目前只有 pre-commit 取消）。风险低但属矩阵缺口；如需可后续补。

## 未覆盖 / 边界

- 真实 desktop 全链（本片默认 CI 确定性优先）；Windows 未测；E9 未证；事务崩溃边界的 SIGKILL/recover 证据由 30 审计，本片未重复执行。
- 未改产品代码；未使用个人凭据/模型；历史样本未动。
