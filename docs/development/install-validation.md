# 安装创建真实文件边界验证（T007a / issue #31）

状态：**已在 T004 候选 `ccaaeb9` 上接入并真实执行，并已合并进 `main`（T004 mergeCommit `dbf0ef0`）**。合成边界 16 项全绿；两项真实闭包
opt-in 全绿；全仓 `pnpm run test` 329 passed / 3 skipped（含 main 的 renderer 测试）。
#37 在 `9fb42d2` 稳定复现、`ccaaeb9` 通过；#39 初版回归断言不可靠，已改修正后：`9fb42d2` 5/5 稳定红、`ccaaeb9` 5/5 绿。
本文档不把合成夹具当成真实 DSH 可运行证据。

## 元数据

| 项 | 值 |
| --- | --- |
| 任务 | [#31 [T007a] 独立验证安装创建的真实文件边界](https://github.com/YingkeSu/HDSL/issues/31)，父任务 #7 |
| 冻结契约基线 | `3e76a49694f8dcf4c8bba5d32196a6665a2f394e`（`contracts-v1.0.0`）；QA 夹具已合入 `6da541d` |
| T004 候选（复验） | `ccaaeb94a691ac943adf7a0ba471285349d1953f`（PR [#35](https://github.com/YingkeSu/HDSL/pull/35)，base `6da541d`，父 `9fb42d2`） |
| 前一候选（历史红线） | `9fb42d2fd78ea2bcb3cc4aacb629851476624175`（#37 稳定复现；#39 初版断言不可靠，见下） |
| 生产合并 | T004 PR #35 squash merge → `main` `dbf0ef00a4c090f10928ffad5a1d1ac1cdfd7033`（2026-09-20 10:51:04Z） |
| QA 分支 / 角色 | `ao/hdsl-18/t004-install-qa`；QA，非 reviewer，不做 PR review；不改生产 |
| 文件所有权 | `tests/integration/install/**`、`docs/development/install-validation.md` |
| 执行平台 | macOS 26.3（Darwin 25.3.0 arm64），Node `v24.21.0`，pnpm `11.7.0` |
| 不在本切片 | 进程启停/就绪/凭据（T005）、UI/导出（T006）、Windows（T008b） |

## 已确认并核对的公开调用面

`@hdsl/runtime`：`createRuntimePort({ host, fetch, faults, urlRewrites,
localArtifactDirectory, diskFreeBytes, limits, closureInstall, precheck,
npmRegistry, clock, commandTimeoutMs })`、`VERIFIED_COMBINATIONS`。
`@hdsl/core`：`createManagedInstall({ dataRoot, catalog, runtime, host, clock,
faults, process, exportDiagnostics, operationTimeoutMs, allowArtifactsOnly,
fixtures })`，返回 `{ port, service, recover(), waitForOperation(), close() }`；
`service.readInstallManifest(environmentId, { generationId? })` 直接返回 manifest。
类型在 `tests/integration/install/support/managed-install-api.ts` 从真实包
re-export，导出消失会编译失败而不是跳过。

真实产物布局（QA 夹具据此修正）：Node 归档为 `node-v<ver>-<os>-<arch>/bin/node`
（`stripComponents:1`）；DSH 归档为 npm 包 `package/...`（stripped 后映射到
`dsh/node_modules/@deepseek-ai/dsh/`）。

## 合成边界组结果（候选 ccaaeb9）

`pnpm exec vitest run tests/integration/install/install.integration.test.ts`
（全部真执行、无 skip）：

| 用例 | 9fb42d2 | ccaaeb9 | 说明 |
| --- | --- | --- | --- |
| INST-ISO-01F 两组成隔离（fixtures） | PASS | PASS | 两 env 独立、digest=冻结规则、manifest `artifacts-only`+`preflight.skipped` |
| INST-AO-GATE-01 artifacts-only 提交门 | PASS | PASS | 默认生产门拒绝，`state=error`、无 active 指针 |
| INST-DIG-01 摘要错误终态 | PASS | PASS | `DIGEST_MISMATCH`、`retryable=false`、`state=error` |
| INST-CAT-01 目录不一致拒绝 | PASS | PASS | 目录 ref 与来源 sha 不一致 → dispatch `INTERNAL_ERROR`，无 operation/env |
| INST-DL-01 下载中断终态 | PASS | PASS | `DOWNLOAD_FAILED`、响应未完成、`state=error` |
| INST-DISK-01 磁盘不足（注入） | PASS | PASS | `forceDiskFull` → `DISK_FULL` |
| INST-DISK-02 磁盘不足（真实小卷） | PASS | PASS | macOS 2MB HFS+ 小卷 + `minFreeBytes`（真实 statfs）→ `DISK_FULL` |
| INST-PATH-01 路径安全 | PASS | PASS | 中文+空格 dataRoot；`../`/绝对路径条目被拒，外部无写入 |
| INST-HOME-01 宿主 HOME 无副作用 | PASS | PASS | 成功安装后 `~/.dsh` 与候选 app-data 快照逐字节一致 |
| INST-JRN-01 journal 恢复（同实例暂停） | PASS | PASS | `pauseBeforeCommit` → `recover()` → `state=error`、journal 清空 |
| INST-JRN-02 journal 恢复（真实重启） | PASS | PASS | 关闭后新 service `recover()`：`rolledBack=1`、journal 清空 |
| INST-IDEM-01 requestId 重放（同实例） | PASS | PASS | 返回原 operationId、下载请求数不增 |
| INST-IDEM-02 requestId 跨重启重放 | PASS | PASS | 新 service 重放同 requestId 仍不重复下载 |
| INST-CONC-01 同组合并发（慢速交错） | **FAIL**（#37） | **PASS** | 两 create 均成功、缓存最终文件 sha256==catalog、无 `.part`、staging 清空 |
| INST-CONC-02 同组合并发（一方传输失败） | PASS | PASS | 失败方 `DOWNLOAD_FAILED`、成功方缓存摘要正确、无 `.part` |
| INST-RECOVER-01 recover 在途调用 | **不可靠（见下）** | **PASS ×5** | 修正为确定性不变量：recover 期间 operation 保持 running、journal 保留；release 后正常提交 |

`INST-DISK-02` 通过 `it.skipIf(process.platform !== 'darwin')` 平台门（Linux CI 无
非特权小卷；注入版 INST-DISK-01 在所有平台执行）。

## 真实闭包组结果（候选 ccaaeb9，`HDSL_QA_REAL_INSTALL=1`）

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| INST-ISO-01 真实两组成隔离（npm-ci） | PASS（55.7s） | 真实 `VERIFIED_COMBINATIONS` 两组合顺序安装；digest/manifest 绑定、HOME 不变 |
| INST-COMP-REAL-01 真实闭包 manifest/锁/预检 | PASS（58.1s） | `npm-ci`、`packageCount=585`、`lockSha256` 64hex、preflight 各 check `exitCode=0` 且 stdout 含锁定 Node/DSH 版本、`treeDigest` 64hex、宿主 HOME 不变 |

独立复核作者 opt-in 证据 `tests/install/real-install.evidence.test.ts`
（`HDSL_REAL_INSTALL=1`，QA **自己的临时 dataRoot**，未覆盖作者保留数据）：PASS，
两组合 `npm-ci`、`packageCount=585`、preflight `node v22.19.0/v24.21.0` +
`dsh 0.1.5-rc.2` + `--help` 全 `exit 0`、`treeDigest` 一致、宿主 `~/.dsh` 不变
（在 9fb42d2 执行；作者在 ccaaeb9 重跑自报，QA 自身场景在 ccaaeb9 通过）。

## 缺陷复验（精确 SHA，不关闭）

| ID | 摘要 | 9fb42d2 | ccaaeb9 |
| --- | --- | --- | --- |
| [#37](https://github.com/YingkeSu/HDSL/issues/37) | 同组合并发 create 共享 `<sha256>.part`，rename 时序污染缓存 | 独立复现（INST-CONC-01 红：一个 create `INTERNAL_ERROR`） | **通过** INST-CONC-01；断言未弱化，无 `.part`、缓存摘要正确 |
| [#39](https://github.com/YingkeSu/HDSL/issues/39) | `recover()` 在安装途中回滚活跃事务造成分裂状态 | 修正后回归 **5/5 稳定红** | **5/5 稳定绿** INST-RECOVER-01 |

**#39 回归修正（reviewer 反馈）**：初版 INST-RECOVER-01 用「两种终态之一」的宽松断言，
并靠 `slow` 传输时序，在 `9fb42d2` 上可经 `failed + error + null` 分支误绿，未真正证明 #39。
现改为确定性不变量：端点以 `hold` 模式阻塞 Node 下载直到测试显式 `release`，证明安装确实在途；
断言 `recover()` 前后 operation 仍为 `running`、durable journal 仍存在、`recover().details`
不含该 operation；release 后必须正常提交（`succeeded` + `stopped` + active generation，journal 清除）。
命令：`pnpm exec vitest run tests/integration/install/install.integration.test.ts -t "INST-RECOVER-01"`。
结果：`9fb42d2` 独立 worktree ×5 全红（`recover() must not terminalize an operation still held by an active controller`）；
`ccaaeb9`（经 main 合并）本机 ×5 全绿。旧版「#39 已稳定复现」的表述作废。

按编排要求不关闭 issue；合并前 #37/#39 保持 OPEN。

## 故障标注（真实 / 注入分栏）

- **真实**：`INST-DISK-02`（挂载 2MB HFS+ 小卷 + 真实 `statfs` 阈值）；`INST-ISO-01`、`INST-COMP-REAL-01` 与作者证据（真实 Node/DSH 产物 + 真实 `npm ci` + 受管 Node 预检）。
- **注入**：`INST-DISK-01`（`forceDiskFull`）；`INST-DL-01`/`INST-CONC-02`（端点截断传输）；`INST-JRN-01/02`（`pauseBeforeCommit` 崩溃边界）；`INST-RECOVER-01`（端点 `hold` 阻塞传输以确定性制造在途窗口）。
- **合成夹具**：`tests/integration/install/support/artifacts.ts` 的 tar。只证明下载/摘要/journal/隔离/路径/HOME 边界，**不推断真实 DSH 可运行**。

## FR → 用例映射（本切片）

| 需求 | 用例 |
| --- | --- |
| FR-001 独立环境 ID/名称/数据根，禁止写其他环境或默认 home | INST-ISO-01F/ISO-01、INST-HOME-01、INST-PATH-01 |
| FR-002 精确运行时版本/平台/来源/SHA-256，拒绝不支持组成 | INST-ISO-01F/ISO-01、INST-COMP-REAL-01、INST-DIG-01、INST-CAT-01、INST-DL-01、INST-AO-GATE-01 |
| FR-006 operation 阶段/终态/可重试 | 全部用例终态断言；phase 顺序为文档判据 |
| FR-008 失败诊断保留、重启对账 | INST-JRN-01、INST-JRN-02、INST-IDEM-01/02、INST-RECOVER-01 |
| 边界：磁盘不足 | INST-DISK-01（注入）、INST-DISK-02（真实小卷） |
| 边界：中文/空格路径、路径穿越 | INST-PATH-01 |
| SC-001 两组成可分别启动/隔离实测 | 本切片到 `state=stopped`+digest+manifest 绑定；真实启停归 T005/T008 |
| SC-003 失败有可查询终态、不无限等待 | 全部轮询有限超时 |

## 原 P3 清单处置

| 项 | 处置 |
| --- | --- |
| P3-1 `TMPDIR` 未建目录 | 已修：`withIsolatedEnv` 预先 `mkdir` sandbox home/dsh-home/tmp |
| P3-2 `diffHostDefaults` 漏报差异 | 已修：完整返回 snapshot 级 added/removed/changed |
| P3-3 隔离用例注释与 fixture 分支矛盾 | 已修：注释明确 fixtures/real 两种模式 |
| P3-4 `writeUntilEnospc` 上限过大 | 已修：默认上限降到 8MB 并注明仅用于挂载小卷 |
| P3-5 `host` 硬编码 | 已修：`HarnessOptions.host`/`openInstall.host` 可覆盖，默认唯一已核验主机 |
| P3-6 文档 head 记录 | 本文件已更新 |

## skip 说明

仅两处条件执行，均为真实条件而非掩盖缺陷：

1. `INST-DISK-02`：`it.skipIf(process.platform !== 'darwin')`——真实小卷需 macOS `hdiutil`；注入版在所有平台执行。
2. `install real closure (opt-in, network)` 组：`describe.skipIf(HDSL_QA_REAL_INSTALL !== '1')`——真实下载 + `npm ci`（网络、~1GB、数分钟），不适合默认单测；已在 macOS ARM64 显式执行，结果见上。默认 `pnpm run test` 中该组显示为 skipped，属预期。

## 未测 / 出切片 / 移交

- **T005**：真实启停、就绪、端口、进程树、start 时按 manifest 拒绝 artifacts-only 的纵深门；跨进程 dataRoot 锁 / recover 隔离、安装期 npm 进程树（编排已派 #5）——移交，未测。
- **T006**：诊断导出与渲染侧秘密边界、组合根门（编排已派 #6）——出切片。
- **Windows x64 / Linux**：无实机，标未测；真实闭包仅在 macOS ARM64 执行。
- 两个 Node 组合真实闭包：QA 两个真实场景在 ccaaeb9 通过；仍以作者实证为准。
- 未覆盖多进程产品行为（本批不扩）。

## 复现命令

```sh
pnpm install --frozen-lockfile
pnpm run typecheck

# 合成边界组（默认；16 项全绿）
pnpm exec vitest run tests/integration/install/install.integration.test.ts

# 真实闭包组（opt-in，网络 + npm ci）
HDSL_QA_REAL_INSTALL=1 pnpm exec vitest run tests/integration/install/install.integration.test.ts -t "install real closure"

# 夹具自检
pnpm exec vitest run tests/integration/install/harness.test.ts

# 作者 opt-in 真实证据（独立临时 dataRoot）
HDSL_REAL_INSTALL=1 pnpm exec vitest run tests/install/real-install.evidence.test.ts --reporter=verbose
```

## 完成报告

- 生产 base：`main`（含 T004 mergeCommit `dbf0ef00a4c090f10928ffad5a1d1ac1cdfd7033`）
- QA 分支：`ao/hdsl-18/t004-install-qa`（已常规 merge `origin/main`，无冲突；相对 main 仅 `tests/integration/install/**` + 本文件）
- 注册场景：合成边界 16（含平台门 1）+ 真实闭包 2 = 18；另 9 项夹具自检（`harness.test.ts`）
- 结果：合成 16 PASS、真实 2 PASS（在 `ccaaeb9` 完成）；本机 `pnpm run test` 329 passed / 3 skipped
- 缺陷：#37 在 `ccaaeb9` 复验通过；#39 修正后确定性 INST-RECOVER-01 在 `ccaaeb9` 5/5 通过（`9fb42d2` 5/5 稳定红）；均不关闭 issue
- 局限：未执行真实启停/就绪/凭据；不声称 Windows 或真实 DSH 可运行（仅真实闭包用例与作者证据支持该结论）；不重复无变化真实网络安装
