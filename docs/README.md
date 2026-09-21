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

## 设计与规格

- [产品概览](product/overview.md)、[MVP 范围](product/mvp.md)、[产品需求](product/prd.md)。
- [领域术语与不变量](../CONTEXT.md)、[工程原则](architecture/principles.md)。
- [技术设计](architecture/tdd.md)、[架构与流程图](architecture/diagrams.md)、[ADR](adr/README.md)。
- 环境生命周期：[规格](../specs/001-environment-lifecycle/spec.md)、[实施计划](../specs/001-environment-lifecycle/plan.md)、[任务与进展](../specs/001-environment-lifecycle/tasks.md)、[数据模型](../specs/001-environment-lifecycle/data-model.md)、[接口契约](../specs/001-environment-lifecycle/contracts/local-api.md)、[手工验收流程](../specs/001-environment-lifecycle/quickstart.md)。

## 上游研究与验证记录

| 范围 | 记录 |
| --- | --- |
| DSH 来源、版本与隔离边界 | [兼容性研究](research/dsh-compatibility.md)、[行为探针](research/dsh-behavior-probes.md) |
| 安装 | [集成验收](development/install-validation.md)、[真实安装记录](development/t004-install-evidence.md) |
| 进程 | [集成验收](development/process-validation.md)、[真实启停记录](development/t005-process-evidence.md) |
| 数据目录锁 | [跨进程验证](development/dataroot-lock-validation.md) |
| WebUI 认证 | [bootstrap 验证](development/t006-webui-bootstrap-evidence.md) |
| renderer 界面交互 | [界面验证与重现](development/ui-design-a.md) |
| 桌面主流程 | [桌面验证记录](development/desktop-validation.md)、[E2E 运行说明](../tests/e2e/README.md) |

验证记录保留历史结果与未测项；其中的计数和 SHA 不是当前版本的自动更新状态。
