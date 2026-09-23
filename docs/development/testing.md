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
| 用户主流程 | 少量 E2E | 创建 → 启动 → 停止 → 变更 → 恢复 |
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

当前基线：`3dcb99273c61cc7f7c526aefbbf447a84142e098`（macOS 26.3 arm64 / Node 24.21.0 / Electron 44.4.3）。默认套件实测 `1029 passed | 28 skipped`。

| FR | D｜确定性用例（`pnpm test`） | R｜真实边界（opt-in） | 未测 / 缺口 |
| --- | --- | --- | --- |
| FR-001 隔离目录/ID/默认 home | `tests/core/creation.test.ts` › creates two independent environments…；`tests/integration/install/install.integration.test.ts` › `INST-ISO-01F`、`INST-HOME-01` | `INST-ISO-01`（`HDSL_QA_REAL_INSTALL=1`）；`tests/integration/process/two-environments.real.test.ts`（`HDSL_QA_REAL_DSH=1`）：两环境并发启动、目录/origin 互不相同、宿主 HOME 不变 | — |
| FR-002 精确版本/平台/来源/SHA-256 | `tests/install/composition.test.ts`（仅 macOS ARM64、digest golden）；`tests/install/download.test.ts`（`DIGEST_MISMATCH`）；`tests/core/creation.test.ts` › rejects unknown, unverified and platform-mismatched…；`INST-DIG-01`、`INST-CAT-01` | `INST-COMP-REAL-01`（真实闭包 manifest/lock/preflight）；`two-environments.real.test.ts` 的 `npm-ci` 安装 | Windows/Linux 组合不在 catalog（未测平台） |
| FR-003 适配器/参数数组/显式 env/无 shell | `tests/process/lifecycle.test.ts` › injects credentials through the explicit environment…；`tests/process/core-loader-wiring.test.ts`；`tests/integration/process/process.credential-wiring.integration.test.ts` › `PROCESS-ENV-MAP01`；**`tests/integration/process/argv-boundary.integration.test.ts`（S4：exact argv + 无 `sh -c`）** | `tests/process/real-process.evidence.test.ts`（`HDSL_REAL_PROCESS=1`） | — |
| FR-004 有界就绪/仅 loopback | `tests/process/readiness.test.ts`；`tests/process/webui-bootstrap.test.ts`；`tests/desktop/webui.test.ts`；`tests/contracts/security.test.ts` | `tests/process/real-webui-bootstrap.evidence.test.ts`（`HDSL_REAL_WEBUI_BOOTSTRAP=1`）；`E2E-BROWSER-01`（`HDSL_E2E_BROWSER=1`，I 列） | 真实 `shell.openExternal`（→ T008a）；真实 Electron 上的 `START_TIMEOUT`/`PORT_UNAVAILABLE` 到 UI（产品无注入钩子，保持未测） |
| FR-005 幂等启停/进程退出/不误杀 | `tests/process/lifecycle.test.ts`；`tests/integration/process/process.integration.test.ts`（`PROC-READY/TREE/PORT/TIMEOUT/CRASH/PID/OWN`）；`tests/core/data-root-lock.process.test.ts` | `tests/process/real-process.evidence.test.ts`；`two-environments.real.test.ts`（真实启停 + 重启采纳）；`E2E-FAULT-EXIT-01`（`HDSL_E2E_FAULTS=1`）**contract 侧** `stopped` | 真实 UI 自动反映意外退出：**缺陷 #108**（core 已 stopped，渲染器仍「运行中」） |
| FR-006 operation 阶段/终态/可重试 | `tests/contracts/{fixtures,idempotency,boundary}.test.ts`；`tests/core/lifecycle-coordination.test.ts`；`tests/renderer/ui.test.ts`（进度已知/未知、受控错误码 + retry） | `E2E-GUI-START-STOP-01`（`HDSL_E2E_GUI=1`）；`E2E-FAULT-EXIT-01` contract 侧 `PROCESS_EXITED` 收敛 | UI 侧终态展示：**缺陷 #108** |
| FR-007 脱敏/凭据引用/上游本地产物 | `tests/credentials/*`；`tests/contracts/security.test.ts`；`tests/desktop/main-diagnostics.test.ts`（白名单 + canary） | `tests/credentials/keychain-canary.evidence.test.ts`（`HDSL_KEYCHAIN_CANARY=1`）；`tests/process/real-process.evidence.test.ts`（launch record 无 canary/`token=`）；`E2E-QAENTRY-DIAG-01`（`HDSL_E2E_DESKTOP=1`，I 列；向真实 home 植入 `.credentials.yaml`+`logs/` 合成 canary 并断言导出排除） | 真实原生菜单导入/导出（→ T008a） |
| FR-008 失败诊断/重启对账 | `tests/core/creation.test.ts`（journal/restart/idempotency）；`tests/process/reconcile.test.ts`；`INST-JRN-02`、`INST-IDEM-02`（真实子进程重启） | `two-environments.real.test.ts`（`HDSL_QA_REAL_DSH=1`）：新 `ProcessManager` 对同一 dataRoot 调用 `recover()`，两个真实 DSH 进程均为 `adopted`，随后停止 | 真实 Electron 应用崩溃/重启对账（仅 contract/进程层已验） |

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
HDSL_E2E_FAULTS=1       pnpm exec vitest run tests/e2e/desktop.faults.real.test.ts
```

`R` 层结果只对实际执行的精确 SHA 有效；候选变更后必须复跑，不得引用旧结果。
