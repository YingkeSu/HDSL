# 多 Agent 编排 SOP

适用：HDSL 由编排者 + 多个 AO worker 会话协作时。目标是把已经发生、且有公开可复验证据的编排经验，写成简短可执行的规则。每条规则对应的真实事件与证据见[经验教训](lessons-learned.md)。

本文只约束协作流程，不替代业务规格（`specs/`）、领域上下文（`CONTEXT.md`）或 ADR。涉及凭据的边界见 `docs/adr/0002-credential-boundary.md`。

## 0. 角色

| 角色 | 职责 | 禁止 |
| --- | --- | --- |
| 编排者（orchestrator） | 分诊 issue、写任务契约、分派与回收会话、执行已授权的合并 | 不代写实现、不代替 reviewer 出结论 |
| 实现 worker | 在所有权范围内实现并自测 | 不承担任何 PR review、不自行决定合并 |
| 专职 reviewer | 针对精确 head SHA 独立复审 | 不改代码、不 claim PR、不合并 |
| QA / 探针 worker | 复现问题、去重后建 issue、产出可复验证据 | 不承担任何 PR review、不把一次通过当作长期保证 |
| 经验沉淀 worker | 把已复验经验写入 `docs/` | 不 review 代码、不修改他人所有的文件 |

角色必须完全分离：只有专职 reviewer 承担 PR review，实现（开发）与 QA / 探针 worker 不承担任何 PR review，**不限于同一 PR**；同一 PR 的作者尤其不得作为它的 reviewer。

## 1. issue 是状态源

- 任务状态以 GitHub issue 为准；spec 只保留稳定需求、任务 ID 与详细验收。
- 新需求默认 `needs-triage`；只有规格、依赖、验收都充分时才转 `ready-for-agent`，见 [triage-labels](triage-labels.md)。
- 建 issue 前先检索去重（`gh issue list --search`）：同一问题只保留一个承载 issue，重复描述合并进已有 issue。
- QA 探针复现出问题时，先按 issue / PR / SHA 去重，再建 issue；不可复现的调查结论留在文档或讨论，不新开 issue。
- 未满足验收范围不得关闭 issue；不反复 close/reopen 来试探流程或触发检查。

### 1.1 提交信息与关闭关键字

- 引用 issue 只用 `Refs #n` / `Related #n` / `关联 #n`，不要用关闭关键字表达“不关闭”。
- 避免否定句把 `close` / `fix` / `resolve` 紧接 `#ID`：写成 “does not close #1” 也会被 GitHub 解析为关闭 `#1`。
- 提交或合并后发现被误关闭，按事实说明并恢复正确状态，不让错误状态扩散。

## 2. 任务分配契约

每次派发都必须包含以下内容（模板见 [handoff-template](handoff-template.md)）：

1. 基线：分支 + commit SHA（分派时记录的目标分支精确 SHA）。
2. 目标与不在范围。
3. 文件/模块所有权（owner 唯一，避免并发冲突）。
4. 依赖与接口版本。
5. 验收：可机械判定的检查项与证据要求。
6. 停止条件：交付物完成且所需检查通过即停；无 checks 时直接报告“无检查”。

缺任何一项都不得派发。派发“等待 X 直到 Y”前，先确认 Y 存在且可满足，否则是假阻塞。

## 3. 独立审核

- 角色完全分离：只有专职 reviewer 会话承担 PR review；实现（开发）与 QA / 探针 worker 不承担任何 PR review，不限于同一 PR。作者尤其不能审核自己的 PR。
- 审核对象是精确 head SHA，不是分支名或 PR 编号；审核报告必须写明 reviewed SHA。
- reviewer 只读：不 claim PR、不改代码、不合并；确需实验时 clone 到工作区外。
- **修改后旧 approval 失效**：任何新 push 都产生新 head，必须重新审核该 SHA；旧 `APPROVED` 不得用于新 head。
- 同账号的“独立审核 comment”不是 GitHub approval。GitHub 禁止 self-approve，因此不冒充 approval，不关闭分支保护，也不改 Actions 设置来制造可合并状态。

## 4. 阶段状态与回执去重

- 每个进行中的任务维护一份阶段状态（落盘到工作区外的状态文件），字段固定为：阶段、`updatedAt`、基线 SHA、当前 head、已审 head、checks、下一步。
- 回执（DONE / 状态通知）按 `issue + PR + SHA + 阶段 + 时间` 去重；同一 SHA 的重复回执只处理一次。
- **延迟到达的旧 DONE 不得触发合并或 kill**：处理前先核对该回执的 head 是否仍是 PR 当前 head，且其 `updatedAt` 是否晚于最近一次 push。
- 不在旧 approval / 旧 DONE 上做任何不可逆动作。

## 5. 合并门禁

用户明确授权合并流程时，按顺序执行，缺一不可：

1. 精确 SHA：确认 PR 当前 head == 独立结论中的已审 head。
2. checks：对应 SHA 的所有必需 checks 通过；无 checks 则直接报告并停止。
3. 独立结论：存在该 SHA 的独立 reviewer `APPROVED` 结论。
4. 执行合并后核实 `mergeCommit`，确认它是落在目标分支上的真实提交（不是 PR head）。
5. 合并后核验 issue 完成范围：逐条比对验收，未覆盖项保留为待办（可新建跟踪 issue），再关闭已满足的 issue。
6. 回收会话：释放该 PR 对应的 worker 与 reviewer 会话；没有任务不要保留空闲 worker。

合并决策由编排者作出；合并可由编排者本人或其明确指定的执行会话，按已批准的精确 SHA 执行。作者不得自审，也不得在未收到精确 SHA 合并指令时自行决定合并；同账号 reviewer 的 comment 不能替代分支保护。

## 6. 会话生命周期

- 常规并发上限八个 worker 会话；经验沉淀（文档 / SOP）允许一个额外例外会话，不计入八。
- 会话只服务于明确任务：任务完成，或被阻塞且已上报后，立即回收，不留空转。
- 需要处理 review 反馈时，恢复原作者会话处理，而不是新开 worker 重做。
- 交付物完成且所需检查通过即停止；阻塞要给出具体证据，不无限轮询。

## 7. 质量与证据纪律

- **完成声明对照远端状态**：合并 / 完成必须以远端为准（如 `gh pr view --json state,mergeCommit`、`gh issue view --json state`）；不用本地分支、本地消息或他人转述作为完成证据。
- **只比较同版实证**：同一版本 / 提交 / 平台之间才可比较；不得把 master 与发布包、或不同版本混在一起得出结论。
- 记录证据必须区分阶段：原始发现（raw）→ 验证（verified）→ 规范调整（spec change）→ 实现（implemented）→ 实机验收（accepted）。未完成实机验收的不得写成“已支持”；缺 Windows 主机时 Windows 保持未测 / `needs-info`。
- 探针禁止事项：
  - 禁止向已回收的陈旧 PID 发信号；须维护存活 PID 集合并校验。
  - 禁止恒真断言（例如脚本自己写文件，再断言对方目录没有该文件）。
  - 禁止手写通过计数；须由脚本统计并打印 `N/M passed`，文档只引用该输出行。
  - 缺失的外部工具要前置 FATAL，不能把“无输出”当作通过。
- 任何声称的版本 / 提交 / 来源绑定都要有硬断言，不能只打印。

### 7.1 可复验断言、资源与归属

- **断言确定性**：断言必须在缺陷版本红、修复版本绿；用显式闸门（阻塞到显式 release）替代时序碰运气；不得弱化为“两种终态之一”。
- **异步化改造**：公开 API 由同步改异步后，既有 QA 必须补 `await` 与 resolved 断言（如 `details` 不含该 operation），并做“撤掉 `await` 即失败”的负向对照。
- **夹具资源**：登记每个临时根与子进程；只清理登记项（不使用宽泛 glob），保留外部 sentinel；`finally` / `afterEach` 有界回收（只对登记进程），失败显式报告（`failed` 非空即失败）；运行后复测零残留。
- **唯一归属标识**：清理 / 归属匹配要加记录唯一标识（如 generation 目录），不能只靠共享命令片段广播匹配，否则并行测试会误杀其他文件的进程。
- **不可证即失败**：扫描 / 枚举不可用与“成功但为空”必须区分；清理 / close 成功必须蕴含“无可证自有的后代存活”。
- **归属证据**：路径、command fragment、pgid 或序号都不构成归属证明；restart 前必须先解析旧记录的证据，不可证则受控失败且**不覆盖旧归属记录**，不得静默丢弃孤儿。
- **真实组装**：同源替身 / 单元测试通过不等于真实 core→port→manager 接线通过；需对真实组装做等值断言（如子进程实际 env 与 core 映射逐键相等），受管键冲突在 spawn 前受控失败并 dispose。
- **摘要生成**：长摘要 / 哈希由程序生成、从最终 artifact 提取、与 registry 和实物逐字符等值；长度只作辅助证据。

## 8. 长期巡检

- 巡检脚本先做小规模 smoke（短周期、真实发送一次通知并记录退出码），确认能产出事件后才转为长跑。
- 必须固定三项：硬期限（deadline）、错误阈值（连续失败轮数）、停止方式（明确命令 / 信号）。
- 巡检只读并通知，不自动合并、不 kill、不改设置；达到期限或阈值即自行停止。
- 长期监控的实现归其所有者 worker，其他 worker 不得修改。

## 9. 消息模板

派发（编排者 → worker）：

```text
任务：<issue #n / 标题>
基线：<branch> @ <sha>
目标 / 不在范围：<...>
所有权：<文件 / 模块>
依赖：<...>
验收：<可机械判定项 + 证据要求>
停止：交付物完成且所需检查通过即报告停止；无 checks 直接报告。
```

回执（worker → 编排者）：

```text
阶段：<待开始 / 进行中 / 等待独立复审 / 已 push / 阻塞 / 已完成>
updatedAt：<ISO8601 UTC>
issue / PR：<#n>
基线 SHA：<sha>
当前 head：<sha>
已审 head：<sha 或 none>
checks：<命令 + 结果；无 checks 写“无检查”>
下一步 / 阻塞：<...>
```

审核结论（reviewer）：

```text
reviewed SHA：<sha>
判定：APPROVED / CHANGES_REQUESTED
依据：<findings + 证据>
说明：同账号无法 GitHub approve；本结论为独立审核 comment，不冒充 approval。
```

合并前确认（编排者）：

```text
PR：<#n>  head：<sha>  已审 head：<sha>  checks：<pass / none>
独立结论：<link>
执行合并 → 核实 mergeCommit=<sha> → 核验 issue 完成范围 → 回收会话。
```

## 10. 完成即停

- 交付物完成、所需检查通过后报告并停止。
- 阻塞报告具体证据（命令、输出、SHA），不无限等待，不反复 close/reopen PR。
- 无检查（no checks）时直接报告无检查并停止。
