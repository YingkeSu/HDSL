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
| L11 | 任务曾把属 M2 的研究项塞进 M1 关键路径，形成假阻塞 | 派发“等待 X 直到 Y”前确认 Y 存在且可满足；研究项按里程碑归属 | https://github.com/YingkeSu/HDSL/issues/15 · https://github.com/YingkeSu/HDSL/issues/1 |
| L12 | 文件所有权重叠阻碍并发（同一目录被多个任务声明） | 每个任务所有权唯一（目录级切分）；先冻结契约再并行 | https://github.com/YingkeSu/HDSL/issues/15 |
| L13 | 证据未合并时，规范文档曾以“已存在”引用该证据 | 未合并的证据按“待复核”表述并固定引用 SHA；不以事实写死 | https://github.com/YingkeSu/HDSL/pull/16 |
| L14 | 编排出八会话上限外的经验沉淀需求（**本轮用户授权约束**，非已复现事件） | 常规并发上限八个 worker，经验沉淀允许一个额外例外会话；未来增量由编排者按新证据再唤起，不常驻空转 | 用户授权（本轮）；跟踪 https://github.com/YingkeSu/HDSL/issues/17 |
| L15 | PR #16 合并提交信息含 “does not close #1-#8”，被 GitHub closing-keyword 解析为 `close #1` 而自动关闭 issue #1，随后已 reopen | 引用 issue 只用 `Refs` / `Related` / `关联`；避免否定句把 `close`/`fix`/`resolve` 紧接 `#ID` | https://github.com/YingkeSu/HDSL/issues/15#issuecomment-5748910428 · https://github.com/YingkeSu/HDSL/issues/1 · https://github.com/YingkeSu/HDSL/pull/16 |
| L16 | 出现过把未合并 PR 描述为已合并的说法 | 所有完成 / 合并声明对照远端状态核实（`gh pr view --json state,mergeCommit`），不用本地分支或他人转述 | https://github.com/YingkeSu/HDSL/issues/15#issuecomment-5748910428 · https://github.com/YingkeSu/HDSL/pull/14 （当前 state=OPEN） |
| L17 | QA 回归用“两种终态之一”的宽松断言并依赖慢速时序，缺陷版本 `9fb42d2` 也可经 `failed + error + null` 分支误绿（reviewer 独立 5/5 绿）；后改为 `hold` 闸门后缺陷版本 5/5 红、修复版本 5/5 绿 | 回归必须确定性红 / 绿：用显式闸门（阻塞到显式 release）证明处于目标状态，断言不变量，不弱化为“二选一” | https://github.com/YingkeSu/HDSL/issues/39 · https://github.com/YingkeSu/HDSL/pull/41 |
| L18 | `recover()` 由同步改异步后，既有 QA 未 `await`，断言实际未生效；补 `await` 与 resolved 断言后，reviewer 独立去掉该 `await` 运行 `INST-RECOVER-01` 得 **RED**（`AssertionError: recover() must resolve to a report with details`） | 公开 API 异步化时，既有 QA 必须补 `await` 与 resolved 断言，并做“撤掉 `await` 即失败”的负向对照 | https://github.com/YingkeSu/HDSL/pull/49 · https://github.com/YingkeSu/HDSL/pull/49#pullrequestreview-5260469071 |
| L19 | QA 夹具 `cleanupQaRoots` 是 no-op、异常路径子进程未登记，单跑残留 14 个临时目录；断言在 kill 前失败时真实 holder 进程会泄漏 | 夹具资源须精确登记（临时根 + 子进程），只清理登记项、保留外部 sentinel，`finally` / `afterEach` 有界回收，失败显式报告（`failed` 非空即失败），运行后复测零残留 | https://github.com/YingkeSu/HDSL/pull/50 |
| L20 | `ProcessProbe.scan()` 在 `ps` 不可用时返回 `[]`，与“扫描成功但无候选”不可区分，identity-null 的 stop / close 虚假成功 | 扫描 / 枚举失败必须 fail-closed，不可证即失败；不得与真空成功混淆 | https://github.com/YingkeSu/HDSL/pull/48 · https://github.com/YingkeSu/HDSL/issues/55 |
| L21 | `leader dead` + `pgid == 历史 pid` 只说明该组号曾是自己的 detached 子进程组，不证明当前成员属于自己；restart 覆盖旧 record 会丢孤儿；identity-null 时命令 + 生成目录双匹配也不构成归属证据（#57 仍 OPEN；修复候选 PR #48 head `4acb95a`，审中未合入/未验收） | 归属必须有可证证据；不可证即失败，restart 前先解析旧记录且不得覆盖旧归属记录；结论按该固定时点状态谨慎表述，不追逐实时 head | https://github.com/YingkeSu/HDSL/issues/57 |
| L22 | runtime 同源凭据集成测试绿，但真实 core loader → credential port → manager 接线下，`DSH_AGENTS_HOME` 映射不一致、`PATH` 缺 `:` 被静默覆盖（#60 仍 OPEN） | 同源替身 / 单元测试通过不等于真实组装通过；需真实组装等值断言（子进程实际 env 与 core 映射逐键相等），受管键冲突在 spawn 前受控失败并 dispose | https://github.com/YingkeSu/HDSL/issues/60 · https://github.com/YingkeSu/HDSL/pull/48 |
| L23 | PR #14 中 rc.2 npm 完整性值被手抄成 alpha.2 的哈希；两版本长摘要跨多轮手抄仍出错 | 长摘要 / 哈希由程序生成、从最终 artifact 提取、与 registry 和实下载实物逐字符等值；长度只作辅助 | https://github.com/YingkeSu/HDSL/pull/14 |
| L24 | 工程 CI 曾把 “readiness timeout” 误判为 `PROCESS_EXITED`：身份未捕获的清理按 `commandFragment` 广播匹配，vitest 跨文件并行时另一个文件的后置清理杀掉了共享夹具路径上的子进程 | 清理目标唯一性 / 防碰撞（必要但**不充分**）：加记录唯一标识与每 harness 独立夹具副本可避免跨文件误杀，但路径 / command fragment / generation 双匹配**仍不构成归属证明**（#57 decoy 已证仍可误杀）；不得把期望改成宽松二选一 | https://github.com/YingkeSu/HDSL/pull/48 · https://github.com/YingkeSu/HDSL/issues/57 |

## 未解决与边界

- 长期监控实现由独立 worker 所有，本文不定义其实现细节，其他 worker 也不得修改它。
- 本文只沉淀已复验经验；尚未复验的推断不写入。新增经验须附公开证据链接。
- 固定时点（2026-09-20）：issue #55、#57、#60 仍 OPEN；修复候选见 PR #48 head `4acb95a`，审中尚未合入/未验收（PR #48 是候选载体，不是缺陷）。对应条目只记录可复用规则，不声称缺陷已解决；不追逐实时 head。
