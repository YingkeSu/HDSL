# HDSL Agent 指引

## 项目与阅读顺序

HDSL — Hello DSH Launcher。当前是开发基线，启动器尚未实现。
先读 README.md、CONTEXT.md 和相关 docs/adr/，再读本次功能的 spec、plan、contracts 和 tasks。区分用户需求、设计决策、待验证假设与实际执行证据，不继承历史对话中未复验的测试结论。

## 开发规则

- 优先完成本地环境、插件与整合包闭环；论坛和微信小程序遵循路线图的前置门槛。
- 上游 DSH 参数与隔离边界先核验；不得把目录隔离描述为 OS 沙箱。
- 变更接口时同步契约和消费方；精确记录版本、来源与摘要，凭据不得进入 Git、普通日志和整合包。
- 只有明确授权多 agent 分工时才派发；为每个任务写清基线 SHA、目标、文件/模块所有权、依赖、验收与停止条件。
- 你不是唯一贡献者，不得回退其他人的改动。交接使用 docs/agents/handoff-template.md；领域知识写 CONTEXT，架构决策写 ADR，可重复操作写开发文档。

## 检查与完成条件

当前运行 `python3 scripts/check_repository.py` 检查仓库结构；有业务实现后再执行相应类型、构建、集成与实机验收。风险驱动测试，不机械追求所有代码 100% 覆盖率。
派发“等待 X 直到 Y”前先确认 Y 存在且可满足。查看 PR checks 或仓库 workflows；无 checks 则报告无检查并停止，不反复 close/reopen PR，不修改 Actions 设置试图触发检查。所需交付物和检查完成即停止；阻塞报告具体证据，不无限轮询。
长期监控脚本先小规模验证能产出事件。macOS 的 BSD sed 不支持 PCRE 惰性量词，复杂正则使用 awk 或 Python。

## 非交互 SSH 的 PATH

`ssh host 'cmd'` 在 zsh 下只加载 `~/.zshenv`，不要因为 PATH 缺失就判定工具未安装。先检查 `/opt/homebrew/bin/`，临时在远程命令前加入 `export PATH=/opt/homebrew/bin:$PATH`。确需永久修复时幂等地在远程 `.zshenv` 加载 Homebrew shellenv；完成后以 `ssh host 'command -v node'` 返回完整路径验证。

## Agent skills
### Issue tracker

GitHub Issues：YingkeSu/HDSL；外部 PR 也进入需求分诊，协作者开发中的 PR 除外。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个同名标准标签。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根 CONTEXT.md + docs/adr/。See `docs/agents/domain.md`.
