# 编排经验教训

记录 HDSL 已发生、且有公开可复验证据的编排经验，供后续 worker 直接引用。规则见[编排 SOP](orchestration-sop.md)。

证据要求：只引用 GitHub issue / PR / 固定 SHA 或仓库文档链接。机器临时目录（如 `/tmp`）不作为持久证据；私有系统提示、聊天全文、凭据、机器私有路径不写入本文。

## 已复现的教训

| # | 事件 / 问题 | 教训（规则） | 证据（公开） |
| --- | --- | --- | --- |
| L1 | 探针 `cleanup` 对已被 `wait` 回收的 PID 仍发 `SIGKILL`，PID 复用时会误杀无关进程 | 探针只允许向自己仍存活的子进程发信号；维护存活 PID 集合，回收后立即移除 | https://github.com/YingkeSu/HDSL/pull/14 |
| L2 | “隔离标记”断言由脚本自身写文件再断言“对方目录没有”，恒真、不构成隔离证据 | 禁止恒真断言；隔离必须由被测系统产生的可区分状态证明 | https://github.com/YingkeSu/HDSL/pull/14 |
| L3 | 文档声称“26 条断言”，脚本实际调用点与输出不可复现 | 通过计数由脚本统计并打印 `N/M passed`，文档只引用该输出行 | https://github.com/YingkeSu/HDSL/pull/14 |
| L4 | 版本 / 提交只打印不硬断言，却声称已绑定固定 commit | 声称的版本 / 来源绑定必须有硬断言，不能只打印 | https://github.com/YingkeSu/HDSL/pull/14 |
| L5 | 作者与 reviewer 同账号，GitHub 禁止 self-approve；reviewer 以 COMMENTED comment 发布独立结论而未冒充 approval | 同账号“独立审核 comment”≠ GitHub approval；不得借此绕过分支保护，也不改 Actions 设置制造可合并状态 | https://github.com/YingkeSu/HDSL/pull/14 · https://github.com/YingkeSu/HDSL/pull/16 |
| L6 | PR #16 修复后旧 head 的 `DONE` 被新 head 取代，旧结论作废 | 修改后旧 approval / 旧 DONE 失效，必须针对新 head 重新审核 | https://github.com/YingkeSu/HDSL/pull/16 |
| L7 | 延迟或重复回执可能基于已被取代的 SHA | 回执按 `issue + PR + SHA + 阶段 + 时间` 去重；旧 DONE 不触发合并、关闭或 kill | https://github.com/YingkeSu/HDSL/issues/17 |
| L8 | 合并需要区分 PR head 与真实合并提交 | 合并前核对精确 SHA + checks + 独立结论；合并后核实 `mergeCommit`，再核验 issue 完成范围并回收会话 | https://github.com/YingkeSu/HDSL/pull/16 （head `8e44afe`，`mergeCommit` `cf9af90`）· https://github.com/YingkeSu/HDSL/issues/15#issuecomment-5748910428 |
| L9 | 长期巡检脚本若不先验证，可能长跑却产不出事件 | 先 smoke（真实发送 + 记录退出码），再长跑；固定硬期限、连续失败阈值与停止方式 | https://github.com/YingkeSu/HDSL/issues/17 |
| L10 | 缺 Windows 主机时不能凭 macOS 结果声称支持 | 只比较同版实证；区分原始发现 / 验证 / 规范调整 / 实现 / 实机验收；缺主机保持未测 / `needs-info` | https://github.com/YingkeSu/HDSL/issues/8 |
| L11 | 任务曾把属 M2 的研究项塞进 M1 关键路径，形成假阻塞 | 派发“等待 X 直到 Y”前确认 Y 存在且可满足；研究项按里程碑归属 | https://github.com/YingkeSu/HDSL/issues/1 |
| L12 | 文件所有权重叠阻碍并发（同一目录被多个任务声明） | 每个任务所有权唯一（目录级切分）；先冻结契约再并行 | https://github.com/YingkeSu/HDSL/issues/15 |
| L13 | 证据未合并时，规范文档曾以“已存在”引用该证据 | 未合并的证据按“待复核”表述并固定引用 SHA；不以事实写死 | https://github.com/YingkeSu/HDSL/pull/16 |
| L14 | 编排出八会话上限外的经验沉淀需求 | 常规并发上限八个 worker，经验沉淀允许一个额外例外会话；未来增量由编排者按新证据再唤起，不常驻空转 | https://github.com/YingkeSu/HDSL/issues/17 |
| L15 | PR #16 合并提交信息含 “does not close #1-#8”，被 GitHub closing-keyword 解析为 `close #1` 而自动关闭 issue #1，随后已 reopen | 引用 issue 只用 `Refs` / `Related` / `关联`；避免否定句把 `close`/`fix`/`resolve` 紧接 `#ID` | https://github.com/YingkeSu/HDSL/issues/15#issuecomment-5748910428 · https://github.com/YingkeSu/HDSL/issues/1 · https://github.com/YingkeSu/HDSL/pull/16 |
| L16 | 出现过把未合并 PR 描述为已合并的说法 | 所有完成 / 合并声明对照远端状态核实（`gh pr view --json state,mergeCommit`），不用本地分支或他人转述 | https://github.com/YingkeSu/HDSL/issues/15#issuecomment-5748910428 · https://github.com/YingkeSu/HDSL/pull/14 （当前 state=OPEN） |

## 未解决与边界

- 长期监控实现由独立 worker 所有，本文不定义其实现细节，其他 worker 也不得修改它。
- 本文只沉淀已复验经验；尚未复验的推断不写入。新增经验须附公开证据链接。
