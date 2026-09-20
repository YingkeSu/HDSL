# 独立进程生命周期与所有权验收（T007b / issue #45）

状态：**准备资产阶段，候选接口未就绪，场景套件未注册（本切片不构成 T005/T007 验收）**。
父任务 #7；依赖 #5 候选接口，并与 #43（T005a dataRoot 独占）、#44（T005b 凭据）、会话 hdsl-20/hdsl-21（core 锁生命周期接口）约定可观测面。QA 只测不改生产，不做 review。

本文件与 `tests/integration/process/**` 由 issue #45 独占。夹具自检 13 项全绿只说明“夹具可信”，**不**说明进程启停/所有权/锁/凭据已通过。

## 元数据

| 项 | 值 |
| --- | --- |
| 任务 | [#45 [T007b] 独立进程生命周期与所有权验收](https://github.com/YingkeSu/HDSL/issues/45)，父任务 #7 |
| 基线 main | `7fbdc1e2607f4f695e6389296f56b3ba2600fa43` |
| QA 分支 | `ao/hdsl-23/root`（QA 场景套件尚未派生） |
| 文件所有权 | `tests/integration/process/**`、`docs/development/process-validation.md` |
| 依赖接口 | #5（`packages/runtime/src/{process,reconcile}`）、#43 T005a（dataRoot 独占）、#44 T005b（凭据）、会话 hdsl-20/hdsl-21（core 锁生命周期可观测面） |
| 执行平台 | macOS 26.3（Darwin 25.3.0 arm64），Node `v24.21.0`，pnpm `11.7.0` |
| Windows | **未测**，本切片不声明支持 |
| 不在本切片 | UI/导出（T006）、真实模型调用、API 额度消费 |

## 候选接口就绪性（准备 PR 时点）

2026-09-20 在基线 `7fbdc1e` 核查工作树与 `origin/*` ref：

- **代码层面**：`packages/runtime/src/{process,reconcile,credentials}` 仍未出现在任何已推送 ref；process 候选尚未推送分支/PR，凭据候选为 [PR #46](https://github.com/YingkeSu/HDSL/pull/46)（`ao/hdsl-22/credentials`，未合入）。
- `packages/core/src/ports.ts` 的占位 `ProcessLifecyclePort`（`start`/`stop`/`openWebUI`）仍无 runtime 实现。
- **已公布的候选可观测面（QA 注册依据，最终以合入版本为准）**：
  - **会话 hdsl-20 T005 进程**：`createProcessManager({ dataRoot, credentials, probe?, readinessTimeoutMs=60000, stopGraceMs=5000, closeConfirmMs=5000, onProcessExit?, isRecoveryPermitted? })`；端口 `start`/`stop`/`openWebUI`/`recover`/`close`。身份查询 `launchesDirectory`、`readLaunchRecord(environmentId)`、`listLaunchRecords()`；`ProcessLaunchRecord.identity = { pid, pgid, startToken, commandFragment, createdAt }`（`startToken` 为 kernel `lstart`，**非 PID 即身份**）。错误码映射用现有冻结码（`START_TIMEOUT`/`PORT_UNAVAILABLE`/`PROCESS_EXITED`/`WEBUI_UNAVAILABLE`/`ENVIRONMENT_BUSY`）。`close` 必须停并 `await` 全部 owned/adopted 运行 DSH 与安装/预检子树，成功才允许 core 释放 dataRoot 锁。#43 已同意该形状；但 `rename` 后校验/`link` 还原非 CAS，锁方案与接口待会话 hdsl-21 修订 + #5 专职设计审后冻结。**代码分支/PR 尚未推送。**
  - **PR #46（会话 hdsl-22，OPEN，head `e67e114`，2026-09-20 时点）T005b 凭据**：`packages/runtime/src/credentials/index.js` 的 `createCredentialInjection`（机制层）与 `createLaunchCredentialPort`（环境作用域 port）；成功返回 `baseEnv + 凭据` 的完整显式 env。测试必须**显式**传 `provider`/`injection`，生产 factory 不允许替身默认注入；非 darwin 的 `UNSUPPORTED_PLATFORM` **不回退 mock**。

场景注册需要上述代码在可 fetch 的 ref 上；在此之前按 issue #45 的阶段化要求，**先交付夹具与准备 PR 后停止**。禁止用 mock 冒充真实接口、禁止 `it.skip`/`it.fails` 把缺口变绿。

## 需要与 #5 / #43 / #44 及会话 hdsl-20/hdsl-21 对齐的可观测行为

以下是 **QA 的测试需求，不是另定契约**：不要求作者新增 DTO/API 字段，也不强制下列内部字段名。终态必须映射到已冻结的 [本地 API 错误码](../../specs/001-environment-lifecycle/contracts/local-api.md)（如 `START_TIMEOUT`、`PORT_UNAVAILABLE`、`PROCESS_EXITED`、`WEBUI_UNAVAILABLE`、`ENVIRONMENT_BUSY`），QA 只通过公开可观察面断言。若候选的内部 owner/identity 模型不同，用公开可观察适配层表达即可；但 **ABA 与身份判据不得降低**。

夹具与场景只依赖下列**公开、可观测**能力；字段名可在冻结时调整，但语义必须是可断言的：

1. **进程生命周期端口**（#5，core `ProcessLifecyclePort` 的 runtime 实现）
   - `start` 成功必须给出可通过公开查询读到的身份（候选：`ProcessLaunchRecord.identity`，含 `startToken`）与仅 loopback 的 `origin`；**身份不是 PID**。
   - `stop`/`close` 仅终止**自己拥有**的进程；重复 stop 幂等；`close` 成功（含子树确认退出）才允许释放锁。
   - 就绪门控：`running` 只在 loopback endpoint 可探测后出现；就绪超时为 `START_TIMEOUT`，端口冲突为 `PORT_UNAVAILABLE`，意外退出为 `PROCESS_EXITED`。
   - `recover` 暴露“未结束进程”的对账入口，可观测每条 `resolution`（如 `stopped`/`adopted`/`no-process`/`unverifiable`）。
2. **dataRoot 独占与锁生命周期**（#43 + 会话 hdsl-20/hdsl-21）
   - 可观测 owner 记录：`ownerId`、`host`、`pid`、`startTime`、`heartbeat`、`epoch`。
   - acquire/release/takeover 各自的可观测结果；release 必须带 owner/epoch 身份，旧 owner release 不得删除替代锁（ABA）。
   - `close` 在仍有安装/进程写任务时的语义（拒绝、等待或有界超时），不得在新实例并发写时释放 dataRoot。
   - **正常 close 的 M1 硬要求（编排补充）**：close 必须先停止并 `await` 所有**已证明自有**的 DSH/安装/预检子树退出，core 才释放 dataRoot 锁；旧写者退出前下一实例不得获锁。崩溃遗留由 reconcile 另测，不接受“正常 close 后靠下次 adopt 掩盖”。
   - 拒绝原因需可区分：`stale`、`foreign-host`、`pid-reused`、`corrupt`、`busy`。
   - **原子性与三方竞争（编排补充）**：`rename` 后校验/`link` 还原**不是 CAS**；A 观察陈旧→B 建新 lease→A 移动 B→C 趁隙 `wx` 可能出现两个 writer。必须由原子 `wx`+`O_EXCL` 或 fencing 关闭；**单次双进程竞争成功不构成证明**，需三方竞争 + `assertNoConcurrentWriters` 负向对照。
3. **凭据引用解析**（#44，候选 PR #46）
   - `createLaunchCredentialPort({ load, injection })` 成功 = 完整显式子进程 env（`baseEnv` + 凭据变量）；失败 `PortOutcome` 的 `message` 不含值。
   - 无引用/缺条目/取消的错误映射：无引用→`MISSING_REFERENCE`、缺条目→`CREDENTIAL_NOT_FOUND`、取消→`CREDENTIAL_ACCESS_CANCELLED`；`UNSUPPORTED_PLATFORM`→`UNSUPPORTED_COMBINATION`，其余→`INTERNAL_ERROR`。
   - 凭据值仅在启动瞬间可用；不进入环境文件、日志、错误、导出。测试用显式 test double，生产 factory 不允许默认替身。
4. **PID 安全边界**：任何 stop/清理都不得仅凭 PID 判断所有权；`processIdentity` 不匹配（PID 复用、异 host、损坏记录）时保守拒绝且不杀无关进程。

## 夹具资产（已交付，`tests/integration/process/**`）

```text
tests/integration/process/
  harness.test.ts                    # 夹具自检（13 项，真实执行，全绿）
  README.md                          # 所有权、状态与运行方式
  scenarios/
    process-scenario-plan.ts         # 23 个计划的 QA 场景目录（当前全部 blocked）
  support/
    fixture-process.mjs              # 受控父/孙进程：ready、bind、crash、stubborn、never-ready
    spawn-fixture.ts                 # FixtureProcess：ready 轮询、guarded kill、孙进程回收
    identity.ts                      # PID 身份校验：token + ps lstart；拒绝不合法的 kill
    loopback.ts                      # 真实 loopback 端口分配/占用/探测/冲突
    data-root.ts                     # 双实例共享 dataRoot + 专用 canary 凭据 + 文件 gate
    lock-fixture.ts                  # stale/foreign/pid-reuse/corrupt 锁输入制造器
    ordering-ledger.ts               # close/writer/lock 严格顺序账本与断言
    isolation.ts                     # 临时根、HOME/DSH_HOME 隔离、宿主 HOME 快照比较、有界 gate
```

夹具自检命令与结果：

```sh
pnpm exec vitest run tests/integration/process/harness.test.ts   # 13 passed
```

自检覆盖：父/孙进程身份可证且 SIGTERM 停整棵树；`crash` 模式真实遗留孤儿孙进程（launcher 必须处理的失败形态）；`stubborn` 忽略 SIGTERM、需 SIGKILL 升级；伪造 token / 陈旧 start time / 不存在的 PID 一律拒绝且无关对照进程存活；真实 loopback 200 探测与停止后端口释放；占用端口时受管进程 `exit 40` 且占用者不被杀；`never-ready` 有界超时而非挂死；双实例 canary 隔离且宿主 HOME 不变；锁输入制造器与 PID 复用拒绝；ordering ledger 对错误 close/lock/writer 顺序确定性报错；重叠 writer 被 `assertNoConcurrentWriters` 拒绝。

## 场景目录（计划，当前全部 `blocked`）

权威数据见 `scenarios/process-scenario-plan.ts`；`harness.test.ts` 只校验目录一致性，不执行场景。

| ID | 场景 | 证据 | 确定性门控 | 依赖能力 |
| --- | --- | --- | --- | --- |
| PROC-OWN-01 | 停止只作用于自有进程，无关对照存活 | real | token+lstart 身份校验 | start/stop/ownership |
| PROC-TREE-01 | 停止覆盖子/孙整棵树 | real | ready 前孙进程 record 握手 | start/stop/ownership |
| PROC-PID-01 | PID 误杀防护 | injected | 伪造 token 必须抛错且对照存活（负向对照） | ownership |
| PROC-PORT-01 | 端口冲突 `PORT_UNAVAILABLE` | real | 先真实占用端口 | start/port-conflict |
| PROC-READY-01 | loopback 就绪与停止释放端口 | real | bind ready 文件带 port | start/readiness/stop |
| PROC-TIMEOUT-01 | 就绪超时 `START_TIMEOUT` 并回收 | injected | never-ready 确定性不 ready | start/readiness/ownership |
| PROC-CANCEL-01 | 提交前 cancelled / 提交后 `CANNOT_CANCEL` | injected | 文件 gate 固定顺序 | start/reconcile |
| PROC-CRASH-01 | 崩溃 `PROCESS_EXITED` 不伪报 running | real | crash 模式 exit 事件判定 | start/reconcile |
| PROC-RESTART-01 | 重启 reconcile 接管孤儿 | real | 遗留孙进程 record 为确定性输入 | reconcile/ownership |
| PROC-LOCK-01 | 双实例共享 dataRoot 有界独占 | real | 文件 gate 固定交错 | dataRoot.lock/start |
| PROC-LOCK-02 | 崩溃后可接管且不回滚他人事务 | injected | 提交边界退出 | dataRoot.lock/reconcile |
| PROC-LOCK-03 | 双进程同时接管陈旧锁，不归档/删除新 owner | real | 文件 contentionGate 固定接管顺序 | dataRoot.lock/start |
| PROC-LOCK-04 | 旧 owner release 不得删替代锁（ABA） | real | 接管完成后再触发旧 release | dataRoot.lock |
| PROC-LOCK-05 | close 有在途写任务时不释放 dataRoot | injected | 写任务持有期间调用 close | dataRoot.lock/install/start |
| PROC-LOCK-06 | owner/heartbeat 损坏、异 host、PID 复用保守拒绝 | injected | LockFixture 制造输入 + 真实对照进程 | dataRoot.lock/ownership |
| PROC-LOCK-07 | 三方竞争（A stale→B 新 lease→A 移动 B→C 空隙 wx）不得出现两个 writer | injected | 三方 contentionGate 固定交错 + assertNoConcurrentWriters | dataRoot.lock/start/ownership |
| PROC-LOCK-08 | 旧 owner heartbeat/lease 覆写不得使新 owner 失配或复活（fencing） | injected | 新 owner 建立后写旧 heartbeat，断言被拒/无副作用 | dataRoot.lock |
| PROC-CLOSE-01 | 正常 close 先停并 await 自有子树退出再释放锁；下一实例在旧写者退出后才获锁 | real | OrderingLedger 断言 writer-exit < lock-release < next-acquire | dataRoot.lock/stop/ownership |
| PROC-CRED-01 | 凭据引用注入显式 env，值不落盘/日志 | real | 专用 canary 引用，子进程回显哈希 | credential.resolve/start |
| PROC-CRED-02 | 无引用/缺失/取消失败且不泄密 | injected | 撤销引用后启动并全量扫描 canary | credential.resolve/start |
| PROC-WEBUI-01 | openWebUI 仅当前受管 loopback endpoint | real | recorded port 是唯一合法来源 | webui.open/start |
| PROC-HOME-01 | 所有场景宿主 HOME 不变 | real | 前后逐字节快照比较 | start/stop |
| PROC-REAL-01 | 真实受管 DSH 两环境 loopback 就绪/停止 | real | 受管安装 + 专用 canary + `--no-open --port 0` | install/start/readiness/stop/credential |

## 真实 / 注入分栏

- **真实**：受控子/孙进程、真实 loopback 监听与端口冲突、真实 SIGTERM/SIGKILL 升级、真实崩溃遗留孤儿、真实双实例 canary 隔离、带 `PS lstart` 的身份校验。
- **注入**：PID 复用/陈旧 start time/损坏锁记录、never-ready、提交边界崩溃、在途写任务 close、撤销凭据引用。
- **合成夹具绝不当作真实 DSH 可运行证据**；真实 DSH 仅由 `PROC-REAL-01` 在受管安装 + 专用 canary 下验证。

## 正常 close 语义（M1 硬要求）

- 正常 `close` **不得**留下仍在写 dataRoot 的自有 DSH/安装/预检子树后就释放锁；必须先停止并 `await` 所有这些已证明自有的子树退出，core 再释放锁。
- 下一个实例必须在旧写者退出后才获锁；断言用 `OrderingLedger` 记录的真实事件顺序（`writer-exit` < `lock-release` < `next-acquire`），不靠采样/`sleep`。
- 崩溃遗留（未正常 close）由 `PROC-RESTART-01`/`PROC-LOCK-02` 的 reconcile 单独验证；**不接受**正常 close 后靠“下次 adopt”掩盖。
- 验证无关对照进程存活；停止与回收只作用于身份可证的自有进程。

## 真实 DSH 计划（候选就绪后）

- 使用受管安装产物（`createManagedInstall`）与**专用** canary 凭据引用；在独立受管 HOME/`DSH_HOME` 下启动，`--no-open --host 127.0.0.1 --port 0`。
- 仅验证自己的进程与 canary：命中的进程必须身份匹配，停止只发 SIGTERM，不调用模型、不消费 API 额度。
- 默认不执行，需显式 `HDSL_QA_REAL_DSH=1`；未设置时**不注册**而非 skip 成绿。
- Linux CI 不能代替 macOS 实机结论；Windows 未测不声明支持。

## 安全边界

- 只在 `mkdtemp` 根下运行；`HOME`/`DSH_HOME`/XDG 全量重定向到沙箱，`captureHostDefaults` 前后比较真实 `~/.dsh` 与候选 app-data 路径。
- canary 仅为 `hdsl-qa-canary-<uuid>` 的假值，不读取任何真实 OS 凭据、API key 或用户 HOME 条目。
- 每个信号先经 `verifyOwnership`（token + `ps lstart`）；身份不匹配时抛错拒绝，绝不按 PID 盲杀。清理只针对本夹具创建并记录的进程。

## 解除阻塞后如何继续

1. 与 #5/#43/#44 及会话 hdsl-20/hdsl-21 确认上节可观测接口并记录其候选 SHA。
2. 将 `process-scenario-plan.ts` 中对应场景 `status` 置 `ready`，派生 `tests/integration/process/process.integration.test.ts`，用真实公开接口驱动夹具。
3. 先跑旧候选（负向对照）证明断言可失败，再跑新候选证明修复；结果与 SHA 记入本文件。
4. 真实 DSH 组按 `PROC-REAL-01` 独立记录；不因夹具 CI 绿而关闭父任务 #7。

## 审核反馈待办（#45 执行阶段，非本批）

PR #47 独立审核（hdsl-11，对 head `3d64ac5`）提出的非阻塞改进项，记录待夹具解阻、注册真实场景时一并处理：

- **F5**：`support/identity.ts` 的 `command` 解析起点为 `tokens[5]`（实为 `lstart` 年份），非真实命令行起点；当前身份判定用 `.includes(token)` 仍正确，但若后续需前缀/精确匹配，先改用 `tokens.slice(6)` 或 `trimmed.indexOf(tokens[6])`。
- **F6a**：`FixtureProcess.cleanup()` 会返回因身份不可证而故意跳过的记录，harness 尚未断言该列表为空；注册场景时在 `finally` 后显式断言空列表（出现问题应红，不应只靠 `ps` 观察）。
- **F6b**：宿主 HOME 保护只有 `equal===true` 用例，无“能检测到写入”的负向对照；补一个临时目录级负向对照或参数化 `diffHostDefaults`。
- **F6c**：`support/isolation.ts` 的 `snapshotHome` 用 `statSync`（跟随符号链接），`isSymbolicLink()` 分支不可达；后续改用 `lstatSync` 并处理深度上限。

## 未验证声明

本切片只完成夹具与场景计划，未执行任何受管进程启停、所有权、dataRoot 锁或凭据注入验收。父任务 #7 与 #5 均未完成。
