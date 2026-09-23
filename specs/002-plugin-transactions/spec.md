# 002 插件事务与插件发现（规格）

状态：**进行中（S1 已实现；S2 安装闭环已合入 #87；S3 已实现，真实 Node 链已过；S4 本片实现，runtime 执行复核由独立子任务整合；B1 包依赖/bundles 见 [b1-profile-packages.md](b1-profile-packages.md)）**。
契约差异清单的权威出处是 [ADR 0005](../../docs/adr/0005-plugin-contract-evolution.md) §4；本文件只固定 002 的行为边界与实现进度，不复制会漂移的清单。

## 背景与范围

父需求见 GitHub Issue #73。插件能力拆成四个纵向切片：

| 切片 | 内容 | 状态 |
| --- | --- | --- |
| S1（[#75](https://github.com/YingkeSu/HDSL/issues/75)） | 插件发现与详情：GitHub 只读检索闭环 | 已实现（本规格） |
| S2（[#76](https://github.com/YingkeSu/HDSL/issues/76)） | 来源预览、变更计划、安装/卸载事务 | 安装闭环已实现（#87）；卸载见 S3 |
| S3（[#77](https://github.com/YingkeSu/HDSL/issues/77)） | 卸载保护与生效观测 | 本片实现（真实 Node 链验证见 [记录](../../docs/development/plugin-remove-validation.md)） |
| S4（[#78](https://github.com/YingkeSu/HDSL/issues/78)） | 构建脚本授权 | 本片实现（契约/core/UI；runtime 执行复核与真实受控链由独立 runtime 子任务整合） |
| B1（[#115](https://github.com/YingkeSu/HDSL/issues/115)） | profile 包依赖与 `dsh.profile.bundles` reconcile + restart 语义 | 本片实现（见 [b1-profile-packages.md](b1-profile-packages.md)） |

**本规格不声明 S2–S4 已实现**，也不把 ADR 的 `preview`/`apply`/`restore` 方法或 kind 加入可调用白名单。
未实现的入口在界面与文档中明确标注为 S2，而不是返回伪造的成功。

## SI：插件发现与详情（已实现）

### 方法

- `plugins.search`：输入 `{ requestId, query }`（`query` 1–256 字符），返回 `OperationRef`。
- `plugins.inspect`：输入 `{ requestId, source: { owner, name, ref? } }`，返回 `OperationRef`。
- 两者是**全局**操作（`environmentId = null`，`operationKind` 为 `search`/`inspect`），
  终态结果经 `OperationSnapshot.output` 读取（`PluginSearchResult` / `PluginInspection`）。
- `link:`/`file:`/本地路径/任意 URL/自由包名在输入层即 `INVALID_INPUT`；产品来源只有公开 GitHub 仓库。

### 行为与验收口径

| 要求 | 口径 |
| --- | --- |
| 精确查询可复制 | `PluginSearchResult.query` 是实际发出的查询字符串，逐字符一致；默认 `topic:dsh-plugin fork:false archived:false` |
| 结果计数语义 | 展示 `totalCount`、`incompleteResults`、`hasMore`；`hasMore` 已考虑 GitHub 检索只返回前 1000 条（`GITHUB_SEARCH_RESULT_LIMIT`），超限时界面说明被截断 |
| 非安全信号 | star/topic 标注为“仅展示，不作为安全或可安装性依据”；界面显示“发现不代表可安装或安全” |
| 详情 | `plugins.inspect` 返回公开仓库元数据；详情面板展示检索命中元数据，并提供按钮按 `plugins.inspect` 重新获取权威仓库详情；来源预览入口在界面预留，预览本体属 S2 |
| 限流 | `429`，或带可靠限流证据的 `403`（`retry-after` / `x-ratelimit-remaining: 0` / 明示限流消息）→ `RATE_LIMITED`（`retryable`，携带可机读 `retryAfterSeconds`，仅来自可靠依据） |
| 访问拒绝 | `403` 且无可靠限流证据（权限/认证/滥用防护）→ `SOURCE_ACCESS_DENIED`（**非** `retryable`，不误报为限流；`#95`） |
| 网络失败 | 连接建立前失败 → `NETWORK_UNAVAILABLE`；建立后传输/解析失败 → `DOWNLOAD_FAILED` |
| 取消 | 取消为终态 `cancelled`，无环境或组成副作用；已终态取消 → `CANNOT_CANCEL` |
| 无凭据 | 检索路径不读取、不发送任何 GitHub 凭据（含环境变量） |
| 与环境无关 | 全局检索不受任何环境 `ENVIRONMENT_BUSY` 影响，也不改变环境组成 |

### 实现边界（ADR 0005 D17）

- `contracts`：版本 `1.1`、方法/输入 schema、`PluginSearchResult`/`PluginSearchHit`/`PluginInspection`、
  `OperationSnapshot.output?`、`ContractError.retryAfterSeconds?`、D11 错误码与 dispatcher 的逐 kind `output` 规则。
- `core`：`PluginDiscoveryService` 拥有全局操作生命周期（同一个持久化 `OperationStore`），
  取消为终态、失败映射为受控错误码；不联网、不起子进程。
- `runtime`：`createGitHubPluginSource` 只读适配器（可注入 `fetch`/时钟/超时），错误映射见 D11。
- `main`：组合根注入适配器；preload 白名单自动包含新方法；无通用 `invoke`。
- `renderer`：`发现插件` 页完成查询、结果、计数、详情与 S2 预览占位；选中命中后可按 `plugins.inspect` 重新获取详情，并对展示文本做转义（无 `dangerouslySetInnerHTML`）。

### 测试 seam（ADR 0005 D19）

- 默认 CI：契约 fixture + 受控 `fetch` 替身；不访问真实网络。
- 真实 GitHub 只读探针：显式有界、opt-in，不进默认 CI；本规格不新增仓库/CI gate 名。
- 真实 desktop：浏览器模拟层与 Electron 层分栏记录；本地 fixture 不构成真实 GitHub 链路证据。
  E2E harness（`tests/e2e/support/desktop-ui.ts` 与 `sender-frame-*.html` fixtures）使用共享
  `API_VERSION`（fixtures 通过版本占位符注入），避免版本硬编码漂移。

## S3：卸载、内置保护与合法保留（#77）

- rc.2 `cordis.patch.yml` 结构（真实受管安装样本 + dsh-base 注释）：**根为序列**，条目 `- insert: [ {id, name, disabled?, config?} ]` 与 `- id: X` 行覆盖；`name` 是**包引用**，`id` 是 profile 内的行身份；`inject` 是 **Cordis 服务名**（`webStartup`/`loader`/`acpAppStartup`/…），不是包引用。
- **可静态判定并拦截**（`REFERENCED_BY_OTHER`，`blockingReferences` 带来源；detail 为安全标识，不含本地绝对路径）：其它源 insert 行 `name` == 被移除包；其它源以 `- id: X` 行覆盖命中被移除插件 insert 的 `rowIds`；其它源 insert 了与之一致的行 `id`（`last-write-wins` 语义下会改变该层解析）。`insert` 值不是行序列、行不是映射、缺标量 `id`、`name` 为 block scalar 或非字符串、别名/merge key/核心 schema 之外的显式 tag（含受管 dialect 会求值的 `!!js`；核心 schema 解释为普通值的 tag 除外）、多文档、根既非序列也非映射、超尺寸/节点/深度 → **unknown ⇒ 阻塞**（宁过报不漏报、无解析能力不降级为"无引用"）。
- **服务级耦合（判定口径：ADR 0005 D21；政策已 superseded，见 B1）**：固定 rc.2 **无声明性 service provider/consumer 映射**（提供方在代码里）。原 HDSL 命名空间受限声明 + 核验记录的三态门禁（无映射/未核验 ⇒ 阻塞）由 [#112](https://github.com/YingkeSu/HDSL/issues/112) supersede：未核验/未命中消费方**不再阻塞卸载**，只作为 `riskItems` 信息项（`unknown ≠ 危险`）；核验**事实基线**（记录格式、`lookupServiceVerification`、真实 in-box 保护）保留。UI 不得把信息项呈现为“插件安全/无影响”。
- **计划绑定（remove）**：remove 计划保持 `sourceLock: null`；`planInputsDigest` 为内部组合摘要，绑定 pruned declaration 摘要 + 目标精确 recorded commit/manifest + 受管 runtime 身份；composition/pruned lock 由 apply 时重解析逐字比对；user patch/引用输入在 apply 时重扫。任何漂移（含 commit/manifest/runtime 变但 pruned declaration+lock 不变）⇒ `PLAN_STALE`；阻塞计划 apply ⇒ `REFERENCED_BY_OTHER`（不降级为 cache-miss 的 `PLAN_STALE`）。不新增公开契约字段。
- **保留项**：共享/传递依赖按**完全 pin 的 lockfile** 保留（不要求同包在 lock/安装目录全部消失，预览 `retention` 说明）；用户 patch 层（`home/cordis.patch.yml`，**原字节不被写回**）、环境数据（`home/`/`data/`）、审计日志为保留项。
- **内置保护**：`isBuiltin` 由**当前受管 DSH 安装**解析出的 in-box bundle 集合判定（F12a）；缺失或不可信路径 → 拒绝（不是空集合），同名 profile 依赖不改变保护；负控用真实 in-box 名。
- **验收**：同 fixture **安装 → 卸载 → 重启**，以「活动代际记录 + 受管 DSH 离线解析组合树」判定启用集合不再包含该包；配置解析被破坏必须表现为可见受控失败。E9（离线组合树 == 运行期加载集合）等价性仍待实证，不作为唯一判据。真实受控链的精确 HEAD/fixture SHA、分阶段 marker 与负控见 [plugin-remove-validation.md](../../docs/development/plugin-remove-validation.md)（opt-in 真实 Node 链，非桌面验收）。

## S4：显式构建授权（#78）

- **默认仍拒执行**：需要安装期脚本而无显式授权 ⇒ `BUILD_NOT_AUTHORIZED` 终态，组成/指针/修订不变。
- **授权绑定**：`BuildAuthorization { commitSha(40 hex), scripts: BuildScriptEntry[] }`；`BuildScriptEntry = { packageName, packageVersion, script, source: 'root'|'dependency' }`。commit 必须等于计划锁定的精确 commit；脚本集合必须与重新枚举集合**多重集完全相等**（无子集/前缀/通配）。`scriptAssessment === 'unknown'` 时不可授权（未知集合不得当已授权）。
- **不提供**通配/按作者信任/全局放行等价配置（不写 `dangerouslyAllowAllBuilds`/`onlyBuiltDependencies` 等价开关，也不写名字-only 的 git `allowBuilds` 键）。
- **漂移即失效**：源码/脚本/闭包/执行器漂移 ⇒ `AUTHORIZATION_MISMATCH`/`PLAN_STALE`/`PLUGIN_INTEGRITY_MISMATCH`/`EXECUTOR_UNAVAILABLE`，需重新预览并重新确认。
- **执行期复核**：core 守卫（无副作用）之后，runtime 必须在任何写/执行前重解析并逐项复核授权；只在精确授权下写精确 `allowBuilds` 并放开脚本，否则恒为默认拒执行。观测到集合外脚本 ⇒ `UNAUTHORIZED_SCRIPT_EXECUTION`（提交前失败）。
- **提交边界**：复用 S2 事务守卫/cache/journal/ledger/recover。提交前失败或取消 ⇒ 旧代不变、stage 清理、计划不消费；提交后 ⇒ pointer 权威前滚、`CANNOT_CANCEL`、可 `generations.restore`。**失败不提交 ≠ 副作用可回滚**：已执行的安装期脚本不在代数回滚范围内。
- **UI/日志**：展示精确 commit + 已枚举脚本清单（含 `root`/`dependency` 来源；依据计划绑定闭包，未能完整核对时为 `unknown`，不提供授权入口）与“安装期在你的机器上执行该包代码，不受 DSH 或 HDSL 沙箱保护”；授权需显式勾选确认，未确认不发送授权。
- **与 S3 服务核验正交**：构建授权只影响“是否允许执行安装期脚本”这一轴，**不**构成对 `hdsl.services.provides` 的核验，也不得把 S3 的 `unknown` 服务轴变为 `known`/confirmed。通过构建授权安装的新来源，其卸载**不再**因服务核验缺失而阻塞：核验状态只作为 `riskItems` 信息项（[#112](https://github.com/YingkeSu/HDSL/issues/112) supersede，见 [b1-profile-packages.md](b1-profile-packages.md)）；仍阻塞的只有真实 in-box 保护、其它层静态引用与不可解析 patch 构造。
- **限制（受控、不绕过）**：受管 pnpm 11.7.0 的 `blockExoticSubdeps` 默认保留，git 插件含 git 子依赖的闭包受控不支持（`ERR_PNPM_EXOTIC_SUBDEP`），预览/失败文案须写清；预览闭包枚举以 pinned lock 可达身份为权威（含 `.pnpm` 虚拟存储），任一可达包不可核对 ⇒ `unknown`；`BuildScriptEntry` 不含 commit，同版本不同 commit 的依赖只保降级表述、由完整性+严格计数/歧义拒结兜住；`github:` shorthand 的 `allowBuilds` 键已在生产受控 probe 实测逐字节相等。详见[验证边界](../../docs/development/plugin-build-authorization-validation.md)。
- **证据分层与未跑项**见 [plugin-build-authorization-validation.md](../../docs/development/plugin-build-authorization-validation.md) 与[发布/实测记录](../../docs/development/plugin-build-authorization-github-fixture-publication.md)：默认 CI（契约/core/renderer + runtime 受控 executor seam 假执行器）已实现；opt-in 真实受控链（git+file://、`.pnpm` 传递布局、生产 GitHub exact key 14/14）与真实 production desktop 授权链（预览/拒绝/授权/漂移）已 PASS；**含 start 的完整运行链与漂移旧授权的 UI 跨 preview 未覆盖**，不得据此声称全部端到端验收。`UNAUTHORIZED_SCRIPT_EXECUTION` 尚无可靠执行期观测信号，当前为构造性保证（默认拒执行 + 仅写精确 `allowBuilds`）。

## 未决与依赖

- S2 的 home 派生机制、含密文件处理与崩溃恢复是 [#76](https://github.com/YingkeSu/HDSL/issues/76) 的硬门禁（ADR 0005 D18/E10）：**运行数据部分**决策见 [ADR 0006](../../docs/adr/0006-generation-home-derivation.md)，实现与验证边界见 [S2 home/事务设计](s2-home-and-transaction-design.md)，可复现实证见 [记录](../../docs/development/plugin-home-derivation-validation.md)。**决策已给出，但生产实现未落地**：在实现与 `SIGKILL` 全相位对账完成前，不得宣称"旧代际可启动/数据保留"已实现。
- **每代 profile 加载机制（E10b）未决**：共享 home 下 DSH 固定在 `$DSH_HOME/profiles/<name>` 读取 profile（rc.2 实测 P1–P3）。候选机制未选定，**不得预判 symlink 安全**；在 E10b（真实 boot 证明"恢复后旧代实际加载集合 == 该代组成摘要" + 发布原子性/崩溃恢复）通过前，不得声称旧代加载其自身组成。
- `--dump-config` 静态性与运行期加载集合的等价性待实证（E9）；本阶段未证，生效判据仍只到"活动代际记录 + 离线解析组合树"。
- 真实限流形态、闭包摘要推导与受管 pnpm 身份待实证（E1/E2/E6）。
