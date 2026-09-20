# 工具链初始化记录

日期：2026-09-20。

## Spec Kit

来源：[GitHub Spec Kit](https://github.com/github/spec-kit)，安装版本 `specify-cli==1.0.8`。本机通过 uv 安装全局 Specify CLI，仓库使用包内模板：

```bash
specify init --here --integration codex --integration-options='--skills' --script sh --non-interactive
```

初始化完成后已改写 constitution，并手工整理 001 spec、plan、tasks、research、data-model、quickstart 与本地契约。本次没有声称运行了 Spec Kit 的整条实现流程。

Codex skills 已提交到 `.agents/skills/`；`.specify/feature.json` 是每个 checkout 的当前功能指针，按官方规则不提交。新 checkout 使用 quickstart 的 `SPECIFY_FEATURE_DIRECTORY` 选择 001。

## Matt Pocock engineering skills

按用户指定的 setup-matt-pocock-skills 初始化 tracker、triage 与 domain 配置。技能引用的 seed 文件在本机技能目录缺失，因此按 SKILL.md 的字段和规则创建等价配置，不将其表述为模板原样拷贝。

后续 to-issues、triage、to-prd 使用 tracker 配置；领域建模、架构分析、诊断和 tdd 类技能读取 CONTEXT 与 ADR。配置可直接编辑 `docs/agents/*.md`；切换 tracker 时再重新执行 setup。

## 当前检查范围

Repository checks 仅检查文档结构、链接、JSON 与需求/任务 ID。应用 workspace、运行时依赖、打包和业务测试由 T002 及后续任务建立；不要把本次 CI 绿色解释为启动器通过测试。
