# 安装创建真实文件边界验证（T007a / issue #31）

状态：**夹具与用例方案已完成；真实安装执行被 T004 实现阻塞。**
本文档不声称任何安装行为已通过；`tests/integration/install/harness.test.ts`
的 9 项绿色只证明夹具本身可信，不代表启动器可用。

## 元数据

| 项 | 值 |
| --- | --- |
| 任务 | [#31 [T007a] 独立验证安装创建的真实文件边界](https://github.com/YingkeSu/HDSL/issues/31)，父任务 #7 |
| 冻结契约基线 | `3e76a49694f8dcf4c8bba5d32196a6665a2f394e`（`contracts-v1.0.0`） |
| QA 会话 / 角色 | `ao/hdsl-18/root`；QA，非 reviewer，不做任何 PR review |
| 文件所有权 | 仅 `tests/integration/install/**`、`docs/development/install-validation.md` |
| 执行平台 | macOS 26.3（Darwin 25.3.0 arm64），Node `v24.21.0`，pnpm `11.7.0` |
| 受测依赖 | T004（[#4](https://github.com/YingkeSu/HDSL/issues/4)），实现会话 hdsl-15 |
| 不在本切片 | 进程启停/就绪/凭据（T005）、UI/导出（T006）、Windows（T008b） |

## 结论（当前）

- 公开调用面已与 T004 作者（hdsl-15）书面确认，见 `tests/integration/install/support/managed-install-api.ts`。
- 夹具已完成并通过自检：真实临时目录、真实 loopback 下载端点、有效/截断/摘要错误产物、真实 HFS+ 小卷 ENOSPC、按冻结规则计算的组成摘要、宿主 HOME 快照。
- **实际创建验收未执行**：`@hdsl/core` 与 `@hdsl/runtime` 现阶段只有空入口，没有 `createManagedInstall` / `createRuntimePort` 候选 SHA。按 #31 停止条件交付夹具与方案后停止，不无限轮询；有候选再恢复运行。

## 已确认的公开调用面

```ts
// @hdsl/runtime
const runtime = createRuntimePort({
  host, fetch, faults, urlRewrites, localArtifactDirectory,
  diskFreeBytes, limits, closureInstall, precheck,
});
// @hdsl/core
const install = await createManagedInstall({
  dataRoot, catalog, runtime, host, clock, faults, limits, fixtures,
});
const api = createContractRuntime({ port: install.port }); // 只走 dispatch
```

关键语义（hdsl-15 书面确认，2026-09-20）：

- create 异步：`dispatch` 立即返回 `{ operationId }`，QA 以有限超时轮询 `operations.get` / `environments.list`；phase 顺序 `queued → downloading → extracting → installing-dependencies → preflight → committing → succeeded|failed`。
- 下载按 `catalog.artifactLocations.{node,dsh}.url` 流式校验 64 位小写 sha256；中断 → `DOWNLOAD_FAILED`，字节不符 → `DIGEST_MISMATCH`；两者终态 failed、环境 `state=error`、`activeGenerationId=null`。
- 真实安装用受管 Node 执行 `npm ci --ignore-scripts`，输入随 catalog 入库的精确 `package-lock.json`，写 `<generation>/install-manifest.json`；公开读取 `service.readInstallManifest(environmentId)`。
- manifest 字段：`schemaVersion`、`installMode: "npm-ci" | "artifacts-only"`、`node{version,sha256,executable}`、`dsh{version,sha256,entrypoint}`、`closure{lockSha256,packageCount,npmVersion}`、`preflight{checks[{name,exitCode,stdout}],passed,skipped?}`、`installedAt`。
- **artifacts-only 提交门**：默认生产 create 读到 `installMode !== "npm-ci"` 或 preflight 跳过即失败 `INTERNAL_ERROR`，不写 active 指针、`state=error`。仅显式 `fixtures:{allowArtifactsOnly:true}` + `createRuntimePort({closureInstall:false, precheck:'none'})` 允许提交，且 manifest 如实记 `artifacts-only` / `preflight.skipped=true`。T005 的 start 时再校验属纵深，不在本切片。
- `faults`：T004 侧 `{failBeforeCommit,pauseBeforeCommit}`；T005 无关。runtime 侧 `{failDownloadAfterBytes,corruptDownload,forceDiskFull,failExtraction}`。

## 用例目录

用例函数位于 `tests/integration/install/scenarios/install-scenarios.ts`，当前是**可执行就绪但未接入 vitest 的 async 函数**（不是 `*.test.ts`）。

| 用例 ID | 覆盖 | 夹具 | 故障标注 | 公开断言 |
| --- | --- | --- | --- | --- |
| QA-HARNESS-01..09 | 夹具自检 | 本地 | 无 | tar/端点/临时目录/ENOSPC/摘要 —— **已绿** |
| INST-ISO-01 | 两组成隔离、digest 绑定 | 真实产物 | 无 | 两个 env 独立、`state=stopped`、digest=冻结规则、manifest `npm-ci` |
| INST-ISO-01F | 两组成隔离（夹具路径） | 合成 tar | 无 | 同上但 manifest `artifacts-only`+`preflight.skipped` |
| INST-COMP-REAL-01 | 完整依赖安装与本切片真实 version/help 预检 | 真实产物（需网络） | 无 | manifest `npm-ci`、`closure.packageCount>0`、`preflight.passed`、各 check `exitCode=0` 且 stdout 含锁定 Node/DSH 版本 |
| INST-DIG-01 | 摘要错误终态 | 合成 tar | 篡改 catalog sha | `DIGEST_MISMATCH`、`retryable=false`、`state=error`、无 active 指针 |
| INST-DL-01 | 下载中断终态 | 合成 tar（truncate） | 注入传输截断 | `DOWNLOAD_FAILED`、环境 `error`、响应未完成 |
| INST-DISK-01 | 磁盘不足终态（注入） | 合成 tar | `forceDiskFull` **注入** | `DISK_FULL`、`state=error` |
| INST-DISK-02 | 磁盘不足终态（真实小卷） | 合成 tar + 2MB HFS+ | 真实卷 + `minFreeBytes` 阈值（真实 statfs） | `DISK_FULL`、`state=error` |
| INST-AO-GATE-01 | artifacts-only 提交门 | 合成 tar | 无（默认门） | 不得出现 artifacts-only 且完整成功/可用 active；失败则 `state=error`、无 active 指针 |
| INST-JRN-01 | journal 重启恢复 | 合成 tar | `pauseBeforeCommit` **注入** | 未提交 journal 存在 → `recover()` 后环境 `error`、无 active、journal 清空 |
| INST-IDEM-01 | requestId 跨重启重放不重复副作用 | 真实/夹具 | 无 | 返回原 operationId、下载请求数不增 |
| INST-PATH-01 | 中文+空格路径；恶意解压路径 | 合成 tar（`../`、绝对路径） | 无 | create 失败；dataRoot 之外无写入 |
| INST-HOME-01 | 宿主 HOME/`~/.dsh` 无副作用 | 合成 tar | 无 | 快照前后逐字节一致 |

所有用例都在场景内把 `HOME`、`DSH_HOME`、`XDG_*`、`TMPDIR` 重定向到临时根，并断言宿主 `~/.dsh` 与候选 app-data 路径无变化。

## FR → 用例映射（本切片）

| 需求 | 用例 |
| --- | --- |
| FR-001 独立环境 ID/名称/数据根，禁止写其他环境或默认 home | INST-ISO-01/01F、INST-HOME-01、INST-PATH-01 |
| FR-002 精确运行时版本/平台/来源/SHA-256，拒绝不支持组成 | INST-ISO-01/01F、INST-COMP-REAL-01、INST-DIG-01、INST-DL-01、INST-AO-GATE-01 |
| FR-006 operation 阶段/终态/可重试 | 全部用例的终态断言；phase 顺序为文档判据（未单独断言字符串） |
| FR-008 失败诊断保留、重启对账 | INST-JRN-01、INST-IDEM-01 |
| 边界：磁盘不足 | INST-DISK-01（注入）、INST-DISK-02（真实小卷） |
| 边界：中文/空格路径、路径穿越 | INST-PATH-01 |
| SC-001 两组成可分别启动/隔离实测 | 本切片只到 `state=stopped`+digest+manifest 绑定；真实启停归 T005/T008 |
| SC-003 失败有可查询终态、不无限等待 | 全部轮询均有有限超时 |

## 真实证据与合成夹具分栏

| 结论 | 合成夹具（synthetic tar） | 真实产物（npm-ci 闭包） |
| --- | --- | --- |
| 下载/摘要/中断/磁盘/journal/隔离/路径/HOME 边界 | **可判** | 可判（需网络与时间） |
| 受管 Node/DSH 真实 `--version` / `--help` 可运行性 | **不可判**；synthetic 的 `bin/node` 是占位脚本 | **唯一来源**：INST-COMP-REAL-01 |
| 两个 Node 组合（22.19.0 / 24.21.0）真实闭包 | 不可判 | 由 T004 作者实证后并入证据；QA 未实证前标 **未测** |

规则：不得因合成 tar 顶层解压成功或文件存在就推断真实 DSH 可运行；真实 `version`/`help` 证据只在真实闭包列记录。

## 未测 / 出切片 / 移交

- **T004 未实现**：无 `createManagedInstall` / `createRuntimePort` 候选 SHA，全部 INST-* 用例未执行。
- **真实闭包未跑**：INST-COMP-REAL-01 需要网络，本切片未执行；两个 Node 组合标未测。
- **T005**：真实启停、就绪、端口、进程树、`start` 时按 manifest 拒绝 artifacts-only 的纵深门 —— 移交，未测。
- **T006**：诊断导出与渲染侧秘密边界 —— 出切片。
- **Windows x64 / Linux**：无实机，标未测；不在本切片。
- **并发创建/锁冲突**：契约与 T004 归口，本切片未覆盖。

## 复现命令

```sh
# 夹具自检（当前唯一可执行）
pnpm install --frozen-lockfile
pnpm exec vitest run tests/integration/install/harness.test.ts

# 类型与全量单测（不得因夹具变红）
pnpm run typecheck
pnpm run test
```

T004 落地后，新增 `tests/integration/install/install.integration.test.ts` 通过
`loadCoreModule()` / `loadRuntimeModule()` 接线；接口缺失时必须**显式失败并报告**，
不得用 mock 端口替代或 `skip`/`it.fails` 变绿。

## 缺陷记录

按 #31：去重后建 issue，记录 SHA/平台/命令/期望/实际；可复用回归用正确行为断言。
当前无新缺陷（未执行真实安装）。

| ID | 摘要 | 状态 |
| --- | --- | --- |
| — | 暂无（实现未就绪） | — |

## 完成报告（本阶段）

- PR：https://github.com/YingkeSu/HDSL/pull/33（独立 QA 测试 PR，需专职 reviewer 审核；作者 hdsl-15 不可 review）
- head（夹具提交）：`c164420ff18c32e4a1c6b8771dffdf987ceb58e9`（`ao/hdsl-18/install-qa-fixtures`，基线 `3e76a49`）；PR #33 的 CI 对 PR head 运行，后续 doc-only 提交不改变夹具内容
- checks（GitHub Actions，2026-09-20）：`repository`（两次）pass；`typecheck / build / unit (ubuntu-latest)`（两次）pass；无失败 check（在夹具提交 `c164420` 上）
- 本地检查：`python3 scripts/check_repository.py` PASS；`pnpm run typecheck` PASS；`pnpm run test` 13 files / 236 tests passed（含 9 项夹具自检）
- 交付：`tests/integration/install/**`（夹具 + 9 项自检 + 场景函数）、本文件
- 阻塞：等待 #4 提供稳定接口/精确候选 SHA；到位后恢复 INST-* 运行并回报
- 局限：未执行真实安装；不声称 Windows 或 DSH 实机支持
