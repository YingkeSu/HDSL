# HDSL Agent 指引

## 项目上下文

HDSL — Hello DSH Launcher，使用 Electron、React 和 TypeScript。当前已有环境创建、受管安装、进程启停和桌面界面，尚处早期开发阶段。当前受管运行时目录仅包含 macOS ARM64 组合。

先读 README.md、CONTEXT.md 和相关 docs/adr/，再读功能 spec、plan、contracts 和 tasks。文档导航见 docs/README.md。历史验证记录不代表当前提交已通过相同检查。

## 开发规则

- 优先完成本地环境、插件与整合包闭环；后续功能遵循 docs/development/roadmap.md 的依赖。
- 遵循 CONTRIBUTING.md 的模块边界；变更接口时同步契约、消费方和测试。
- 核验上游 DSH 参数与隔离边界，记录精确版本、来源与摘要，不将目录隔离描述为 OS 沙箱。
- 凭据、环境数据、私有会话和未脱敏日志不得进入 Git、普通日志或整合包。
- 只有用户明确授权多 agent 分工时才派发，并明确基线 SHA、文件所有权、依赖、验收和停止条件。不得回退其他贡献者的改动。
- 领域知识写 CONTEXT.md，架构决策写 ADR，可重复操作写开发指南。个人工具和通用协作经验留在本地。

## 检查与完成

运行 `pnpm run typecheck`、`pnpm run build:desktop`、`pnpm test` 和 `python3 scripts/check_repository.py`。根据修改风险补充真实安装、进程或桌面验收，入口见 docs/development/testing.md。未测试的平台保持未测。

等待 CI 前确认存在可满足的检查。没有 checks 时直接报告，不反复关闭/重开 PR，不修改 Actions 设置来触发检查。所需交付物和检查完成即停止；阻塞报告具体证据。
