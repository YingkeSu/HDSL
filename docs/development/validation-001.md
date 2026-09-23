# macOS ARM64 实机验收证据汇总（T008a / issue #137）

状态：**只汇总既有证据，不重跑重型 opt-in lane、不冒充 Windows/Linux**。本文件不实现功能、不改生产代码或契约，也不把任意一条历史计数当作当前提交的自动有效状态。每条结论都回指**其实际执行的精确 SHA**与原始记录文件。

- 任务：[#137 [T008a] 汇总现有 macOS ARM64 实机证据](https://github.com/YingkeSu/HDSL/issues/137)，父任务 [#8 T008](https://github.com/YingkeSu/HDSL/issues/8)。
- 依赖：T007 [#7](https://github.com/YingkeSu/HDSL/issues/7) **已满足（CLOSED）**；本 issue 不依赖 Windows 主机。
- 汇总基线（执行本汇总时 `origin/main`）：`17556e74076bfe583028aee547291d7cfbe14296`。
- 本文件所有权：本任务；不修改生产代码、`tests/**`、`docs/development/testing.md`、`desktop-validation.md` 或根配置。

## 1. 执行环境与版本

| 项 | 值 |
| --- | --- |
| 平台 | macOS 26.3（Build `25D125`），Darwin arm64 |
| 证据链工具链 Node | `v24.21.0`（仓库 `.nvmrc`；R/D 层记录均在此版本下运行） |
| pnpm | `11.7.0`（`packageManager`） |
| Electron | `44.4.3`（`apps/desktop/package.json`） |
| 汇总基线 `origin/main` | `17556e74076bfe583028aee547291d7cfbe14296` |
| 汇总工具链（仅运行轻量仓库检查） | 宿主默认 Node `v25.6.1`，`pnpm 11.7.0`，`python3` |

历史记录中另有两处工具链例外，原记录已如实标注，本文沿用不覆盖：T005b 凭据 canary 证据在 Node `v26.8.1`（root `engines` 允许 `>=26.0.0`）下执行；早期阶段 1 基线记录在 Node `24.21.0`。

> 本汇总**未执行**任何 opt-in 真实 lane（`HDSL_QA_REAL_INSTALL`、`HDSL_REAL_PROCESS`、`HDSL_REAL_WEBUI_BOOTSTRAP`、`HDSL_KEYCHAIN_CANARY`、`HDSL_QA_REAL_DSH`、`HDSL_E2E_*`）。这些结果按原文件与精确 SHA 引用，不重新生成。本汇总只运行轻量仓库检查 `python3 scripts/check_repository.py`。

## 2. 证据分层口径（沿用 [testing.md](testing.md)）

- **D｜确定性默认套件**：`pnpm test` 覆盖。真实生产代码 + 真实子进程/文件，但入口是受控替身（`fake-dsh.mjs` / `fixture-process.mjs` / 合成 tar / 内存端口）。
- **R｜真实生产边界**：opt-in，真实受管 `npm ci` 安装、真实 DSH、真实 keychain、真实 production Electron。
- **I｜注入 lane**：`qa-entry` 测试入口/注入 opener/注入凭据 setup；不能替代原生菜单或真实 `shell.openExternal`。
- **H｜测试宿主**：`sender-frame-host.mjs`，纵深验证列，不是产品第一层防线。

目录、进程与 home 隔离是**受管目录/进程/home 层面的隔离**，用于不写宿主默认目录；它**不是操作系统沙箱**，本文件及所引记录均不这样描述。

## 3. 已引用的证据来源（文件 → 来源 SHA → 分层）

| 来源文件 | 来源 SHA | 主要分层 | 原始结果（详见对应文件） |
| --- | --- | --- | --- |
| [testing.md](testing.md) FR 映射表 | 见其表内每行 SHA | D/R/I/H | 阶段 1 基线 `1029 passed \| 28 skipped`；S1–S7 `1030 passed \| 30 skipped`；残余 QA 批 `1116 passed \| 31 skipped (1147)`；#100 复核 `1183 passed \| 32 skipped (1215)`；真实 UI 主流程批 `1183 passed \| 33 skipped (1216)` |
| [install-validation.md](install-validation.md) | 候选 `ccaaeb94a691ac943adf7a0ba471285349d1953f`（PR #35，base `6da541d`）；生产合并 `dbf0ef00a4c090f10928ffad5a1d1ac1cdfd7033` | D + R（注入/真实小卷） | 合成边界 16 项全绿；真实闭包 2 项 PASS（`INST-ISO-01` 55.7s、`INST-COMP-REAL-01` 58.1s） |
| [t004-install-evidence.md](t004-install-evidence.md) | 基线 `6da541d866561ad64eaad82b22b33fe5f9ee3e25` | R | `HDSL_REAL_INSTALL=1` → `1 passed`（56.7s），两组合真实 `npm ci`，`packageCount=585`，宿主 `~/.dsh` 不变 |
| [process-validation.md](process-validation.md) | runtime PR #48 merge `242fea9a395e2a646d3522e9dc1a02d7afece807`；修复候选 `86a223b`、`4acb95a`、`e835a870d43acb4318ec6480eb89dd0616480906` | D + R（真实 DSH opt-in） | `tests/integration/process/` 47 passed / 1 skipped（skip 仅为真实 DSH opt-in）；真实 DSH 启停在 `4acb95a`（7.6s）与 `e835a870`（10.1s）各一次 PASS |
| [t005-process-evidence.md](t005-process-evidence.md) | 基线 `7fbdc1e2607f4f695e6389296f56b3ba2600fa43`；真实 lane 提交 `9927af8cb35731f93122e438b1f1a308b0ea695f` | D + R | `pnpm run test` 576 passed / 5 skipped（其中 tests/process 67）；`HDSL_REAL_PROCESS=1` → `1 passed`（3.6s） |
| [dataroot-lock-validation.md](dataroot-lock-validation.md) | 候选 `5bf7091011b137955ab4cfd83c746b9baf01b832`（PR #49） | D + R + 注入 | 锁场景 `16 passed`；真实第二进程、SIGKILL 接管、三方竞争各 1 持有者 |
| [t006-webui-bootstrap-evidence.md](t006-webui-bootstrap-evidence.md) | 基线 `cd8ca74bece8844f00f9988ec5494575f750e577` | D + R | `HDSL_REAL_WEBUI_BOOTSTRAP=1` → `1 passed`（3.8s），`303`+`Set-Cookie` → `401` → `200` |
| [t006-desktop-acceptance-evidence.md](t006-desktop-acceptance-evidence.md) | 基线 `a36fdb96cbc8be529f5ddd68d132fc9adc92ffe9` | D + R/I/H | `107 files passed \| 11 skipped`，`1029 passed \| 27 skipped`；真实桌面 lane 见其 §3 |
| [desktop-validation.md](desktop-validation.md) | `2cdea54a9c65252b8d2809737723018ca5b2f801`、`9b52364d8a999617e1537e6ce97c419fb1ebd04e`（红证据）、`fb5da940be2f1f5a043ff255a950255beb78517b`、`9cc275947323b5836f3c86648d559d577fae3349` | R/I/H | 见 §4 与 §5；矩阵 37 条 opt-in，默认 20 passed / 17 skipped |
| [credentials.md](credentials.md) | 基线 `7fbdc1e2607f4f695e6389296f56b3ba2600fa43` | D + R | `tests/credentials` 70 项；`HDSL_KEYCHAIN_CANARY=1` 真实 canary（Node `v26.8.1`）通过 |
| [version-switch-validation.md](version-switch-validation.md) | 基线 `ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa` | D（真实 opt-in **未测**） | 事务/回滚/恢复/幂等确定性用例通过；真实 `npm-ci` 切换未运行 |

## 4. FR-001..FR-008 逐项汇总

约定：每项列出**来源 SHA**、**实际执行的命令**、**实际结果**、**证据分层**与**通过/失败/未测**结论。命令只列原始记录中实际执行过的；带 opt-in 前缀的为 R 层。

### FR-001 独立环境 ID/名称/数据根，禁止写其他环境或默认 home

| 项 | 内容 |
| --- | --- |
| 来源 SHA | D：`ccaaeb94`（PR #35）、`9cc275947323b5836f3c86648d559d577fae3349`；R：`ccaaeb94`、`9cc27594`、`6324d529089168b13fdf2eb60617ba4dd3dfa012` |
| 命令 | `pnpm test`；`pnpm exec vitest run tests/integration/install/install.integration.test.ts`；`HDSL_QA_REAL_INSTALL=1 pnpm exec vitest run tests/install/real-install.evidence.test.ts`；`HDSL_QA_REAL_DSH=1 pnpm exec vitest run tests/integration/process/two-environments.real.test.ts`；`HDSL_E2E_MAIN_FLOW=1 pnpm exec vitest run tests/e2e/desktop.main-flow.real.test.ts` |
| 结果 | D：`INST-ISO-01F`、`INST-HOME-01` 通过，`~/.dsh` 逐字节不变；R：`INST-ISO-01` 两组合真实 `npm-ci` PASS；`two-environments.real` `1 passed`（82.42s），`recoverResolutions=["adopted","adopted"]`、`hostHomeUntouched=true`、两环境 origin 互不相同；`E2E-MAIN-FLOW-01` `1 passed`（50.7s），在隔离临时根上经真实 UI 创建并启停同一环境 |
| 分层 | D + R |
| 结论 | **通过**（macOS ARM64）。目录/home 隔离，不是 OS 沙箱。 |

### FR-002 精确运行时版本/平台/来源/SHA-256，拒绝不受支持组成

| 项 | 内容 |
| --- | --- |
| 来源 SHA | D：`ccaaeb94`；R：`6da541d866561ad64eaad82b22b33fe5f9ee3e25`、`ccaaeb94` |
| 命令 | `pnpm exec vitest run tests/install/composition.test.ts tests/install/download.test.ts tests/core/creation.test.ts`；`HDSL_QA_REAL_INSTALL=1 pnpm exec vitest run tests/integration/install/install.integration.test.ts -t "install real closure"`；`HDSL_REAL_INSTALL=1 pnpm exec vitest run tests/install/real-install.evidence.test.ts` |
| 结果 | D：仅 macOS ARM64 两条 catalog 组合；`DIGEST_MISMATCH`、`UNSUPPORTED_COMBINATION`、catalog 不一致拒绝均通过。R：两组合真实 `npm ci`，`packageCount=585`、`lockSha256=da075539…a5cd`、`treeDigest=f5af577d…d5cb`、preflight `node/dsh --version/--help` 全 `exit 0`；独立 `shasum -a 256` 复算的 Node/DSH 摘要与 catalog 一致 |
| 分层 | D + R |
| 结论 | **通过**（仅 macOS ARM64）。**Windows/Linux 组合不在 catalog（未测平台）**。 |

### FR-003 受核验适配器 + 参数数组 + 显式进程环境，不拼 shell

| 项 | 内容 |
| --- | --- |
| 来源 SHA | D：`7fbdc1e2`、`e835a870`；R：`9927af8cb35731f93122e438b1f1a308b0ea695f` |
| 命令 | `pnpm test`（`tests/process/lifecycle.test.ts`、`tests/process/core-loader-wiring.test.ts`、`tests/integration/process/argv-boundary.integration.test.ts`）；`HDSL_REAL_PROCESS=1 pnpm exec vitest run tests/process/real-process.evidence.test.ts` |
| 结果 | D：`PROCESS-ENV-MAP01` 五键映射与 core 精确一致；`PROCESS-ENV-MAP01-CONFLICT` spawn 前受控失败且 `dispose=1`；argv 边界固定 exact argv 且无 `sh -c`；宿主变量 `__HDSL_HOST_LEAK__` 不泄漏。R：真实受管 Node 22.19.0 + DSH 0.1.5-rc.2 启动/停止 `1 passed`（3.6s），`launchRecordState="running"`，`startTokenPresent=true` |
| 分层 | D + R |
| 结论 | **通过**。 |

### FR-004 有界就绪，仅 loopback，WebUI 只用已核验端点

| 项 | 内容 |
| --- | --- |
| 来源 SHA | D：`cd8ca74bece8844f00f9988ec5494575f750e577`、`a36fdb96`；R：`cd8ca74`；I：`9cc275947323b5836f3c86648d559d577fae3349` |
| 命令 | `pnpm test`（`tests/process/readiness.test.ts`、`tests/process/webui-bootstrap.test.ts`、`tests/desktop/webui.test.ts`、`tests/contracts/security.test.ts`）；`HDSL_REAL_WEBUI_BOOTSTRAP=1 pnpm exec vitest run tests/process/real-webui-bootstrap.evidence.test.ts`；`HDSL_E2E_BROWSER=1 pnpm exec vitest run tests/e2e/desktop.browser.real.test.ts` |
| 结果 | D：`parseReadyTarget` 拒绝非 loopback/userinfo/非 http(s)/越界端口；bootstrap 生命周期与 `WEBUI_UNAVAILABLE` 通过。R：真实 rc.2 实例 bootstrap URL → `303` + `dsh-auth` cookie；无 cookie origin → `401`；带 cookie → `200` HTML；`LaunchRecord` 不含 `token=`；stop 后 `WEBUI_UNAVAILABLE`（`1 passed`，3.8s）。I：注入 opener 用真实 Chrome + 临时 profile，`1 passed`（45.88s），rc2 应用身份断言 + 无 cookie 负向对照 |
| 分层 | D + R + I |
| 结论 | **通过**（loopback/HTTP 层与注入 opener）。**真实 `shell.openExternal` 未测**（见 §6）。**`START_TIMEOUT`/`PORT_UNAVAILABLE` 到真实 UI 已决议排除**（[#123](https://github.com/YingkeSu/HDSL/issues/123)）。 |

### FR-005 幂等启停、进程退出跟踪，不凭过期 PID 终止

| 项 | 内容 |
| --- | --- |
| 来源 SHA | D：`242fea9a`（PR #48）、`e835a870`；R：`9927af8c`、`9cc27594`、`6324d529`、`fb5da940be2f1f5a043ff255a950255beb78517b` |
| 命令 | `pnpm test`（`tests/process/lifecycle.test.ts`、`tests/integration/process/process.integration.test.ts`、`tests/core/data-root-lock.process.test.ts`）；`HDSL_REAL_PROCESS=1 …real-process.evidence.test.ts`；`HDSL_QA_REAL_DSH=1 …two-environments.real.test.ts`；`HDSL_E2E_MAIN_FLOW=1 …desktop.main-flow.real.test.ts`；`HDSL_E2E_FAULTS=1 pnpm exec vitest run tests/e2e/desktop.faults.real.test.ts` |
| 结果 | D：`PROC-READY/TREE/PORT/TIMEOUT/CRASH/PID/OWN` 通过；身份不匹配/陈旧 startToken 保守拒杀。R：真实 DSH 启停通过；`two-environments.real` 真实重启 `recover()` 两进程均 `adopted`；`E2E-MAIN-FLOW-01` 真实 UI 启动→`运行中`→停止→`已停止`；`E2E-FAULT-EXIT-01`（`fb5da94`）真实 SIGKILL 受管进程后生产契约收敛 `stopped` 且真实渲染器 `已停止`，`desktop.faults.real.test.ts` `2 passed`（119.27s） |
| 分层 | D + R |
| 结论 | **通过**。 |

### FR-006 operation 阶段/终态/可重试

| 项 | 内容 |
| --- | --- |
| 来源 SHA | D：`17556e74` 之前的默认套件记录 `9cc27594`、`6324d529`；R：`9cc27594`、`6324d529`、`fb5da94` |
| 命令 | `pnpm test`（`tests/contracts/{fixtures,idempotency,boundary}.test.ts`、`tests/core/lifecycle-coordination.test.ts`、`tests/renderer/ui.test.ts`）；`HDSL_E2E_GUI=1 pnpm exec vitest run tests/e2e/desktop.gui.real.test.ts`；`HDSL_E2E_MAIN_FLOW=1 …desktop.main-flow.real.test.ts`；`HDSL_E2E_FAULTS=1 …desktop.faults.real.test.ts` |
| 结果 | D：operation sequence 递增、幂等/`IDEMPOTENCY_CONFLICT`、受控错误码 `START_TIMEOUT` + retry 渲染通过。R：`E2E-GUI-START-STOP-01` `1 passed`（46.80s）真实鼠标点击启停 + 终态；`E2E-MAIN-FLOW-01` 操作面板与两个终态标签；`E2E-FAULT-EXIT-01` 意外退出后真实 UI 收敛 `PROCESS_EXITED` 无手动刷新 |
| 分层 | D + R |
| 结论 | **通过**。**真实 UI 上的 `START_TIMEOUT`/`PORT_UNAVAILABLE` 展示已决议排除**，只按 D + 契约层验收（[#123](https://github.com/YingkeSu/HDSL/issues/123)）。 |

### FR-007 脱敏、凭据引用、上游本地产物排除

| 项 | 内容 |
| --- | --- |
| 来源 SHA | D：`7fbdc1e2`、`9cc27594`；R：`7fbdc1e2`（canary，Node `v26.8.1`）、`9927af8c`；I：`9cc27594` |
| 命令 | `pnpm test`（`tests/credentials/*`、`tests/contracts/security.test.ts`、`tests/desktop/main-diagnostics.test.ts`）；`HDSL_KEYCHAIN_CANARY=1 pnpm exec vitest run tests/credentials/keychain-canary.evidence.test.ts`；`HDSL_REAL_PROCESS=1 …real-process.evidence.test.ts`；`HDSL_E2E_DESKTOP=1 pnpm exec vitest run tests/e2e/desktop.injected.real.test.ts` |
| 结果 | D：70 项凭据单测（引用语法、退出码映射、超限闭合、显式 env 合并不继承宿主、源码级无 `console.*`/无文件写入）；诊断白名单 + canary 负向。R：真实 keychain canary `resolvedRealKeychain=true`、`injectedExplicitChildEnv=true`、`hostEnvironmentNotInherited=true`；真实受管 home 的 `.credentials.yaml` 权限 `0600`，`LaunchRecord` 序列化无 canary/`token=`。I：`E2E-QAENTRY-DIAG-01` 导出 `{exported:true,redacted:true}`，文件不含 canary/`.credentials.yaml`/`credentials.json`/dataRoot 原文；`CRED-01/02` 拒绝含 `value` 文档 |
| 分层 | D + R + I |
| 结论 | **通过**（脱敏与引用注入、上游产物排除逻辑）。**真实上游 `.credentials.yaml`（真实 Web grant 是否落盘）依赖一次性真实模型凭据，属外部/人工条件 → 未测**（见 §6）。原生菜单导入/导出未测。 |

### FR-008 失败诊断保留、重启对账

| 项 | 内容 |
| --- | --- |
| 来源 SHA | D：`ccaaeb94`、`242fea9a`；R：`9cc27594`、`fb5da94` |
| 命令 | `pnpm test`（`tests/core/creation.test.ts`、`tests/process/reconcile.test.ts`）；`pnpm exec vitest run tests/integration/install/install.integration.test.ts -t "INST-JRN-02\|INST-IDEM-02"`；`HDSL_QA_REAL_DSH=1 …two-environments.real.test.ts`；`HDSL_E2E_FAULTS=1 …desktop.faults.real.test.ts` |
| 结果 | D：journal 恢复 `rolledBack=1`、跨重启 requestId 重放不重复下载、reconcile 通过。R：`two-environments.real` 新 `ProcessManager.recover()` 对两真实进程 `adopted` 后停止；`E2E-APP-CRASH-RESTART-01` SIGKILL 真实 Electron 主进程后受管 DSH 存活，重启实例接管陈旧 lease 并按 pid 采纳同一进程（`运行中`），再经真实 UI 停止 |
| 分层 | D + R |
| 结论 | **通过**。 |

## 5. 端到端真实 UI 主流程（跨 FR 汇总）

| 证据 ID | 门 | 来源 SHA | 结果 |
| --- | --- | --- | --- |
| `E2E-MAIN-FLOW-01` | `HDSL_E2E_MAIN_FLOW=1` | `6324d529089168b13fdf2eb60617ba4dd3dfa012` | `1 passed`（50.7s）：创建→启动→停止，`createdState="stopped"`、`runningLabel="运行中"`、`stoppedLabel="已停止"`、`finalContractState="stopped"`；凭据为 setup 注入，非原生菜单 |
| `E2E-FAULT-EXIT-01`、`E2E-APP-CRASH-RESTART-01` | `HDSL_E2E_FAULTS=1` | `fb5da940be2f1f5a043ff255a950255beb78517b` | `2 passed`（119.27s）：真实 SIGKILL 收敛 `已停止`；主进程崩溃重启按 pid 采纳同一 DSH |
| 桌面/注入/测试宿主矩阵 | `HDSL_E2E_DESKTOP` / `HDSL_E2E_GUI` / `HDSL_E2E_BROWSER` / `HDSL_E2E_SENDERFRAME` | `9cc275947323b5836f3c86648d559d577fae3349` | `desktop.real` 9、`findings.real` 2、`injected.real` 3、`gui.real` 1、`quit.real` 3、`faults.real` 2、`browser.real`（注入 opener）1 全通过 |

以上均未改生产行为；每条只对其精确 SHA 成立。

## 6. 未测 / 不可冒充（必须单列）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 原生 NSOpenPanel/NSSavePanel **全自动** | **未测** | Electron `dialog` 无 automation hook；原生面板 AX 元素树无可驱动控件；`osascript` 发送按键被拒 `error 1002`（**具体 TCC 类别未经独立证实**）。`qa-entry` 注入列不互代 |
| 真实 `shell.openExternal` 系统浏览器 | **未测** | 会经过宿主默认浏览器/用户 profile；`E2E-BROWSER-01` 是**注入 opener**，不可代替。承接 [#100](https://github.com/YingkeSu/HDSL/issues/100) |
| 真实上游 `.credentials.yaml` | **未测** | 需一次性真实模型凭据；`E2E-QAENTRY-DIAG-01` 只固化生产导出排除逻辑与合成 canary |
| `START_TIMEOUT` / `PORT_UNAVAILABLE` 到真实 UI | **已决议排除出首条切片 UI 验收范围** | [#123](https://github.com/YingkeSu/HDSL/issues/123)：`--port 0` 结构不可达、就绪预算内部固定、不加测试专用 hook；只按 D + 契约层验收 |
| Windows x64 全部项 | **未测** | 见 §7 |
| Linux | **未实现、未测** | catalog 只有 `darwin/arm64`；无实机结论 |
| 真实受管 DSH 的 Linux 进程语义 | **未测** | 只有 macOS ARM64 实机证据；Ubuntu CI 只跑 typecheck/build/unit |
| 未验证平台上的目录/进程/home 隔离 | **不作为 OS 沙箱声明** | 隔离为受管目录/进程/home 边界，非 OS 沙箱 |
| DSH 认证 token 时效/撤销语义 | **未验证** | 不声称一次性或短期有效 |
| WebUI 认证后真实浏览器交互 | **未测** | T006 证据止于有界 HTTP 层 `303/401/200` 与注入 opener 应用身份 |

## 7. Windows x64 未测声明

- **未测、不声称支持**。原因（均为可核验事实）：
  - 无 Windows 主机/项目配置宿主。
  - win32 运行时适配未实现；`process/**` 使用 POSIX 进程组与 `ps`，`detached` 语义不同。
  - catalog 只有 `darwin/arm64`（[combinations.ts](../../packages/runtime/src/catalog/combinations.ts)），平台不匹配返回 `UNSUPPORTED_COMBINATION`。
  - 凭据 provider 在非 darwin 抛 `UNSUPPORTED_PLATFORM` → 映射 `UNSUPPORTED_COMBINATION`（[credentials.md](credentials.md)）。
  - `VERIFIED_LOCK_PLATFORMS = ['darwin','linux']`（[data-root-lock.ts](../../packages/core/src/data-root-lock.ts)）；win32 不在锁验证平台内。
- 决策背景见 [ADR 0007](../adr/0007-macos-acceptance-and-internal-distribution.md)：Windows x64 由维护者稍后自行测试，未测前不阻塞 macOS 阶段。
- **不得用 Linux CI 或合成夹具冒充 Windows 结论。**

## 8. 复跑命令（引用，不在本汇总执行）

D 层（默认套件）：

```sh
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py
```

R 层（opt-in，各自独立临时根；真实网络/安装/Electron；无模型调用）：

```sh
HDSL_QA_REAL_INSTALL=1      pnpm exec vitest run tests/install/real-install.evidence.test.ts
HDSL_REAL_PROCESS=1         pnpm exec vitest run tests/process/real-process.evidence.test.ts
HDSL_REAL_WEBUI_BOOTSTRAP=1 pnpm exec vitest run tests/process/real-webui-bootstrap.evidence.test.ts
HDSL_KEYCHAIN_CANARY=1      pnpm exec vitest run tests/credentials/keychain-canary.evidence.test.ts
HDSL_QA_REAL_DSH=1          pnpm exec vitest run tests/integration/process/two-environments.real.test.ts
HDSL_E2E_DESKTOP=1          pnpm exec vitest run tests/e2e/desktop.injected.real.test.ts
HDSL_E2E_GUI=1              pnpm exec vitest run tests/e2e/desktop.gui.real.test.ts
HDSL_E2E_MAIN_FLOW=1        pnpm exec vitest run tests/e2e/desktop.main-flow.real.test.ts
HDSL_E2E_FAULTS=1           pnpm exec vitest run tests/e2e/desktop.faults.real.test.ts
```

R 层结果只对实际执行的精确 SHA 有效；候选变更后必须复跑，不得引用旧结果。详见 [testing.md](testing.md)。

## 9. 轻量检查（本汇总实际执行）

```sh
python3 scripts/check_repository.py
```

结果：**PASS**（必需文件、本地链接、JSON、8 项需求/任务检查）。本汇总未改生产代码；`git diff --stat` 仅含本文件与 [docs/README.md](../README.md) 的导航入口一行。

## 10. 结论与边界

- macOS ARM64 上 FR-001..FR-008 在**注明的精确 SHA**上均有 D 层与（多数）R 层证据支撑；未测项按 §6/§7 如实保留，不用注入/合成/Ubuntu CI 冒充。
- 本文件是**历史证据的汇总**，不是当前提交的自动通过状态：任何新候选提交都需要按其自身结果重新取证。
- 未实现/未测平台（Windows x64、Linux）、原生面板全自动、真实 `shell.openExternal`、真实上游 `.credentials.yaml` 仍为人工/外部条件，保持未测。
