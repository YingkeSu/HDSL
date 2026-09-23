# Implementation Plan: 受管环境创建与启动

**初始设计日期**：2026-09-20 | **Spec**：[spec.md](spec.md)

本文件保留初始设计与实施顺序，历史修订段按当时的证据状态阅读。T001–T005 和桌面实现现已合入；当前任务状态见 [tasks.md](tasks.md)，工具版本见[工具链](../../docs/development/tooling.md)。

## Summary

先证明 DSH 的安装、隔离、就绪与终止协议，再实现从 UI 到真实进程的最小闭环。不要先编造适配器参数或把 mock UI 当成完成。M1 的硬前置是已核验的上游行为与冻结的本地契约；M2 的插件/升级能力不在 M1 证明范围内。

## Technical Context

- 语言：TypeScript；Electron + React，实际版本由 workspace manifest 和锁文件固定。
- 工程：pnpm workspace，core/runtime/contracts 独立边界。
- 存储：应用数据目录中的 JSON 锁定记录、操作状态与代际目录；凭据在 OS store。
- 测试：领域单元、文件/进程集成、有限 UI E2E；Vitest 与 Electron/CDP。
- 当前平台：本机 macOS ARM64；最低版本待上游验证。Windows x64 由维护者稍后自行测试，仍是未测目标平台，不阻塞 macOS 阶段，见 [ADR 0007](../../docs/adr/0007-macos-acceptance-and-internal-distribution.md)。
- 约束：启动就绪默认上限拟定 60 秒，可配置；下载有取消与有限重试，实际阈值验证后锁定。无远程管理、无后台遥测。
- 契约：本行记录的 `API_VERSION = "1.0"` 为 001 历史实施计划（不改写）；当前 wire 版本与演进机制见 [ADR 0005](../../docs/adr/0005-plugin-contract-evolution.md) 与当前 [contracts/local-api.md](contracts/local-api.md)（`1.2`；`1.0`/`1.1` 保留为标签 `contracts-v1.0.0`/`contracts-v1.1.0` 的历史注记）。包络携带 apiVersion；DTO 见 [data-model.md](data-model.md)。
- 凭据边界：见 [ADR 0002](../../docs/adr/0002-credential-boundary.md)；受管用户凭据按 OS store 引用，上游本地凭据产物按含密数据处理。

## 工程原则检查

设计覆盖用户闭环、精确组成、窄 IPC、显式安全边界与风险测试。依据[工程原则](../../docs/architecture/principles.md)，实施前要求 T001 核验 R001–R004；现有证据见[上游研究](../../docs/research/dsh-compatibility.md)。本计划不替代当前提交的测试或平台验收记录。

## Project Structure

当前代码按以下模块组织：

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
- S1 后：T005 `packages/runtime/src/{process,reconcile,credentials}/**` ∥ T007b `tests/integration/process/**`；`reconcile/**` 统一对账“未完成创建”（T004 写 journal）与“未结束进程”。
- 再后：T006b 接真实 operation + 诊断；T008a macOS 本地可并行，T008b Windows 依赖外部主机。

并发前置：契约（[contracts/local-api.md](contracts/local-api.md) 方法/错误/DTO）冻结、测试替身与「mock 不得标为实机」边界明确（见 [testing.md](../../docs/development/testing.md)）。

## 规格修订理由（2026-09-20，实施前）

本轮只改规格、契约、领域上下文与 ADR，不开始业务工程，T001 仍是 T002 前的硬门槛：

- 凭据：上游据 PR #14 探针（固定 commit `c092f67`，未合并）会在环境 home 生成 `.credentials.yaml` 与启动诊断；据此新增 [ADR 0002](../../docs/adr/0002-credential-boundary.md)，把凭据责任拆成“受管用户 API 凭据引用注入”与“上游生成本地凭据产物排除/脱敏”两类，不承诺上游不落盘；FR-007 与 CONTEXT 不变量已同步。该上游事实**待 T001 复核转正**，复核前按待验证处理。
- WebUI：renderer 不接收携带 token 的 URL，改由 main 校验 loopback 且属于当前受管进程后原生打开。
- 契约面：补齐 RuntimeCombination / EnvironmentSummary / RuntimeArtifactRef DTO、幂等冲突、未知 ID、平台不支持、完全匹配的版本规则与每 operation sequence、订阅语义；导出幂等不重做副作用，不新增 reveal 接口。
- 前置收敛：T001 的 M1 完成条件收敛为 R001–R004；R005/R006 记录已知边界后转入 M2，M1 不证明未来 M2 功能完成。
- 验收倒挂与恢复归属：T005 不再包含导出排除（归 T006）；创建/安装期 journal 与重启对账归 T004 与 T005 的 `reconcile/**` 共同覆盖。
- 平台：Windows x64 拆为依赖外部主机的独立验收项，未实测前标记未测。
- 映射同步：roadmap 任务索引与 issue #3/#5/#8 验收已同步；`research.md` 的 R005/R006 标注属 hdsl-3，通过 AO 协调，不直接改。
- 以上为缺口修正，不代表任何前置证据已通过；T001 证据仍未合并，Windows 仍无实机数据。

## Complexity Tracking

暂不增加数据库、远程服务、插件 marketplace 或通用任务框架。需要时用 ADR 说明实际驱动问题。
