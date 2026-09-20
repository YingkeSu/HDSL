# Issue tracker

Provider: GitHub
Repository: YingkeSu/HDSL
URL: https://github.com/YingkeSu/HDSL/issues
CLI: gh（操作显式指定 --repo YingkeSu/HDSL）

Issues 是任务的状态来源；specs 中保留稳定需求、任务 ID 和详细验收。新需求默认 needs-triage。
PRs as a request surface: yes。外部 PR 纳入同一分诊标签与状态机；协作者正在开发的 PR 不作为外部需求。根据作者关联与协作背景判断，存疑先标记待评估。

读取示例：`gh issue list --repo YingkeSu/HDSL`、`gh pr list --repo YingkeSu/HDSL`。
任务需说明目标、范围、依赖、契约、验收、验证证据和完成即停条件。技能按用户授权操作，不自动向其他人发送消息。
