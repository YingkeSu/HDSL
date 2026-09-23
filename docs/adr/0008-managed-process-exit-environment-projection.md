# 0008：受管进程退出的环境状态投影（推送而非轮询）

- 日期：2026-09-23；状态：proposed（本切片按 issue #108 授权实现，合并由维护者复核）。
- 基线：`79a1535`（`origin/main`）。
- 承接：FR-005/FR-006、[001 规格](../../specs/001-environment-lifecycle/spec.md)、[本地接口契约](../../specs/001-environment-lifecycle/contracts/local-api.md)；问题登记 [issue #108](https://github.com/YingkeSu/HDSL/issues/108)。

## 背景

受管进程意外退出时，core `handleProcessExit` 已把环境置 `stopped` 并失败进行中的 start operation，`environments.list` 会在有限时间内正确反映终态。但 renderer 只在存在非终态 `trackedOperation` 时轮询 `operations.get`；意外退出不产生新的 operation 或 `operation.updated` 事件，因此 UI 标签可停留在“运行中”，直到用户手动刷新。缺口只在 renderer 观察层，core 与既有契约语义正确。

## 决策

1. 新增固定推送通道 `environment.updated`，携带与 `environments.list` 同构、无秘密与本地路径的 `EnvironmentSummary`。main 在 core 状态**确实变化**后广播给每个窗口；重复或迟到的退出不重复推送。
2. renderer 订阅该通道并按单调 `stateVersion` 合并；`environments.list` 始终是权威，事件只补推送缺口，不新增轮询。
3. 该投影只描述受管进程退出导致的环境状态变化，**不**表示插件活动组成（`ACTIVE` 代）变化，也不改写 `plugins.installed`/代际状态。
4. preload 仍只暴露固定订阅入口（新增 `onEnvironmentUpdated`），不提供任意通道发送；main 在出站前按 `environmentUpdatedEventSchema` 校验，未知环境或非法/多余字段的投影丢弃。

## 替代方案

- **renderer 有界轮询 `environments.list`**：无需契约改动，但引入无谓往返，并把观察范围从“状态变化”扩大为持续查询，与最小观察面不符。
- **复用 `operation.updated`**：意外退出没有对应 operation，语义不符；为观察而伪造 operation 会污染 operation 域与幂等账本。

## 后果

- 渲染器在受管进程退出后无需手动刷新即可收敛到“已停止”，FR-005/FR-006 在桌面观察层达成。
- 新增一个固定 IPC/preload 面；安全姿态不变：固定通道、sender 校验、出站 schema 校验、按窗口广播。
- `API_VERSION` 不变（事件不带 envelope 版本）；本文件与 `local-api.md` 的事件章节、`desktop-integration.md` 的窄 IPC 章节同步。

## 验证状态

`pnpm run typecheck`、`pnpm run build:desktop`、`pnpm test`、`python3 scripts/check_repository.py` 通过；新增 contracts/main/renderer 回归，以及一次有界真实 Electron 桥面证据（`E2E-WIN-01`）。真实 `E2E-FAULT-EXIT-01` 进程退出 lane 属 #108 登记路径，待 QA PR 合并后由该 lane 复核；本 ADR 不声称该 lane 已在本分支执行。
