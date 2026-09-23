# HDSL 文档

从源码启动请先读[项目 README](../README.md)，参与开发请读[贡献指南](../CONTRIBUTING.md)。产品文档描述目标范围；验证记录只对各自注明的版本、平台与测试条件有效。

## 开发指南

| 主题 | 文档 |
| --- | --- |
| 工具安装与构建 | [工具链](development/tooling.md) |
| 桌面入口、数据目录与凭据导入 | [桌面集成](development/desktop-integration.md) |
| 测试命令与覆盖范围 | [测试指南](development/testing.md) |
| 凭据适配与引用存储 | [运行时凭据](development/credentials.md)、[core loader](development/core-credential-loader.md) |
| 数据目录锁与生命周期 | [所有权协调](development/dataroot-ownership.md) |
| 当前进展与后续工作 | [路线图](development/roadmap.md) |
| 本机验收与内测准备 | [macOS 内测准备](development/macos-internal-readiness.md) |

## 设计与规格

- [产品概览](product/overview.md)、[MVP 范围](product/mvp.md)、[产品需求](product/prd.md)。
- [领域术语与不变量](../CONTEXT.md)、[工程原则](architecture/principles.md)。
- [技术设计](architecture/tdd.md)、[架构与流程图](architecture/diagrams.md)、[ADR](adr/README.md)。
- 环境生命周期：[规格](../specs/001-environment-lifecycle/spec.md)、[实施计划](../specs/001-environment-lifecycle/plan.md)、[任务与进展](../specs/001-environment-lifecycle/tasks.md)、[数据模型](../specs/001-environment-lifecycle/data-model.md)、[接口契约](../specs/001-environment-lifecycle/contracts/local-api.md)、[手工验收流程](../specs/001-environment-lifecycle/quickstart.md)。
- 插件事务与发现（002，S1 已实现）：[规格](../specs/002-plugin-transactions/spec.md)、[S1 实现计划](development/plugin-discovery-plan.md)、[S2 home/事务设计](../specs/002-plugin-transactions/s2-home-and-transaction-design.md)；运行期 entry（E1 #116）：[规格](../specs/002-plugin-transactions/e1-runtime-entry/spec.md)、[契约](../specs/002-plugin-transactions/e1-runtime-entry/contracts.md)、[计划](../specs/002-plugin-transactions/e1-runtime-entry/plan.md)、[任务](../specs/002-plugin-transactions/e1-runtime-entry/tasks.md)；契约演进见 [ADR 0005](adr/0005-plugin-contract-evolution.md)、home 派生决策见 [ADR 0006](adr/0006-generation-home-derivation.md)；只读期望组成查看（E2 #118）：[规格](../specs/002-plugin-transactions/e2-expected-composition/spec.md)、[契约](../specs/002-plugin-transactions/e2-expected-composition/contracts.md)、[计划](../specs/002-plugin-transactions/e2-expected-composition/plan.md)、[任务](../specs/002-plugin-transactions/e2-expected-composition/tasks.md)。
- 同环境版本切换（003 A2 / #114，Tier 1 已实现）：[规格](../specs/003-version-switch/spec.md)、[计划](../specs/003-version-switch/plan.md)、[契约](../specs/003-version-switch/contracts.md)、[任务](../specs/003-version-switch/tasks.md)。

## 上游研究与验证记录

| 范围 | 记录 |
| --- | --- |
| DSH 来源、版本与隔离边界 | [兼容性研究](research/dsh-compatibility.md)、[行为探针](research/dsh-behavior-probes.md) |
| 运行期 entry 确认/ACK 与会话面（E1b #116） | [no-go 调查](research/e1b-runtime-confirmation-investigation.md)（静态接口 + 隔离实测；原子写修正“预热窗口”归因） |
| 安装 | [集成验收](development/install-validation.md)、[真实安装记录](development/t004-install-evidence.md) |
| 进程 | [集成验收](development/process-validation.md)、[真实启停记录](development/t005-process-evidence.md) |
| 数据目录锁 | [跨进程验证](development/dataroot-lock-validation.md) |
| WebUI 认证 | [bootstrap 验证](development/t006-webui-bootstrap-evidence.md) |
| renderer 界面交互 | [界面验证与重现](development/ui-design-a.md) |
| 桌面主流程 | [桌面验证记录](development/desktop-validation.md)、[E2E 运行说明](../tests/e2e/README.md) |
| macOS ARM64 实机验收汇总（T008a #137） | [验收证据汇总](development/validation-001.md)（FR-001..FR-008 逐项来源 SHA/命令/分层/未测边界） |
| 插件发现与详情（S1） | [验证记录](development/plugin-discovery-validation.md)（含 opt-in 真实 GitHub 只读探针） |
| 插件代际 home 派生与回滚（#76 前置） | [实证记录](development/plugin-home-derivation-validation.md)（合成运行时 + 真实事务/恢复代码） |
| 插件 profile 接线（#76 A2） | [验证记录](development/plugin-a2-profile-validation.md)（适配器/进程夹具 + opt-in 真实 npm-ci 全链） |
| 受管 pnpm 默认拒执行哨兵（#76 E1） | [验证记录](development/plugin-executor-sentinel-validation.md)（冻结 pnpm 链 + 外部 marker） |
| 插件卸载、内置保护与合法保留（#77 S3） | [验证记录](development/plugin-remove-validation.md)、[服务核验边界](development/plugin-remove-service-verification.md) |
| 显式构建授权（#78 S4） | [验证边界与证据分层](development/plugin-build-authorization-validation.md)、[GitHub fixture 发布/实测记录](development/plugin-build-authorization-github-fixture-publication.md) |
| 运行期 entry（E1 #116） | [desired-config 边界 + 合法非空数组移除实验](development/plugin-runtime-entry-validation.md)（opt-in、隔离、同 PID 卸载） |
| 插件 pnpm transport 规格（#141） | [固定 commit 的官方 codeload tarball](development/plugin-transport-spec.md)（transport ≠ 来源；旧 plan `PLAN_STALE`） |
| 期望组成查看（E2 #118） | [只读 `--dump-config` 解析验证记录](development/expected-composition-validation.md)（opt-in 真实受管 dump；期望 ≠ 运行期 ACTIVE） |
| 同环境版本切换（A2 #114） | [测试与边界](development/version-switch-validation.md)（确定性事务/回滚/恢复证据；真实 opt-in 未测） |

验证记录保留历史结果与未测项；其中的计数和 SHA 不是当前版本的自动更新状态。
