# 显式构建授权（#78 S4）验证边界

状态：**实现于本片（core/contracts/desktop 侧）**；runtime 侧执行复核与真实受控链证据由独立 runtime 子任务提供，尚未在本集成完成时点对全部 opt-in 证据复跑。本文只固定本片的行为边界、错误映射与证据分层，不把未跑的检查写成已通过。

## 目标与默认拒执行边界

- 默认仍然 **deny**：来源需要安装期脚本且没有显式授权时，`changes.apply` 以 `BUILD_NOT_AUTHORIZED` 终态拒绝，组成、活动代际指针与修订不变。
- 授权必须绑定**精确 commit SHA** 与**精确脚本集合**（`BuildScriptEntry` 多重集完全相等，非子集、非前缀、非通配）。
- **未知集合不可授权**：`scriptAssessment === 'unknown'`（依赖闭包未完整枚举）时，即使提供了匹配的 `scripts` 也以 `BUILD_NOT_AUTHORIZED` 拒绝。不得“先执行再发现”。
- 不提供通配、按作者信任或全局开关；不写 `dangerouslyAllowAllBuilds`/`onlyBuiltDependencies` 等价全局放行，不写名字-only 的 git 依赖 `allowBuilds` 键。
- 授权是**显式、逐次**的：commit / 脚本集合 / 闭包 / 执行器任一漂移都会使旧授权失效，必须重新预览并重新确认。

## 授权 DTO（冻结 1.1，不新增符号）

```ts
BuildAuthorization = { commitSha: string(40 hex), scripts: BuildScriptEntry[] }
BuildScriptEntry   = { packageName(1..214), packageVersion(1..128), script(1..64), source: 'root' | 'dependency' }
```

- `source: 'root'`：插件源仓库自身 manifest 声明的 `preinstall`/`install`/`postinstall`/`prepare`。
- `source: 'dependency'`：作为依赖被安装的其它包（含该 git 依赖安装形态）声明的同组脚本。
- 两者是独立条目；`root` 不因被当作 git 依赖安装而改写为 `dependency`，也不互相替代。

## 错误码映射（复用冻结 D11 码，不新增）

| 条件 | 码 | 语义 |
| --- | --- | --- |
| 需要脚本、未提供授权 | `BUILD_NOT_AUTHORIZED` | 默认拒执行终态，无副作用 |
| 集合无法完整枚举（`unknown`） | `BUILD_NOT_AUTHORIZED` | 未知集合不可授权 |
| commit 不匹配或脚本集合不等 | `AUTHORIZATION_MISMATCH` | 授权未精确绑定计划；提交前拒绝 |
| 执行期观测到集合外脚本 | `UNAUTHORIZED_SCRIPT_EXECUTION` | 提交前失败；旧代不变，但**已执行代码的本机副作用不可回滚** |
| 锁定 commit 不可达 | `SOURCE_NOT_FOUND` | 复核阶段失败 |
| 执行器身份变化 | `EXECUTOR_UNAVAILABLE` | 受控失败，不隐式回退宿主 pnpm |
| 环境侧非修订输入漂移 | `PLAN_STALE` | 需重新预览 |
| `expectedRevision` 漂移 | `REVISION_CONFLICT` | 优先于计划类错误 |

## 语义分层与提交边界

- **core 守卫（提交前、无副作用）**：修订 → 计划（不存在/过期/已消费）→ 授权绑定（commit + 多重集相等，`unknown` 拒绝）→ 忙碌/未决 journal。
- **runtime 复核（任何写/执行之前）**：执行器身份 → 精确 commit 重解析 → 计划漂移比对 → 授权绑定复核；任一失败不写 `allowBuilds`、不启动安装。
- **提交点 = 活动代际指针切换**（复用 S2 事务守卫/cache/journal/ledger/recover）。提交前失败或取消：旧代不变、stage 清理、计划不消费；提交后：pointer 权威前滚，`CANNOT_CANCEL`，可显式 restore。
- **失败不提交 ≠ 副作用可回滚**：安装期脚本一旦执行，其本机副作用不在代数事务的回滚范围内。UI 与证据必须分开陈述。

## UI 口径（renderer）

- 预览展示精确 commit、完整脚本清单（含 `root`/`dependency` 来源）。
- 授权前必须勾选明确确认，文案包含“安装期将在你的机器上执行该包代码，且不受 DSH 或 HDSL 沙箱保护”。
- `unknown` 集合：只显示“无法完整枚举……不能授权”，不提供授权按钮。
- 未确认时点击安装不会发送 `buildAuthorization`；确认后发送的授权**只从该计划自身的 commit 与脚本集合派生**，UI 不能放宽。
- 不使用“一次授权永久放行”之类措辞；每次预览重置确认状态。

## 已知机制限制（受控、不绕过）

- **git 插件含 git 子依赖不受支持**：受管 pnpm 11.7.0 默认 `blockExoticSubdeps` 会在“插件本身以 git 依赖安装、且它又依赖另一个 git 包”时以 `ERR_PNPM_EXOTIC_SUBDEP` 受控拒绝。产品裁决为**保留该默认策略**，不为测试关闭或改全局设置；此类来源的预览/失败文案须说明“该来源包含受控不支持的 git 子依赖”，不得说成 S4 授权问题或静默绕过。注册表子依赖不受影响。
- **`github:` shorthand 的 allowBuilds 键未实测**：`git+` 形态已逐字节验证；`github:` shorthand 的 pinned-lock key（codeload tarball URL）是否等于 pnpm build depPath 需真实受控 GitHub fixture 实证（见 [最小发布方案](plugin-build-authorization-github-fixture-proposal.md)），不等时 fail closed（不得改用裸包名/全局放行）。

## 与其它轴的正交性

- **S3 服务核验（ADR 0005 D21）**：构建授权与 `hdsl.services.provides` 核验是**正交轴**。授权只在“是否允许执行安装期脚本”上生效，不得被当作对服务轴的可信声明，也不得把未知服务轴变为已核验/已确认。通过构建授权安装的新来源，卸载时仍按 unknown 阻塞并保留“无法验证服务依赖，暂不能卸载”的 UI 提示。
- **默认拒执行**：授权是逐次、精确、显式的例外，不是把默认值改成 allow；没有授权的路径仍恒为 `--ignore-scripts`。

## 证据分层

| 层 | 内容 | 状态 |
| --- | --- | --- |
| 契约 fixture / core 守卫 | authorize/deny/commit 漂移/集合不等/`unknown`/none-detected 夹带授权的单测；假执行器不执行任何脚本 | 本片默认 CI |
| renderer | 勾选前不发送授权、勾选后发送精确绑定、输入变化重置确认、`unknown` 不提供按钮 | 本片默认 CI |
| runtime 执行复核 | 受控 executor seam 断言两阶段流程（默认拒执行物化 → 只读枚举 → 单次精确 `allowBuilds` + `--ignore-scripts=false`）、发布前清除 `allowBuilds`、拒绝路径不执行 | 本片默认 CI（`tests/plugins/*` 与 `tests/core/change-apply-authorized.test.ts`，假执行器，不执行任何脚本） |
| opt-in 真实受控 node 链 | 复用/扩展 S2 sentinel（外部 marker）证明 deny=0 marker；精确授权下**恰好**授权集合产生 marker；漂移/子集拒绝 | 受控 fixture v2 已通过独立静态审（30 APPROVED，归档 `7f206792…`）；runtime 子任务在冻结受管 pnpm 11.7.0 上跑 `scripts/research/a4-build-authorization-probe.mjs` 16/16（deny=0 marker；离线枚举 root 4 + dep 4；allow 8 hook 实际触发；子集/漂移拒绝；仅精确 `allowBuilds`）。本整合分支未复跑该 probe |
| opt-in 真实 desktop | 本地受控 git+file:// 传输（仅测试 adapter）走完整预览→授权→apply→重启 | **未跑** |
| 生产 GitHub 全链 | 受控公开 GitHub 脚本 fixture 的真实 HTTPS 全链 | **未跑**，需先给最小发布方案与精确审查内容 |

- `executor.executedInstallScripts` 是观测报告，**不作为**默认拒执行或“仅执行授权集合”的正控证据；权威证据是受控链上的外部 marker 正控/负控。
- **`UNAUTHORIZED_SCRIPT_EXECUTION` 尚未接线**：受管 pnpm 无可靠的进程内“实际执行集合”信号，因此当前执行期保证是**构造性的**——“默认拒执行 + 仅写精确 `allowBuilds` 键”。若无法获得可靠的观测信号，不得臆造该码的触发证据；该码保留给未来可用的确定性观测。
- **`allowBuilds` 键来源**：目前取 plan 绑定 pinned lock 的 `packages`/`snapshots` key（`git+file://`/`git+` 形态已实测与 pnpm depPath 逐字节相等）；`github:` shorthand 的 lock key 是否等于 pnpm 的 build depPath **未实测**，不等时 0/多匹配会 fail closed。生产 GitHub 脚本源的 allow 需真实受控 GitHub fixture 才能闭环。
- 本地 `git+file://` 仅测试传输，**不等于**生产 GitHub 源全链；桌面证据必须分栏。
- 真实受控链与桌面链未跑完前，不得宣称“授权安装已端到端验收”。
