# 贡献与开发流程

1. 阅读 README、CONTEXT、相关 ADR 及功能 spec。
2. 在任务中明确用户结果、依赖、验收和拥有的文件/模块。以 `main` 为基线创建独立分支。
3. 功能按 Spec Kit 的 specify → plan → tasks → implement → converge 推进；已有资料直接迭代，不重建重复规格。
4. 接口变化先同步契约与消费方；高风险状态机先写失败场景测试。
5. 提交前运行 `python3 scripts/check_repository.py`，有业务代码后运行该模块适当的类型、测试与构建检查。
6. PR 描述说明用户行为变化、证据与未验证平台。任务完成状态以实际检查为准。

当前初始化不代表业务实现就绪。开发任务见 [路线图](docs/development/roadmap.md)，首个功能见 [tasks](specs/001-environment-lifecycle/tasks.md)。

多 agent 只有明确分工时才启用；交接使用 [模板](docs/agents/handoff-template.md)，记录 base SHA、文件所有权、接口、测试与停止条件。没有 CI checks 时直接报告无检查，禁止为触发 CI 而反复关闭/重开 PR 或修改 Actions 设置。
