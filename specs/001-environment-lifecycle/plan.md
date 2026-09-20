# Implementation Plan: 受管环境创建与启动

**Branch**: `001-environment-lifecycle`（待创建） | **Date**: 2026-09-20 | **Spec**: [spec.md](spec.md)

## Summary

先证明 DSH 的安装、隔离、就绪与终止协议，再实现从 UI 到真实进程的最小闭环。不要先编造适配器参数或把 mock UI 当成完成。M1 的硬前置是已核验的上游行为与冻结的本地契约；M2 的插件/升级能力不在 M1 证明范围内。

## Technical Context

- 语言：TypeScript；候选 Electron + React，实际版本在 T002 锁定。
- 工程：拟采用 pnpm workspace，core/runtime/contracts 独立边界。
- 存储：应用数据目录中的 JSON 锁定记录、操作状态与代际目录；凭据在 OS store。
- 测试：领域单元、文件/进程集成、有限 UI E2E；候选 Vitest/Playwright。
- 平台：macOS ARM64、Windows x64 目标；最低版本待上游验证。Windows 目前无实机证据，只称目标平台。
- 约束：启动就绪默认上限拟定 60 秒，可配置；下载有取消与有限重试，实际阈值验证后锁定。无远程管理、无后台遥测。
- 契约：`API_VERSION = "1.0"`（major.minor），包络携带 apiVersion；DTO 见 [data-model.md](data-model.md)，方法见 [contracts/local-api.md](contracts/local-api.md)。

## Constitution Check

设计覆盖用户闭环、精确组成、窄 IPC、显式安全边界与风险测试。上游参数、真实平台验证尚未通过，因此本 plan 不代表已就绪的实施证明。T001 的 M1 范围（R001–R004）是 T002–T008 的硬前置。

## Project Structure

当前 spec/plan/tasks/data-model/contracts/research 已存在。代码在对应任务中创建：

```text
apps/desktop/src/main/           应用用例、WebUI 原生打开与 Electron 生命周期
apps/desktop/src/preload/        窄 IPC 白名单
apps/desktop/src/renderer/       环境列表 / 进度 / 错误
packages/contracts/src/          共享 DTO、apiVersion 与运行时输入校验
packages/core/src/               环境模型、状态、修订与存储端口
packages/runtime/src/catalog/    受审组合与兼容证据
packages/runtime/src/install/    受管产物安装、摘要与隔离
packages/runtime/src/composition/组成锁与规范化摘要
packages/runtime/src/process/    真实 DSH 启停、就绪与所有权
packages/runtime/src/reconcile/  应用重启对账
packages/runtime/src/credentials/OS 凭据引用解析与启动注入
tests/integration/install/       创建/隔离/摘要/磁盘
tests/integration/process/       启停/端口/退出/进程树
tests/e2e/                       主流程
```

## Implementation Sequence

T001 上游验证（R001–R004）→ T002 工程与依赖 → T003 契约冻结并打版本 → T004 创建/安装 → T005 启停/恢复观察（含凭据注入）→ T006 UI（含 main 原生打开 WebUI）→ T007–T008 验证。具体范围、文件所有权与停止条件见 [tasks](tasks.md)。

## 并发与所有权

T003 完成契约冻结后，可按子目录并行：

- S1 T004：`packages/core/src/**`、`packages/runtime/src/{catalog,install,composition}/**`。
- S2 T006a renderer 列表/创建/启停 UI：`apps/desktop/src/renderer/**`，对冻结契约 + stub main。
- S3 T007a 创建/隔离/摘要/磁盘集成测试：`tests/integration/install/**`。
- S1 后：T005 `packages/runtime/src/{process,reconcile,credentials}/**` ∥ T007b `tests/integration/process/**`。
- 再后：T006b 接真实 operation + 诊断；T008a macOS 本地可并行，T008b Windows 依赖外部主机。

并发前置：契约（[contracts/local-api.md](contracts/local-api.md) 方法/错误/DTO）冻结、测试替身与「mock 不得标为实机」边界明确（见 [testing.md](../../docs/development/testing.md)）。

## 规格修订理由（2026-09-20，实施前）

本轮只改规格与契约，不开始业务工程，T001 仍是 T002 前的硬门槛：

- 凭据：DSH 真实行为已在环境 home 生成 `.credentials.yaml` 与启动诊断，因此把凭据责任拆成“受管用户 API 凭据引用注入”与“上游生成短期 Web secret 排除/脱敏”两类，不承诺上游不落盘（见 [data-model.md](data-model.md)、[contracts/local-api.md](contracts/local-api.md)）。
- WebUI：renderer 不接收携带 token 的 URL，改由 main 校验 loopback 且属于当前受管进程后原生打开。
- 契约面：补齐 RuntimeCombination / EnvironmentSummary DTO、幂等冲突、未知 ID、平台不支持、版本与订阅语义。
- 前置收敛：T001 的 M1 完成条件收敛为 R001–R004；R005/R006 记录已知边界后转入 M2，M1 不证明未来 M2 功能完成。
- 平台：Windows x64 拆为依赖外部主机的独立验收项，未实测前标记未测。
- 以上为缺口修正，不代表任何前置证据已通过；T001 证据仍未合并，Windows 仍无实机数据。

## Complexity Tracking

暂不增加数据库、远程服务、插件 marketplace 或通用任务框架。需要时用 ADR 说明实际驱动问题。
