# 显式构建授权（#78 S4）验证边界

状态：**实现于本片（core/contracts/desktop + 已整合 runtime）**；runtime 侧执行复核与真实受控链证据由独立 runtime 子任务提供。本文固定本片的行为边界、错误映射与证据分层；未跑的检查不写成已通过。

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

## 临时授权的清理边界（精确）

- HDSL 的**授权配置载体**是单次安装期间写入的 workspace `allowBuilds`，在安装后立即清除；发布出的代际 **workspace 配置（`pnpm-workspace.yaml`/`package.json`）无 `allowBuilds`/`onlyBuiltDependencies`**（默认 CI 测试 + 真实 desktop 已核）。
- 但已发布代际的 `profile/node_modules/.modules.yaml` 可能保留 pnpm 自身的**安装态** `allowBuilds`（本次真实 desktop 观察到一个精确键）。这是 pnpm 的 node_modules 安装记录，不是 HDSL 的授权配置载体；每个新代际的 profile 由 plan 绑定的 targetProfile 全新物化，不继承上一代的 `node_modules`。它是否在后续全新安装中构成实际放行门**未经独立 probe**；本次按“如实记录”处理，不声称“磁盘上无任何 `allowBuilds` 字节”。

## UI 口径（renderer）

- 预览展示精确 commit、已枚举脚本清单（含 `root`/`dependency` 来源；依据计划锁定的依赖闭包，未能完整核对时为 `unknown`，不提供授权）。
- 授权前必须勾选明确确认，文案包含“安装期将在你的机器上执行该包代码，且不受 DSH 或 HDSL 沙箱保护”。
- `unknown` 集合：只显示“无法完整枚举……不能授权”，不提供授权按钮。
- 未确认时点击安装不会发送 `buildAuthorization`；确认后发送的授权**只从该计划自身的 commit 与脚本集合派生**，UI 不能放宽。
- 不使用“一次授权永久放行”之类措辞；每次预览重置确认状态。

## 已知机制限制（受控、不绕过）

- **git 插件含 git 子依赖不受支持**：受管 pnpm 11.7.0 默认 `blockExoticSubdeps` 会在“插件本身以 git 依赖安装、且它又依赖另一个 git 包”时以 `ERR_PNPM_EXOTIC_SUBDEP` 受控拒绝（受控实测原文：`Exotic dependency "<pkg>" (resolved via git-repository) is not allowed in subdependencies when blockExoticSubdeps is enabled`）。产品裁决为**保留该默认策略**，不为测试关闭或改全局设置；此类来源的预览/失败文案须说明“该来源包含受控不支持的 git 子依赖”，不得说成 S4 授权问题或静默绕过。注册表子依赖不受影响。
- **预览侧闭包枚举（以 pinned lock 可达身份为权威）**：生产预览端口在解析 target lock 后，以受管 executor 运行 `install --frozen-lockfile --ignore-scripts`（默认拒执行）物化到隔离 staging；再以 `resolveLockClosure(lockText).reachable` 的**可达精确身份**为权威集合，从顶层链接与 `.pnpm` 虚拟存储（按 realpath 去重）读取每个可达包的 manifest，逐 `(name, version)` **严格计数相等**；源包自身按 `root` 排除。任一可达包缺失/多余/不可解析、同 `(name,version)` 对应两个不同 depPath、符号链接逃逸或超界 ⇒ 保持 `unknown`（不可授权）。staging 清理、不写 `allowBuilds`、不执行任何脚本。“扫完目录”不等于完整枚举。
- **依赖条目陈述边界**：`BuildScriptEntry` 只带 `(packageName, packageVersion, script, source)`，不含 commit/tarball key。对同版本不同 commit/peer 的依赖，清单陈述弱于 `root`（root 绑定 commit）；安全由 frozen-lockfile 完整性 + 严格计数 + 绑定歧义拒绝兜住，不放行。
- **可达但未物料化**：`resolveLockClosure` 会跟随 optional/peer 边，平台不适用的可选包可能“可达但未物料化” ⇒ 计数不符 ⇒ `unknown`（多拒，fail-closed），属能力限制而非放行。
- **`github:` shorthand 的 `allowBuilds` 键已实测**：在冻结受管 pnpm 11.7.0 上，pinned-lock key（codeload tarball URL）与 pnpm 要求的 build depPath **逐字节相等**；exact key 见 [发布/实测记录](plugin-build-authorization-github-fixture-publication.md)。不等时应 fail closed（不得改用裸包名/全局放行）。

## 与其它轴的正交性

- **S3 服务核验（ADR 0005 D21）**：构建授权与 `hdsl.services.provides` 核验是**正交轴**。授权只在“是否允许执行安装期脚本”上生效，不得被当作对服务轴的可信声明，也不得把未知服务轴变为已核验/已确认。通过构建授权安装的新来源，卸载时仍按 unknown 阻塞并保留“无法验证服务依赖，暂不能卸载”的 UI 提示。
- **默认拒执行**：授权是逐次、精确、显式的例外，不是把默认值改成 allow；没有授权的路径仍恒为 `--ignore-scripts`。

## 证据分层

| 层 | 内容 | 状态 |
| --- | --- | --- |
| 契约 fixture / core 守卫 | authorize/deny/commit 漂移/集合不等/`unknown`/none-detected 夹带授权的单测；假执行器不执行任何脚本 | 本片默认 CI |
| renderer | 勾选前不发送授权、勾选后发送精确绑定、输入变化重置确认、`unknown` 不提供按钮 | 本片默认 CI |
| runtime 执行复核 | 受控 executor seam 断言两阶段流程（默认拒执行物化 → 只读枚举 → 单次精确 `allowBuilds` + `--ignore-scripts=false`）、发布前清除 `allowBuilds`、拒绝路径不执行 | 本片默认 CI（`tests/plugins/*` 与 `tests/core/change-apply-authorized.test.ts`，假执行器，不执行任何脚本） |
| opt-in 真实受控 node 链（git+file://，v2 fixture） | 外部 marker 证明 deny=0 marker；精确授权下**恰好**授权集合产生 marker；漂移/子集拒绝 | 受控 fixture v2 已通过独立静态审（30 APPROVED，归档 `7f206792…`）；runtime 子任务在冻结受管 pnpm 11.7.0 上跑 `scripts/research/a4-build-authorization-probe.mjs` 16/16（deny=0；枚举 root 4 + dep 4；allow 8 hook 实际触发；子集/漂移拒绝）。本整合分支未复跑 |
| opt-in 真实 `.pnpm` 传递布局 | 本地最小 registry + 受管 pnpm 生成 `profile→plugin→传递依赖(.pnpm)` 真实树；默认拒执行 marker=0；生产枚举函数读到传递包 4 hook；删真实 manifest ⇒ `unknown` | `scripts/research/a4-pnpm-transitive-layout-probe.mjs` 7/7（受管 pnpm 11.7.0；未放宽 `blockExoticSubdeps`；不执行脚本）。未 publish；手工 mkdir 的 `.pnpm` 用例仅为单元逻辑证据 |
| opt-in 生产 GitHub 外部键 | 真实 `github:` shorthand 的 pinned-lock key vs depPath 逐字节、exact allow 4 marker、错 key/drift 零 marker | `scripts/research/a4-github-key-probe.mjs` v3 14/14（受审 PUBLIC fixture `base-v3 71f9a972…`；不注入 `S4_MARKER_DIR`，marker 走既有 `$TMPDIR` 子目录）；30 只读复核接受为外部键形态证据；HDSL 锁→key 推导有默认 CI 回归；exact key 见[发布记录](plugin-build-authorization-github-fixture-publication.md) |
| opt-in 真实 desktop（production Electron + bridge） | 真实 UI 预览/未授权拒绝/勾选授权应用 4 marker/无沙箱文案/授权配置不持久化/漂移旧授权 API 级拒绝 | **PASS**（QA 子任务，代码 `e80fe55` + fixture `base-v3 71f9a972…`；未注入 env；未跑 start） |
| opt-in 真实 desktop | 真实 production Electron + bridge 走完整预览→授权→apply→重启 | 预览/拒绝/授权/漂移已 PASS（`e80fe55` + `base-v3`）；start 未跑 |
| 生产 GitHub 全链 | 受控公开 GitHub 脚本 fixture 的真实 HTTPS 全链 | 外部键形态 14/14 + 真实 desktop 授权链已 PASS；含 start 的完整运行链仍以实际证据为准 |

- `executor.executedInstallScripts` 是观测报告，**不作为**默认拒执行或“仅执行授权集合”的正控证据；权威证据是受控链上的外部 marker 正控/负控。
- **`UNAUTHORIZED_SCRIPT_EXECUTION` 尚未接线**：受管 pnpm 无可靠的进程内“实际执行集合”信号，因此当前执行期保证是**构造性的**——“默认拒执行 + 仅写精确 `allowBuilds` 键”。若无法获得可靠的观测信号，不得臆造该码的触发证据；该码保留给未来可用的确定性观测。
- **`allowBuilds` 键来源**：取 plan 绑定 pinned lock 的 `packages`/`snapshots` key；`git+`/`git+file://` 与生产 `github:` shorthand（codeload tarball）均已实测与 pnpm depPath 逐字节相等；注册表 `name@version` 在 lock 无 `version` 字段时从 key 后缀回退（URL 后缀不误判），0/多匹配 fail closed。
- 本地 `git+file://` 仅测试传输，**不等于**生产 GitHub 源全链；桌面证据必须分栏。
- 真实受控链与桌面链未跑完前，不得宣称“授权安装已端到端验收”。
