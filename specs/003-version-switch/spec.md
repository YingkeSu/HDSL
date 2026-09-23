# Feature Specification: 同环境版本切换（A2 / #114）

**Feature Branch**: `ao/hdsl-59/version-switch`（首个实现 PR）
**Created**: 2026-09-23
**Status**: Tier 1（Node 轴 + 切换事务）与 Tier 2（#131：纳入第二个 DSH 版本
`0.1.7-rc.1` + 真实 macOS ARM64 跨版本回退证据）已实现。跨版本 home/session
迁移仍不在范围内。
**Input**: `YingkeSu/HDSL#114`（A2），基线 `ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa`。

## 定位

A1（#113）解决「看上游版本、把**已支持组合**装成**新环境**」；A2（本切片）解决
「把**已存在环境**的活动组成切换到另一**已支持组合**」。二者是不同的纵切：A1 产出
新环境，A2 在既有环境内换组成。

## 范围

- 在同一环境内把活动组成切换到另一**已支持组合**（换 DSH 版本和/或 Node 版本）：
  **新代受管安装 → 组成验证 → 原子切指针**；提交前失败保留旧代。
- 复用既有代际事务与 journal 做失败/取消/重启后对账。
- 记录每代的 DSH 版本 + 环境级「最近成功启动 DSH 版本」，供回退时给出数据兼容提示。

### 非目标（本切片不做）

- 不做运行中热替换磁盘运行时；不做运行期入口 load/unload（归 #116）；不承诺跨版本
  home 数据兼容；不做影响分析。
- 不把「版本切换需要停止/重启」传播为全局规则。运行期 entry enable/disable/config
  走 DSH `patchReload=live`，**无**停止前置；包依赖/bundles 变更需重启（#115，上游
  G6）是 DSH 自身约束。`stopped` 只是 `environments.switchCombination` 的**操作
  专属**前置。
- 首个 PR 不修改 renderer UI、不修改 `packages/runtime/src/catalog/**`、不新增第二个
  DSH 版本。UI 控件（#132）与「扩展支持范围」（#131）已作为后续独立子 PR 交付；
  本文件的 Tier 2 节记录 #131 的最终行为。

## 用户场景与验收

### Tier 1（当前可满足；Node 轴；确定性测试）

1. Given 环境 `stopped`、活动代 X（Node22+DSH rc.2），When 切到 Y（Node24+DSH rc.2），
   Then 新代入代、`hdsl-<Y>` profile 在切指针前发布、指针原子 → Y、`revision+1`、
   仍 `stopped`、X 目录保留、`generation.json.dshVersion` 记录。
2. Given X 活动，When 安装/验证/profile 发布在提交点前失败（注入于提交前 / 下载失败），
   Then 受控失败终态、错误脱敏，X 的指针/摘要/revision/state **不变**且**不置 `error`**，
   只删本次新 stage 代目录，X 仍可启动。
3. Given 在提交点边界暂停/崩溃，When `recover()`，Then 指针切前 → 删新 stage、指针仍 X；
   指针切后 → finalize 到 Y；同 `requestId` 重放返回原结果且不重复安装。
4. Given 已切到 Y，When `generations.restore` 回 X，Then 指针 → X、`revision+1`、home
   逐字节不动；Node 轴（同 DSH）**不**产生数据兼容提示。
5. Given 环境 `running`，When 请求切换，Then 受控 `ENVIRONMENT_BUSY`，不切指针、
   不停进程；停止是独立步骤。
6. Given 未知/未支持组合或非 macOS ARM64 组合，When 切换，Then 受控
   `NOT_FOUND`/`UNSUPPORTED_COMBINATION`，不虚报支持。
7. Given 环境无「最近成功启动 DSH 版本」记录，When 回退，Then 不产生提示（未知 ≠ 不安全）。

### Tier 2（#131 已实现）

8. 已纳入第二个 DSH 版本 `0.1.7-rc.1`（含真实安装、`dsh -V`、启动到 ready、SIGTERM
   停止证据）；跨版本回退给出非阻断数据兼容提示，同版本/升级/未知不提示。真实跨版本
   home/session 迁移不在本切片承诺内，按既有 R006 证据如实标注。证据见
   `docs/development/version-switch-validation.md` §5 与
   `docs/research/dsh-compatibility.md` R007。

## 功能需求

- **FR-A2-001**: `environments.switchCombination` MUST 只允许 `stopped` 环境；其余状态
  MUST 返回 `ENVIRONMENT_BUSY` 且不产生副作用。
- **FR-A2-002**: 切换 MUST 安装并验证新代后再原子写 `activeGenerationId`/`revision`。
- **FR-A2-003**: 提交前任何失败/取消 MUST 保留旧代的指针、摘要、revision 与 state，且
  MUST NOT 复用 create 的 `#markEnvironmentError` 语义。
- **FR-A2-004**: 切换 MUST NOT GC 旧代；回退复用 `generations.restore`。
- **FR-A2-005**: 每代 MUST 记录 DSH 版本；降级回退 MUST 给出非阻断提示，同版本与未知版本
  MUST NOT 提示。
- **FR-A2-006**: 切换 MUST NOT 改写/迁移共享 home 的 `sessions`/`storages`/凭据/用户 patch。
- **FR-A2-007**: 同一 `requestId` 重放 MUST 返回原结果；目标组合已活动 MUST 为幂等 no-op
  （不产生新代、不动 revision）。
- **FR-A2-008**: catalog MUST 只把有安装/启动证据的 DSH 版本标为已支持；`versions.dsh`
  的 `supported`/`catalogCombinationIds` MUST 从受审组合派生，dist-tag（`latest`/`next`/
  `alpha`）MUST NOT 构成支持。新增组合 MUST 自带独立闭包，且 MUST NOT 改写既有组合字节。

## 不变量

- 一个环境同时最多有一个修改事务；运行中的环境拒绝变更与恢复。
- 活动代只在准备与验证成功后切换，失败时旧代可用。
- home 为环境级共享；`$DSH_HOME/profiles/node_modules` 不参与身份。
