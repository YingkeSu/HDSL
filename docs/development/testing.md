# 测试策略：覆盖需求与风险

不以全仓 100% 行覆盖作为目标。每个 P0 需求必须关联验收场景；每个高风险故障至少有一个真实边界测试。纯转发、样式与生成模板不重复测试实现细节。

## 覆盖矩阵

| 风险/需求 | 层级 | 最小有效证据 |
| --- | --- | --- |
| 契约版本与包络 | 契约 | apiVersion 不完全一致（major 或 minor）被拒且无副作用；包络含 apiVersion；未知字段被拒 |
| 组成锁定与兼容判断 | 单元/契约 | 相同输入稳定输出；拒绝未知 schema/摘要不匹配；跨平台规范化摘要一致；url 不参与摘要 |
| 幂等与未知 ID | 契约 | 相同 requestId/参数返回原结果且不重做副作用（含 ExportResult 摘要）；同 requestId 不同参数 → IDEMPOTENCY_CONFLICT；未知 ID → NOT_FOUND |
| 修订语义 | 契约/集成 | 纯启停不改变 revision、只递增 stateVersion；组成切换递增 revision；过期 expectedRevision 被拒 |
| 两环境串用 | 集成+实机 | 不同版本和数据标记不互相读取 |
| 启停与就绪 | 进程集成 | 真实子进程、占用端口、退出、超时、幂等 stop |
| 事件订阅 | 契约/集成 | 每 operation sequence 递增，多操作订阅按 operationId 分组；unsubscribe 后停止；重连以 operations.get 为准 |
| 事务中断/磁盘满/锁冲突 | 文件集成 | 各提交边界故障注入与进程重启恢复；创建/安装未完成操作可对账 |
| 路径穿越/链接/解压膨胀 | 包集成 | 恶意 fixture 被拒绝且外部目录无改动 |
| 凭据泄漏（受管用户 API 凭据） | 导出/日志集成 | 注入 canary secret 到凭据引用，进程环境按引用解析；所有导出/日志/错误无命中（导出项归 T006） |
| 凭据泄漏（上游生成 secret） | 文件/导出集成 | 确认环境 home 的 `.credentials.yaml` 与 `logs/` 被排除且导出脱敏；不假设上游不落盘；不要求改由 OS store 引用（见 [ADR 0002](../adr/0002-credential-boundary.md)） |
| WebUI 端点 | 进程/UI 集成 | main 原生打开属于当前受管进程的 loopback endpoint；renderer 不接收 token URL；非 loopback/非本进程被拒 |
| 恢复的可变数据边界 | 集成+UI | 旧数据保留，提示新会话不自动合并 |
| 用户主流程 | 少量 E2E | 首条切片创建 → 启动 → 停止：`E2E-MAIN-FLOW-01`（单条真实 UI 主旅程，真实安装 + 真实启停）；变更 → 恢复属 M2 |
| 跨平台差异 | macOS/Windows 实机 | 路径、权限、锁、rename、进程树、签名与打包 |

## 工具与边界

当前使用 Vitest 测试核心与契约，真实桌面测试通过 Electron 与 CDP 驱动；工具版本由 workspace 依赖锁定。不要为每个 DSH 版本乘上所有插件组合：支持矩阵选受支持边界版本与代表性组合，未知组合明确标识。

CI 包含仓库文档检查，以及 Ubuntu 上的类型检查、构建和默认 Vitest 测试。真实 DSH、凭据和 GUI 场景通过环境变量单独启用，不属于默认 CI；路径、权限、锁、rename 与进程树等平台敏感项由 T008 实机验收，不得用 ubuntu 结果代替 macOS/Windows 结论。当前验收在本机 macOS ARM64 完成；Windows x64 由维护者稍后自行测试，未测前不声称支持、不阻塞 macOS 阶段，见 [ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)。

故障修复增加能复现旧故障的测试；检查通过后没有新变化不反复跑全套。测试替身必须在结果中显式标注，不得把 mock 记作实机证据。

## 运行测试

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py

# 按修改范围运行
pnpm exec vitest run tests/contracts tests/core
pnpm exec vitest run tests/renderer tests/desktop
pnpm exec vitest run tests/integration/install tests/integration/process
```

默认测试也会创建临时文件和测试子进程；真实安装、钥匙串及桌面测试另有启用条件。执行前阅读对应说明：

- [安装集成测试](../../tests/integration/install/README.md)。
- [进程集成测试](../../tests/integration/process/README.md)与[运行时进程测试](../../tests/process/README.md)。
- [桌面 E2E](../../tests/e2e/README.md)：需要可运行 Electron 的桌面环境；真实 DSH 下载需要网络。

跳过的测试不计为通过。历史结果保留在各验证记录中，新提交应记录本次实际执行的结果。

## FR-001..FR-008 证据映射（T007）

本表把 001 规格的每个 FR 映射到**可执行用例 ID**与**证据分层**，作为 T007 的完成条件。它不使用历史对话结论：标 `R` 的行只在注明的 opt-in 命令实际执行后成立，未执行时按“未测”读。

分层口径：

- **D｜确定性默认套件**：`pnpm test` 覆盖。真实生产代码 + 真实子进程/文件，但入口是受控替身（`fake-dsh.mjs` / `fixture-process.mjs` / 合成 tar / 内存端口）。
- **R｜真实生产边界**：opt-in，真实受管 `npm ci` 安装、真实 DSH、真实 keychain、真实 production Electron。
- **I｜注入 lane**：`qa-entry` 测试入口/注入 opener/注入凭据 setup；不能替代原生菜单或真实 `shell.openExternal`。
- **H｜测试宿主**：`sender-frame-host.mjs`，纵深验证列，不是产品第一层防线。

阶段 1 基线与**本批执行 head** 分开记录；仓库规则：R 层结果只对实际执行的精确 SHA 有效。

| 角色 | 精确 SHA | 默认套件实测 |
| --- | --- | --- |
| 阶段 1 只读核查基线 | `3dcb99273c61cc7f7c526aefbbf447a84142e098` | `1029 passed \| 28 skipped` |
| S1–S7 批（PR #109） | `3f51e066b5d196767dac8f0aee3b431b1c758c87` | `1030 passed \| 30 skipped`；`tests/e2e` 默认 `20 passed \| 21 skipped (41)` |
| **本批（残余故障/重启 QA，PR 见正文）执行 head** | `fb5da940be2f1f5a043ff255a950255beb78517b` | 默认 `1116 passed \| 31 skipped (1147)`；`tests/e2e` 默认 `20 passed \| 22 skipped (42)` |
| #100 原生收尾复核（本切片，PR 见正文） | `9cc275947323b5836f3c86648d559d577fae3349` | 默认 `1183 passed \| 32 skipped (1215)`；`tests/e2e` 默认 `20 passed \| 22 skipped (42)`；opt-in 真实/注入 lane 见 [desktop-validation.md](desktop-validation.md) 的「#100 原生收尾复核」节 |
| **本批（真实 UI 主流程验收，PR 见正文）执行 head** | `6324d529089168b13fdf2eb60617ba4dd3dfa012` | 默认 `1183 passed \| 33 skipped (1216)`；`tests/e2e` 默认 `20 passed \| 23 skipped (43)`；opt-in `E2E-MAIN-FLOW-01` 1 passed |

环境（同一台机）：macOS 26.3 arm64 / Node 24.21.0 / pnpm 11.7.0 / Electron 44.4.3。R 层结果只对**实际执行**的精确 SHA 成立：本批真实 lane 在 `fb5da94`（仅 `tests/e2e` 变更的代码提交）上执行；其上的纯文档提交不改变被测 blob，但引用时仍以该 SHA 为准。不得把任一批计数当作阶段 1 基线计数。

#100 复核切片（head `9cc275947323b5836f3c86648d559d577fae3349`）在同一台机、同一门禁下复跑生产入口真实/注入 lane：`desktop.real` 9、`desktop.findings.real` 2、`desktop.injected.real` 3、`desktop.gui.real` 1、`desktop.quit.real` 3、`desktop.faults.real` 2、`desktop.browser.real`（注入 opener）1，以及 `HDSL_QA_REAL_DSH=1` 两环境隔离/重启采纳 1；全部通过。原生 NSOpenPanel/NSSavePanel 与真实 `shell.openExternal` 仍未测（人工/外部条件）。逐项映射与清理见 [desktop-validation.md](desktop-validation.md)。R 层结果只对该 SHA 成立。

本批在 `6324d52`（仅 `tests/e2e` 新增用例的代码提交）实际执行的 opt-in 结果（真实 UI 主流程）：

- `HDSL_E2E_MAIN_FLOW=1 pnpm exec vitest run tests/e2e/desktop.main-flow.real.test.ts`：**1 passed / 1 file（50.7s）**。证据 `HDSL_T007_MAIN_FLOW_EVIDENCE`（`createdState="stopped"`、`runningLabel="运行中"`、`stoppedLabel="已停止"`、`finalContractState="stopped"`，凭据为 setup 注入、非原生菜单）。运行后无 `hdsl-e2e-run-*` 残留、无 keychain 残留。

本批在 `fb5da94` 实际执行的 opt-in 结果：

- `HDSL_E2E_FAULTS=1 pnpm exec vitest run tests/e2e/desktop.faults.real.test.ts`：**2 passed / 1 file（119.27s）**。证据 `HDSL_T007_FAULT_EXIT_EVIDENCE`（`rendererLabelAfterExit="已停止"`）与 `HDSL_T007_RESTART_EVIDENCE`（`resolution="adopted-after-launcher-crash"`，`rendererLabelAfterRestart="运行中"`，`finalState="stopped"`）。运行后无 `hdsl-e2e-run-*` 残留、无 keychain 残留。

| FR | D｜确定性用例（`pnpm test`） | R｜真实边界（opt-in） | 未测 / 缺口 |
| --- | --- | --- | --- |
| FR-001 隔离目录/ID/默认 home | `tests/core/creation.test.ts` › creates two independent environments…；`tests/integration/install/install.integration.test.ts` › `INST-ISO-01F`、`INST-HOME-01` | `INST-ISO-01`（`HDSL_QA_REAL_INSTALL=1`）；`tests/integration/process/two-environments.real.test.ts`（`HDSL_QA_REAL_DSH=1`）：两环境并发启动、目录/origin 互不相同、宿主 HOME 不变；`E2E-MAIN-FLOW-01`（`HDSL_E2E_MAIN_FLOW=1`）：隔离临时根上经真实 UI 创建并启停同一环境 | — |
| FR-002 精确版本/平台/来源/SHA-256 | `tests/install/composition.test.ts`（仅 macOS ARM64、digest golden）；`tests/install/download.test.ts`（`DIGEST_MISMATCH`）；`tests/core/creation.test.ts` › rejects unknown, unverified and platform-mismatched…；`INST-DIG-01`、`INST-CAT-01` | `INST-COMP-REAL-01`（真实闭包 manifest/lock/preflight）；`two-environments.real.test.ts` 的 `npm-ci` 安装 | Windows/Linux 组合不在 catalog（未测平台） |
| FR-003 适配器/参数数组/显式 env/无 shell | `tests/process/lifecycle.test.ts` › injects credentials through the explicit environment…；`tests/process/core-loader-wiring.test.ts`；`tests/integration/process/process.credential-wiring.integration.test.ts` › `PROCESS-ENV-MAP01`；**`tests/integration/process/argv-boundary.integration.test.ts`（S4：exact argv + 无 `sh -c`）** | `tests/process/real-process.evidence.test.ts`（`HDSL_REAL_PROCESS=1`） | — |
| FR-004 有界就绪/仅 loopback | `tests/process/readiness.test.ts`；`tests/process/webui-bootstrap.test.ts`；`tests/desktop/webui.test.ts`；`tests/contracts/security.test.ts` | `tests/process/real-webui-bootstrap.evidence.test.ts`（`HDSL_REAL_WEBUI_BOOTSTRAP=1`）；`E2E-BROWSER-01`（`HDSL_E2E_BROWSER=1`，I 列） | 真实 `shell.openExternal`（→ T008a / #100）；真实 Electron 上的 `START_TIMEOUT`/`PORT_UNAVAILABLE` 到 UI：**已决议排除出首条切片 UI 验收范围**（[#123](https://github.com/YingkeSu/HDSL/issues/123)；产品入口只以 `--port 0` 请求 OS 分配端口、就绪预算为内部固定值，无产品 hook 或外部注入可确定性触发），只按 D 层 + 契约层验收，见下方“真实 UI 缺口判定” |
| FR-005 幂等启停/进程退出/不误杀 | `tests/process/lifecycle.test.ts`；`tests/integration/process/process.integration.test.ts`（`PROC-READY/TREE/PORT/TIMEOUT/CRASH/PID/OWN`）；`tests/core/data-root-lock.process.test.ts` | `tests/process/real-process.evidence.test.ts`；`two-environments.real.test.ts`（真实启停 + 重启采纳）；`E2E-MAIN-FLOW-01`（`HDSL_E2E_MAIN_FLOW=1`）：真实 UI 启动 → `运行中` → 停止 → `已停止`；`E2E-FAULT-EXIT-01`（`HDSL_E2E_FAULTS=1`）：真实 SIGKILL 受管进程后 **contract `stopped` 且真实渲染器收敛 `已停止`**（#108 已由 PR #120 / ADR 0008 的 `environment.updated` 推送修复，本批在 `fb5da94` 断言） | — |
| FR-006 operation 阶段/终态/可重试 | `tests/contracts/{fixtures,idempotency,boundary}.test.ts`；`tests/core/lifecycle-coordination.test.ts`；`tests/renderer/ui.test.ts`（进度已知/未知、受控错误码 + retry） | `E2E-GUI-START-STOP-01`（`HDSL_E2E_GUI=1`）；`E2E-MAIN-FLOW-01`：真实 UI 主旅程的启动操作面板与两个终态标签；`E2E-FAULT-EXIT-01`：意外退出后真实 UI 终态收敛 `已停止`（`PROCESS_EXITED`，无手动刷新） | 真实 UI 上的受控失败码 `START_TIMEOUT`/`PORT_UNAVAILABLE` 展示：**已决议排除出首条切片 UI 验收范围**（同 FR-004 / [#123](https://github.com/YingkeSu/HDSL/issues/123)）；受控码渲染本身已有 D 层证据（`tests/renderer/ui.test.ts` 断言 `START_TIMEOUT` 码 + retry） |
| FR-007 脱敏/凭据引用/上游本地产物 | `tests/credentials/*`；`tests/contracts/security.test.ts`；`tests/desktop/main-diagnostics.test.ts`（白名单 + canary） | `tests/credentials/keychain-canary.evidence.test.ts`（`HDSL_KEYCHAIN_CANARY=1`）；`tests/process/real-process.evidence.test.ts`（launch record 无 canary/`token=`）；`E2E-QAENTRY-DIAG-01`（`HDSL_E2E_DESKTOP=1`，I 列；向真实 home 植入 `.credentials.yaml`+`logs/` 合成 canary 并断言导出排除） | 真实原生菜单导入/导出（→ T008a） |
| FR-008 失败诊断/重启对账 | `tests/core/creation.test.ts`（journal/restart/idempotency）；`tests/process/reconcile.test.ts`；`INST-JRN-02`、`INST-IDEM-02`（真实子进程重启） | `two-environments.real.test.ts`（`HDSL_QA_REAL_DSH=1`）：新 `ProcessManager` 对同一 dataRoot 调用 `recover()`，两个真实 DSH 进程均为 `adopted`，随后停止；**`E2E-APP-CRASH-RESTART-01`（`HDSL_E2E_FAULTS=1`）：SIGKILL 真实 Electron 主进程后受管 DSH 存活，重启实例接管陈旧 lease 并按 pid 采纳同一进程（`运行中`），再经真实 UI 停止** | — |

### 复跑命令

```sh
# D 层：默认套件
pnpm test

# R 层（各自独立临时根；真实网络/安装/Electron；无模型调用）
HDSL_QA_REAL_INSTALL=1  pnpm exec vitest run tests/install/real-install.evidence.test.ts
HDSL_REAL_PROCESS=1     pnpm exec vitest run tests/process/real-process.evidence.test.ts
HDSL_REAL_WEBUI_BOOTSTRAP=1 pnpm exec vitest run tests/process/real-webui-bootstrap.evidence.test.ts
HDSL_KEYCHAIN_CANARY=1  pnpm exec vitest run tests/credentials/keychain-canary.evidence.test.ts
HDSL_QA_REAL_DSH=1      pnpm exec vitest run tests/integration/process/two-environments.real.test.ts
HDSL_E2E_DESKTOP=1      pnpm exec vitest run tests/e2e/desktop.injected.real.test.ts
HDSL_E2E_GUI=1          pnpm exec vitest run tests/e2e/desktop.gui.real.test.ts
HDSL_E2E_MAIN_FLOW=1    pnpm exec vitest run tests/e2e/desktop.main-flow.real.test.ts
HDSL_E2E_FAULTS=1       pnpm exec vitest run tests/e2e/desktop.faults.real.test.ts
```

`R` 层结果只对实际执行的精确 SHA 有效；候选变更后必须复跑，不得引用旧结果。

### 真实 UI 缺口判定：已决议排除 / 待人工条件

以下 001 失败语义已有 D 层确定性覆盖，但**无法在当前产品边界上确定性驱动到真实 Electron UI**。本轮结论：不添加测试专用产品注入（#123 决议），能按 D 层 + 契约层验收的码不再作为真实 UI 验收项；其余缺口需要人工或专用宿主条件。

- `START_TIMEOUT` / `PORT_UNAVAILABLE` 到真实 UI：**决议排除出首条切片 UI 验收范围**（[#123](https://github.com/YingkeSu/HDSL/issues/123)，已按此关闭）。依据：
  - `PORT_UNAVAILABLE` 在 UI 主流程**结构上不可达**。契约 `environments.start` 的输入只有 `requestId`/`environmentId`/`expectedRevision`（`packages/contracts/src/methods.ts`）；core 构造进程请求时不传 `port`（`packages/core/src/creation-service.ts`），管理器固定以 `--port 0` 请求 OS 分配端口（`packages/runtime/src/process/manager.ts`），OS 不会为 `0` 返回占用冲突；pinned-port 分支只能由 D 层直接请求（`PROC-PORT-01`）触发。
  - `START_TIMEOUT` **无产品入口可驱动**。就绪预算是内部固定值（默认 60s，生产组合 `apps/desktop/src/main/composition.ts` 不覆盖），没有产品入口收紧；真实受管 DSH 在验收环境会就绪。只有上游/安装缺陷导致长时间不 ready 才可能触发，无法用真实 DSH 确定性复现；用合成夹具强行驱动得到的是夹具行为，不构成真实 UI 证据。
  - D 层证据已覆盖两码的失败语义：`tests/process/lifecycle.test.ts`、`tests/integration/process/process.integration.test.ts`（`PROC-PORT-01` / `PROC-TIMEOUT-01`）、契约合法码 `tests/contracts/fixtures.test.ts`；生产 argv 的 `--port 0` 由 `tests/integration/process/argv-boundary.integration.test.ts` 固定，使“不可达”前提可回归。受控码的 UI 渲染由 `tests/renderer/ui.test.ts` 确定性覆盖。D 层用短就绪预算驱动超时分支，不单独断言生产 60s 值；该值是安全兜底上限，不是用户配置项。
  - 若将来出现**真实用户可见的可配置性需求**（例如用户要求固定端口或可调就绪预算），另开 issue 评审安全边界、失败语义与 UI 文案，再补真实 UI 断言；不以此为理由先加隐藏 hook。
- 真实 `shell.openExternal` 系统浏览器路径、原生 NSOpenPanel/NSSavePanel：注入 opener / `qa-entry` 注入路径**不可互代**；由 #100（原生 macOS 验收，需人工/专用宿主）承接。
- 真实上游 `.credentials.yaml`（rc2 在真实 Web grant 下是否落盘）的可复现排除：`E2E-QAENTRY-DIAG-01` 已用真实受管 home + 合成 canary 固化**生产导出排除逻辑**，但“真实上游是否产生该文件”依赖一次性真实模型凭据，属外部/人工条件（#100）。
