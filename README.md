# HDSL — Hello DSH Launcher

让 DSH 工作环境能够被明确描述、检查、分享、重建，并在升级失败后恢复。

HDSL 面向 DeepSeek Harness（DSH），借鉴 PCL 的简洁操作层次和 HMCL 的实例管理思路，聚焦版本与环境隔离、插件管理、整合包。项目与这些上游项目没有官方隶属关系。

**当前状态：仓库与开发基线已初始化，启动器尚未实现。** 此仓库没有可运行桌面端或可安装发布包。原始 ChatGPT 交付附件尚未取得，现有文档是根据可读取对话重新整理的基线，详见[来源与边界](docs/research/provenance.md)。

## 从这里开始

| 文档 | 用途 |
| --- | --- |
| [概览](docs/product/overview.md) | 高年级本科生入门，理解核心概念 |
| [MVP](docs/product/mvp.md) | 首版范围与验收门槛 |
| [PRD](docs/product/prd.md) | 用户、需求、优先级与指标 |
| [SPEC](specs/001-environment-lifecycle/spec.md) | 首条纵向切片的行为规范 |
| [TDD / 技术设计](docs/architecture/tdd.md) | 模块边界、事务、隔离和选型 |
| [接口](specs/001-environment-lifecycle/contracts/local-api.md) | 版本化本地接口草案 |
| [架构与流程图](docs/architecture/diagrams.md) | Mermaid 可编辑图 |
| [开发路线图](docs/development/roadmap.md) | 依赖、阶段门槛、待办 |
| [测试策略](docs/development/testing.md) | 风险覆盖、跨平台验收 |
| [贡献指南](CONTRIBUTING.md) | 开始一次开发 |

## 开发入口

目前仓库校验仅依赖 Python 3 标准库：

```bash
python3 scripts/check_repository.py
```

已通过官方 Specify CLI 1.0.8 安装 Codex 集成，项目 skills 位于 `.agents/skills/`，模板和脚本位于 `.specify/`。其他开发者可安装：

```bash
uv tool install specify-cli==1.0.8
specify check
```

在 Codex 项目会话中使用 `$speckit-specify`、`$speckit-plan`、`$speckit-tasks`、`$speckit-analyze`、`$speckit-implement`、`$speckit-converge`。这些是 agent skill 调用，不是 shell 命令。已有 [001 规格](specs/001-environment-lifecycle/spec.md)，先解决 research 中的上游验证项，再实施。不要把初始化命令当作日常更新命令覆盖现有配置。

## 规划结构

当前只创建有实际内容的目录；应用代码在相应任务中加入。

```text
.agents/skills/    Codex Spec Kit 工作流
.specify/         项目原则、官方模板、脚本
specs/001-*/      首个功能的 spec / plan / tasks / contracts
docs/            产品、架构、研究、协作与 ADR
scripts/          仓库完整性检查
.github/          Issue / PR 模板和 CI
```

拟采用 Electron + React + TypeScript，受管 Node/DSH 运行时独立于 Electron。候选代码布局见 [实施计划](specs/001-environment-lifecycle/plan.md)。论坛、Registry 和微信小程序在本地闭环验证后进入建设。

## 来源与许可

仅借鉴设计模式，未导入 PCL、HMCL 或 DSH 实现源码。HDSL 自有内容的开源许可证待维护者确定，当前不声称已授予开源许可。随 Spec Kit 分发的内容保留 [MIT 许可](.specify/LICENSE)，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
