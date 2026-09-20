# Issue tracker

Provider: GitHub
Repository: YingkeSu/HDSL
URL: https://github.com/YingkeSu/HDSL/issues
CLI: gh（操作显式指定 --repo YingkeSu/HDSL）

Issues 是任务的状态来源；specs 中保留稳定需求、任务 ID 和详细验收。新需求默认 needs-triage。
PRs as a request surface: yes。外部 PR 纳入同一分诊标签与状态机；协作者正在开发的 PR 不作为外部需求。根据作者关联与协作背景判断，存疑先标记待评估。

读取示例：`gh issue list --repo YingkeSu/HDSL`、`gh pr list --repo YingkeSu/HDSL`。
任务需说明目标、范围、依赖、契约、验收、验证证据和完成即停条件。技能按用户授权操作，不自动向其他人发送消息。

## 去重与状态规则

- 建 issue 前先检索（`gh issue list --search`）：同一问题只保留一个承载 issue，重复描述合并，不重复开单。
- QA 复现出的缺陷先与已有 issue / PR / SHA 去重，再建 issue；不可复现的调查结论留在文档或讨论，不新开 issue。
- issue 是任务状态源；未满足验收范围不得关闭。不反复 close/reopen 来试探流程或触发检查。
- 回执与进展按 `issue + PR + SHA + 阶段 + 时间` 去重；旧 SHA 的 DONE 不得触发合并、关闭或会话回收。
- 合并由明确授权者按精确 SHA + checks + 独立 reviewer 结论执行；作者与同账号审核 comment 不构成 GitHub approval。流程见[编排 SOP](orchestration-sop.md)。
