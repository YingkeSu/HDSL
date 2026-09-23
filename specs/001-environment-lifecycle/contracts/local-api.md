# 本地 API 契约 v1.1（冻结）

文档 rev = v1.1（2026-09-23）；wire 包络版本为 `API_VERSION = "1.1"`（见下节）。文档 rev 记录本文件的修订，`API_VERSION` 是 preload 桥的运行时契约版本；两者独立演进，冲突时以 `API_VERSION` 与可执行实现为准。`1.0` 是已冻结版本，保留为标签 `contracts-v1.0.0` 的历史注记，见 [ADR 0005](../../../docs/adr/0005-plugin-contract-evolution.md)。

实现为 preload 白名单桥，非任意 HTTP 远程控制接口。main 必须校验发送方和所有输入；TypeScript 类型不替代运行时校验。**权威顺序**：`packages/contracts/src`（`version.ts`/`methods.ts`/`errors.ts`/`dto.ts`/`dispatcher.ts`）是方法、字段、错误码与校验顺序的可执行权威；[data-model.md](../data-model.md) 与 [ADR 0005](../../../docs/adr/0005-plugin-contract-evolution.md) 记录修订语义与 1.1 新增 DTO 的归属；本文件汇总调用方法、幂等、错误与事件语义。真实持久化、安装、进程与桌面验收见对应验证记录；**本文件不声称平台验收**。

## 契约版本

- 导出常量 `API_VERSION = "1.1"`（`major.minor`），位于 `packages/contracts/src`，renderer 与 main 共用同一构建产物。历史：`1.0` 冻结于标签 `contracts-v1.0.0`，不移动、不重打。
- 每个请求与响应包络都携带 `apiVersion`。main 在产生任何副作用前**要求完全匹配**：任何 major 或 minor 不一致 → 拒绝，错误码 `CONTRACT_VERSION_MISMATCH`，不执行方法。
- 采用完全匹配的理由：renderer 与 main 共用同一构建产物，且 main 对未知字段严格拒绝；若允诺 minor 兼容，更高 minor 的新增字段必然被拒，承诺不可执行。因此不提供 minor 向后兼容；升级必须是两侧同步的显式变更。
- 版本升级是显式变更并更新本文件，同步更新可执行 fixture 表（`packages/contracts/src/testing/fixtures.ts`）；不得静默放宽字段或错误语义。
- 差异场景必须在「方法 × 合法/非法 fixture × 期望错误码」表中逐条固化；`1.1` 的标签由编排者按合入后的精确提交打 `contracts-v1.1.0`（ADR 0005 §5.4）。

## 通用规则

- 请求包络为 `{ apiVersion, method, input }`；`catalog.list`/`environments.list` 也要求显式 `input: {}`。
- main 校验顺序固定：包络结构 → `apiVersion` 结构合法 → 与 `API_VERSION` **完全匹配**（不一致 → `CONTRACT_VERSION_MISMATCH`，不执行方法）→ 方法白名单与严格输入（未知字段、非法 ID、超长文本 → `INVALID_INPUT`）→ 幂等与状态校验。产生任何副作用前必须先通过版本匹配。
- 请求包含 `requestId`（不透明字符串，长度受限），修改类方法包含 `expectedRevision`（`environments.create` 除外）。
- 幂等：相同 `requestId` + 相同方法 + 相同参数（规范化 JSON 等于）返回原结果，不重复副作用；相同 `requestId` 但方法或参数不同 → `IDEMPOTENCY_CONFLICT`。记录只有两种状态：`in-progress`（全部守卫通过、效果开始前写入）与 `completed`（效果结束后写入结果，包含成功或端口声明的终态失败）。`in-progress` 的重放返回 `ENVIRONMENT_BUSY`（可重试）且**绝不重复效果**；`completed` 的重放返回原结果。纯守卫拒绝（版本/输入/未知 ID/修订/平台，包括 `operations.cancel` 的未知 `operationId`）**不写记录**，因此可用修正后的参数复用同一 `requestId`。`retryable: true` 的失败重试必须使用**新** `requestId`；同一 `requestId` 始终重放已记录结果。幂等记录在操作日志持久化，`in-progress` 中断由 T004 的 journal/reconcile 对账；T003 只证明内存参考语义，不声称跨重启持久化。
- 出站边界：端口返回的成功值必须通过对应 DTO schema 校验（未知字段/非法 ID/越界 → `INTERNAL_ERROR`，不回显原值）；端口异常、配置不当的返回值、事件不符合 schema 或每 operation `sequence` 非递增，均在 main 边界映射为 `INTERNAL_ERROR`。`OperationSnapshot` 的 `phase` 与 `error.message`、以及事件 `phase` 一律脱敏/替换为受控文案（见错误码表），不把端口原文拼接进响应；响应侧与事件侧对同一字段使用同一脱敏规则。错误 `message` 上限 512 字符，校验 issue 数上限 20 条。
- 未知 `environmentId`/`operationId`/`subscriptionId` → `NOT_FOUND`，不得退化为创建或静默成功。
- `expectedRevision` 是**组成修订**，语义见 [data-model.md](../data-model.md)；不匹配 → `REVISION_CONFLICT`，不产生副作用。状态迁移由独立的 `stateVersion` 表示，不作为修改类方法的准入条件。
- 成功 `{ ok: true, apiVersion, value }`；失败 `{ ok: false, apiVersion, error: { code, message, retryable, operationId? } }`。失败包络始终携带 main 的 `apiVersion`。不暴露栈、密钥、token、cookie 或任意本地路径；错误消息在构造时脱敏（URL 凭据、`token=`/`bearer`、本地绝对路径）。
- 输入结构严格拒绝未知字段、超长文本和非法 ID。

## 秘密边界（与上游真实行为协调）

范围决策见 [ADR 0002](../../../docs/adr/0002-credential-boundary.md)。上游落盘行为依据 PR #14 探针记录（[dsh-behavior-probes.md @ c092f67](https://github.com/YingkeSu/HDSL/blob/c092f67b25f7233bd49e0c1452bdd0df2cd3516a/docs/research/dsh-behavior-probes.md)）；该证据尚未合并，**待 T001 在 `docs/research/dsh-compatibility.md` 复核转正**，复核前按待验证处理，不据此声称已支持。

- **受管用户 API 凭据**：由 main 的凭据适配器按 OS 凭据存储（keychain/credential manager）**引用**解析，在启动受管 DSH 时注入显式进程环境（对应 FR-003/FR-007）。凭据值不写入环境目录、操作日志、诊断导出、整合包或 Git。
- **上游生成的本地凭据产物**：DSH 首次 `web` 启动据探针会在环境 home 写 `.credentials.yaml`（权限 0600，内含 Web 会话 grant secret）并在 `logs/` 写启动诊断。因此 HDSL 把环境 home 整体视为**含密目录**：不进入整合包、导出与普通日志，不跨环境复制，导出前脱敏。契约**不承诺上游不落盘凭据文件**，也**不要求**该上游产物改由 OS 凭据存储引用；FR-007 的验收覆盖这两类，不把“上游不落盘”当作前提。

## 方法

| 方法 | 输入 | 返回 | 约束 |
| --- | --- | --- | --- |
| catalog.list | 无 | 已核验 RuntimeCombination[] | 含平台、来源与兼容证据；未核验组合不出现在列表 |
| environments.list | 无 | EnvironmentSummary[] | 只读摘要，不含秘密与本地路径 |
| environments.create | requestId, name, catalogCombinationId | OperationRef | name 1–80 字符；`catalogCombinationId` 必须映射到 CompositionLock；平台必须匹配 |
| environments.start | requestId, environmentId, expectedRevision | OperationRef | 重复启动不重复进程；组合修订变化则拒绝 |
| environments.stop | requestId, environmentId, expectedRevision | OperationRef | 仅终止自己拥有的进程；重复停止幂等 |
| environments.switchCombination | requestId, environmentId, expectedRevision, catalogCombinationId | OperationRef | 1.1 追加（#114 A2）：把已有环境的活动组成切到另一已支持组合。**仅 `stopped` 环境可切换**（操作专属停止前置，不传播为全局规则）；新代安装+验证后原子切指针；提交前失败保旧代且不置 `error`；旧代保留；目标组合已活动 → 幂等 no-op；与 `environments.create` 不共用方法（create 失败清指针，switch 失败必须保指针） |
| environments.openWebUI | requestId, environmentId | OpenWebUIResult | 仅 main 原生打开属于当前受管进程的已验证 loopback endpoint；renderer 不接收携带 token 的 URL |
| operations.get | operationId | OperationSnapshot | 支持查询最终状态；携带该 operation 的 `sequence` 以便重连检测缺口 |
| operations.cancel | requestId, operationId | OperationSnapshot | 尽力取消；提交后返回 CANNOT_CANCEL |
| operations.subscribe | requestId, operationId? | SubscriptionRef | 建立 `operation.updated` 推送；省略 operationId 表示订阅该窗口全部操作，事件按 operationId 分组 |
| operations.unsubscribe | requestId, subscriptionId | `null` | 退订后不再推送；未知 subscriptionId → NOT_FOUND |
| diagnostics.export | requestId, environmentId | ExportResult | 由 main 原生选择路径并脱敏；幂等，失败返回 EXPORT_FAILED |
| plugins.search | requestId, query | OperationRef | 1.1 追加（ADR 0005 D4/D16，S1，1.0 标签不动）；全局（`environmentId=null`）只读检索，终态 `PluginSearchResult` 仅从 `OperationSnapshot.output` 读取；`query` 1–256 字符，`hits` 上界 100、`totalCount` 不静默截断（GitHub 搜索上限 1000 以 `hasMore` 表示）；不使用 GitHub 凭据，不受环境 `ENVIRONMENT_BUSY` 影响；`RATE_LIMITED` + `retryAfterSeconds` / `SOURCE_ACCESS_DENIED` / `NETWORK_UNAVAILABLE` 等按 D11 分类；发现不代表可安装或安全 |
| plugins.inspect | requestId, source {owner, name, ref?} | OperationRef | 1.1 追加（ADR 0005 D4/D16，S1，1.0 标签不动）；全局只读，`source` 只接受公开 GitHub `owner`/`name`/可选 `ref`，`link:`/`file:`/本地路径/任意 URL → `INVALID_INPUT`；终态 `PluginInspection` 仅从 `OperationSnapshot.output` 读取；不使用凭据、不改变环境组成 |
| changes.preview | requestId, environmentId, expectedRevision, action | OperationRef | 1.1 追加（ADR 0005 D4/D6/D20，S2，1.0 标签不动）；环境级变更计划，`action` 为 `{kind:'install', source}` 或 `{kind:'remove', pluginId}`；只写计划（不改变组成/指针/来源锁），运行中可预览；终态 `ChangePlan` 仅从 `OperationSnapshot.output` 读取；`scriptAssessment='unknown'` 不得呈现为无脚本保证 |
| changes.apply | requestId, environmentId, expectedRevision, planId, buildAuthorization? | OperationRef | 1.1 追加（ADR 0005 D4/D8/D14，S2/S4，1.0 标签不动）；以计划为基准重新解析并复核（源摘要/脚本集合/执行器身份/授权绑定），**全部比较先于任何写操作**；提交点 = 活动代指针切换，提交后取消 → `CANNOT_CANCEL`；`buildAuthorization` 精确绑定 commit + 脚本集合（无通配/作者信任），未授权或 `unknown` 脚本集受控拒绝；终态 `ChangeApplication` 仅从 `OperationSnapshot.output` 读取 |
| plugins.installed | environmentId | InstalledPluginsView | 1.1 追加（ADR 0005 D4/D15，S3，1.0 标签不动）；只读即时、无 requestId、running 不返回 BUSY；结果为活动代持久组成 + 当前受管 DSH 安装解析，字段最小有界（无磁盘路径/manifest 文本/凭据），`plugins` 上界 128 且**不静默截断**（超出 → 受控 INTERNAL_ERROR，对齐 D20）；环境不存在 → NOT_FOUND，无活动代 → generationId=null 且空列表 |
| generations.list | environmentId | GenerationSummary[] | 1.1 追加（ADR 0005 D4，1.0 标签不动）；只读即时、无 requestId；返回活动代与历史代摘要（`dshCompatibilityWarning?` 为 additive）；环境不存在 → `NOT_FOUND` |
| generations.restore | requestId, environmentId, expectedRevision, targetGenerationId | OperationRef | 1.1 追加（ADR 0005 D4/D8，1.0 标签不动）；把活动代指针原子切回已记录代；提交前失败保旧代；终态 `GenerationSummary` 仅从 `OperationSnapshot.output` 读取；目标 DSH 版本低于环境最近成功启动版本时给出**非阻断** `dshCompatibilityWarning`，同版本/未知不提示，不撤销已写数据、不做 schema 降级 |
| versions.dsh | requestId | OperationRef | 1.1 追加（A1/#113，1.0 标签不动）；全局（`environmentId=null`）只读上游 DSH 版本清单，终态 `DshVersionListing` 仅从 `OperationSnapshot.output` 读取；只访问白名单主机 `registry.npmjs.org`、无凭据、不下载/不执行任何包；按受审组合标注 `supported`，未受审版本不得呈现为可安装；网络错误按 D11 分类（`NETWORK_UNAVAILABLE`/`RATE_LIMITED`/`SOURCE_ACCESS_DENIED`/`SOURCE_NOT_FOUND`/`DOWNLOAD_FAILED`） |
| compositions.expected | requestId, environmentId | OperationRef | 1.1 追加（#118，1.0 标签不动）；环境级只读**期望组成**：离线运行受管 `dsh --profile <p> --dump-config` 并解析分组 `# == <label>` YAML，终态 `ExpectedCompositionView` 仅从 `OperationSnapshot.output` 读取；`basis='dump-config'`、`runtimeVerification='unavailable'` 固定，**永不表示运行期 ACTIVE 集合**；`!!js` 逐字保留不求值，stderr/解析失败显式呈现；不执行插件代码、不使用凭据；running/starting/stopping → `ENVIRONMENT_BUSY`，无活动代 → `NOT_FOUND` |

`OpenWebUIResult` 只返回 `{ loopbackOrigin }`；`loopbackOrigin` 为 `http(s)://127.0.0.1:<port>` 或 `[::1]` 形式，端口必须是 1–65535 的**规范十进制**（拒绝 `:0`、`:65536`、`:99999` 与前导零 `:00080`），**不含 token、cookie 或查询串**。成功即已原生打开，失败一律走错误码，不设 `opened: false` 这种第二套失败表示。main 必须在打开前核对 `LaunchRecord.endpoint` 属于该环境的当前受管进程，且地址为 loopback；否则返回 `WEBUI_UNAVAILABLE`。返回体在出站前按 `openWebUIResultSchema` 校验，额外字段（如 `tokenUrl`/`cookie`）会导致 `INTERNAL_ERROR`。

`ExportResult` 为 `{ exportId, exported: true, redacted: true }`，**不含导出路径**。`exportId` 是不透明稳定标识：相同 `requestId` + 相同参数的重复请求 MUST 返回**原成功摘要**且**不重做导出副作用**（不再次弹窗、不覆盖文件）；不同 `requestId` 产生新导出。本版不新增 `diagnostics.reveal` 接口。

### 组成来源与摘要子集（issue #15 N3）

`CompositionLock` 保留下载来源记录 `sources: { node, dsh }`（各含 `url` 与 `sha256`），用于复现时的来源追溯；但 `RuntimeArtifactRef` **不含** `url`，且 `compositionDigest` 只对子集 `schemaVersion`、`node`/`dsh` 的 `version/platform/arch/sha256`、排序后的 `plugins` 做规范化 JSON + SHA-256。`sources` 永不进入摘要：改动下载 URL（含镜像、签名查询串）不改变摘要。规范化 JSON 的函数在 `packages/contracts/src/digest.ts`，T004 负责对其字节做 SHA-256 与持久化。

**1.1 追加（ADR 0005 D13/D21，S2/S3）**：`CompositionLock` 新增**可选、非摘要**字段 `pluginSources`（`Record<pluginId, PluginSourceLock>`，缺失=无插件来源记录）。它记录已安装插件的精确 `repository/commitSha/manifestSha256/closureLockSha256` 来源身份，供卸载时按精确身份重验（不从 live 文件自建信任）；与 `sources` 同理**不进入 `compositionDigest`**（摘要输入投影只选 `schemaVersion`/`node`/`dsh`/`plugins`）。`pluginSources` 的 map 键与 `PluginLock.id`、`InstalledPlugin.id`、remove 目标 `pluginId` 一致，均为 **npm 包名**（可带 scope，如 `@deepseek-ai/dsh-base`）——比不透明 id 规则宽（真实 in-box bundle 与已安装插件都是包名），上界 214 字符；负控见 `tests/contracts/plugins-installed.test.ts`。

**1.1 追加（#114 A2）**：新增操作 `OperationKind 'switch'` 与方法 `environments.switchCombination`（见上表）。可达代数据模型新增：durable `generation.json.dshVersion`（additive，缺失按未知）、环境记录 `lastStartedGenerationId`/`lastStartedDshVersion`（additive，不进 `EnvironmentSummary`）。`generations.restore` 的终态 `GenerationSummary` 新增**可选**字段 `dshCompatibilityWarning`（`string | null`）：当目标代 DSH 版本严格早于环境记录「最近成功启动 DSH 版本」时给出**非阻断**数据兼容提示；同版本（Node 轴正控）与任一版本未知时**不**提示；提示不撤销已写数据、不做 schema 降级。本切片不声称跨版本 home 兼容（ADR 0006 D6 / R006）。`stopped` 前置是 `switchCombination` 操作专属，不改 #116 运行期 entry 的 live reload 语义。

## 事件

事件通道 `operation.updated` 由 `operations.subscribe` 建立，携带：`subscriptionId`、`operationId`、`sequence`、`phase`、`status`、`progress?`。`sequence` 是**每 operation** 单调递增计数（与 `Operation.sequence`、`OperationSnapshot.sequence` 同一域），不是订阅内全局计数；多操作订阅时按 operationId 分组递增，事件必带 operationId。百分比未知时不给假进度；事件不含 token、cookie 或本地路径：发布前逐个 `operationUpdatedEventSchema` 校验（`progress` 必须 0–100），`phase` 先脱敏，不合法事件在 dispatcher 边界映射为 `INTERNAL_ERROR`。客户端重连以 `operations.get` 为准；取消不等于系统回滚。preload 白名单只暴露上述订阅/退订方法与两个固定事件订阅入口，不暴露任意通道发送。

`environment.updated` 是独立的固定推送通道（1.1 追加，issue #108），用于在**非 renderer 发起**的环境状态变化时投影权威摘要。典型触发：受管进程意外退出，core `handleProcessExit` 把环境置 `stopped`（并失败进行中的 start operation），main 在状态**确实变化**后按 `environmentUpdatedEventSchema` 校验，并以与 `environments.list` 同构、不含秘密与本地路径的 `EnvironmentSummary` 推送给每个窗口。`stateVersion` 单调递增，renderer 合并时可据此拒绝迟到的事件，因此无需轮询、也无需用户手动刷新。未知 `environmentId` 或非法/多余字段的投影在 main 边界丢弃，不跨桥。该通道不改变 `operation.updated` 的既有语义，也不表示插件活动组成（`ACTIVE` 代）发生变化。

订阅注册表与幂等账本在 T003 是**进程级**。`SubscriptionRegistry` 预留不透明 `owner` 接口，供可信调用上下文（例如窗口 id）隔离退订；但 Electron sender 身份校验、按窗口订阅作用域与配额是 **T006** 职责，本版不声称已实现窗口隔离。`operations.subscribe`/`unsubscribe` 的幂等重放：若退订后重放同一 `requestId`，dispatcher 会以**同一** `subscriptionId` 重建订阅再返回原 ref，不返回失效引用。

## 错误码

| code | retryable | 语义 |
| --- | --- | --- |
| INVALID_INPUT | 否 | 缺字段、类型错误、未知字段、超长文本或非法 ID |
| NOT_FOUND | 否 | 未知 environmentId/operationId/subscriptionId |
| IDEMPOTENCY_CONFLICT | 否 | 相同 requestId 携带不同参数 |
| CONTRACT_VERSION_MISMATCH | 否 | apiVersion 与 main 不完全一致（major 或 minor） |
| UNSUPPORTED_COMBINATION | 否 | 组合未核验；覆盖不支持平台（含 Windows 未验证平台） |
| REVISION_CONFLICT | 否 | expectedRevision 与当前组成修订不一致 |
| ENVIRONMENT_BUSY | 是 | 环境运行中或存在并发修改事务 |
| WEBUI_UNAVAILABLE | 是 | 环境非 running，或 endpoint 不属于当前受管进程 / 非 loopback |
| DOWNLOAD_FAILED | 是 | 下载失败；连接建立后传输/取物失败 |
| DIGEST_MISMATCH | 否 | 摘要与受审 catalog 不符 |
| DISK_FULL | 是 | 磁盘不足 |
| START_TIMEOUT | 是 | 就绪超时 |
| PORT_UNAVAILABLE | 是 | 端口冲突 |
| PROCESS_EXITED | 是 | 受管进程意外退出 |
| CANNOT_CANCEL | 否 | 操作已提交，无法取消 |
| EXPORT_FAILED | 是 | 诊断导出失败，未产出可用文件 |
| INTERNAL_ERROR | 否 | 未分类内部错误，message 需脱敏 |
| RATE_LIMITED | 是 | 上游限流（`429`，或带可靠限流证据的 `403`）；可携带 `retryAfterSeconds` |
| NETWORK_UNAVAILABLE | 是 | 连接建立前失败（DNS/离线/TLS/整体超时） |
| SOURCE_ACCESS_DENIED | 否 | `403` 且无可靠限流证据：权限/认证/滥用防护 |
| SOURCE_NOT_FOUND | 否 | 仓库、ref、提交或包不存在；锁定的 commit 不可达 |
| SOURCE_MANIFEST_INVALID | 否 | 源 manifest 不可读或非法 |
| NOT_A_PLUGIN | 否 | 源未声明 DSH bundle patch |
| PLAN_EXPIRED | 否 | 计划超过有效期 |
| PLAN_STALE | 否 | 计划输入漂移 |
| PLAN_CONSUMED | 否 | 计划已被其它请求消费 |
| EXECUTOR_UNAVAILABLE | 否 | 受管执行器缺失、版本或摘要不符 |
| BUILD_NOT_AUTHORIZED | 否 | 源需要执行脚本但未给授权 |
| AUTHORIZATION_MISMATCH | 否 | 授权未精确绑定计划的 commit + 脚本集合 |
| UNAUTHORIZED_SCRIPT_EXECUTION | 否 | 执行期观测到未授权/未预期的第三方脚本 |
| BUILTIN_BUNDLE_PROTECTED | 否 | 目标是当前受管安装解析出的内置 bundle，不可移除 |
| REFERENCED_BY_OTHER | 否 | 移除会破坏其它 bundle/配置解析，或被用户 patch 层引用 |
| PLUGIN_INTEGRITY_MISMATCH | 否 | 复解析内容与计划记录的摘要不符 |

`retryable` 由 `packages/contracts/src/errors.ts` 的 `RETRYABLE_CODES` 单一权威决定（上表 `是` 共 10 个）；失败包络可选携带 `retryAfterSeconds`（整数，1–86400，仅 `RATE_LIMITED` 依据可靠证据产生，`x-ratelimit-reset` 单独出现不构成证据）。**服务依赖核验不是本契约的门禁**：`REFERENCED_BY_OTHER`/`BUILTIN_BUNDLE_PROTECTED` 只覆盖真实静态引用与内置保护；服务核验（`unknown`/未命中）仅作为 `riskItems` 信息项，不阻塞卸载（[#112](https://github.com/YingkeSu/HDSL/issues/112) supersede，事实基线见 ADR 0005 §9.5a）。

## 契约 fixture 表

权威的可执行表是 `packages/contracts/src/testing/fixtures.ts` 的 `ALL_CONTRACT_FIXTURES`，通过**仅测试用子路径** `@hdsl/contracts/testing` 导出，不在生产入口 `@hdsl/contracts`；`tests/contracts/fixtures.test.ts` 逐条断言观察到的结果与 `expected` 相等，`tests/contracts/local-api-doc.test.ts` 断言本节与可执行面不漂移。该表在**仅测试用**的内存端口上运行；真实持久化、安装与进程效果由各自的集成/验证记录覆盖，内存端口不构成持久化验收。

包络与版本（`ENVELOPE_FIXTURES`）：

| fixture | 期望 |
| --- | --- |
| envelope-strict-ok | `ok` |
| envelope-major-mismatch（`2.0`） | `CONTRACT_VERSION_MISMATCH` |
| envelope-minor-mismatch（`1.2`） | `CONTRACT_VERSION_MISMATCH` |
| envelope-malformed-version / missing-version / non-string-version | `INVALID_INPUT` |
| envelope-unknown-method / unknown-key / missing-input / not-an-object / input-not-object | `INVALID_INPUT` |

方法（`CONTRACT_FIXTURES`，合法 → `ok`）：

| 方法 | 合法 fixture | 非法 fixture → 期望错误码 |
| --- | --- | --- |
| catalog.list | catalog-list-legal | catalog-list-unknown-field → `INVALID_INPUT` |
| environments.list | environments-list-legal | environments-list-unknown-field → `INVALID_INPUT` |
| environments.create | environments-create-legal | name-too-long / name-path / illegal-id / missing-request-id / unknown-field → `INVALID_INPUT`；unknown-combination → `NOT_FOUND`；platform-mismatch / unverified → `UNSUPPORTED_COMBINATION` |
| environments.start | environments-start-legal | illegal-id / missing-revision / negative-revision → `INVALID_INPUT`；unknown → `NOT_FOUND`；revision → `REVISION_CONFLICT`；busy → `ENVIRONMENT_BUSY` |
| environments.stop | environments-stop-legal | unknown → `NOT_FOUND`；revision → `REVISION_CONFLICT`；not-running → `ENVIRONMENT_BUSY` |
| environments.switchCombination | environments-switch-legal | busy（running） → `ENVIRONMENT_BUSY`；revision → `REVISION_CONFLICT`；unknown environment/combination → `NOT_FOUND`；unsupported/unverified → `UNSUPPORTED_COMBINATION`；missing-request-id → `INVALID_INPUT` |
| environments.openWebUI | environments-openwebui-legal | missing-id → `INVALID_INPUT`；unknown → `NOT_FOUND`；stopped / token-url / port-zero / port-too-high / port-huge / port-leading-zero → `WEBUI_UNAVAILABLE` |
| operations.get | operations-get-legal | illegal-id / unknown-field → `INVALID_INPUT`；unknown → `NOT_FOUND` |
| operations.cancel | operations-cancel-legal | missing-request-id → `INVALID_INPUT`；unknown → `NOT_FOUND`；final → `CANNOT_CANCEL` |
| operations.subscribe | subscribe-legal-operation / subscribe-legal-all | illegal-id / unknown-field → `INVALID_INPUT`；unknown → `NOT_FOUND` |
| operations.unsubscribe | unsubscribe-legal（先 subscribe 的 prelude） | illegal-id → `INVALID_INPUT`；unknown → `NOT_FOUND` |
| diagnostics.export | export-legal | missing-request-id → `INVALID_INPUT`；unknown → `NOT_FOUND`；failed → `EXPORT_FAILED` |
| plugins.search | plugins-search-legal / plugins-search-truncated / plugins-search-rate-limited / plugins-search-access-denied / plugins-search-network-failure | empty-query / unknown-field（含 token 字段） → `INVALID_INPUT` |
| plugins.inspect | plugins-inspect-legal / plugins-inspect-not-found | local-path（`link:`/路径） / unknown-field → `INVALID_INPUT` |
| plugins.installed | plugins-installed-legal | missing-environment → `INVALID_INPUT` |
| generations.list | generations-list-legal | missing-environment → `INVALID_INPUT` |
| changes.preview | changes-preview-legal | invalid-action（install 无 source） → `INVALID_INPUT` |
| changes.apply | changes-apply-legal / changes-apply-legal-authorized（S4 精确授权） | missing-plan / invalid-authorization（commit 非 40 hex） → `INVALID_INPUT` |
| generations.restore | generations-restore-legal | missing-target → `INVALID_INPUT` |
| versions.dsh | versions-dsh-legal / versions-dsh-network-failure | missing-request-id → `INVALID_INPUT` |
| compositions.expected | compositions-expected-legal | missing-request-id / missing-environment → `INVALID_INPUT` |
| idempotency-conflict | — | 同 `requestId` 不同 `name` → `IDEMPOTENCY_CONFLICT` |
| idempotency-guard-retry | 先 `NOT_FOUND` 再修正参数 | 修正后同 `requestId` → `ok`（守卫拒绝不锁死参数） |

补充行为测试（`tests/contracts/`，不在上表逐条列出）：重复 `requestId` 返回原 `ExportResult` 摘要且副作用计数为 1；参数键顺序不影响指纹；守卫拒绝不记录、`in-progress` 不重做；端口异常/畸形返回/非法出站 DTO/重复 sequence → 脱敏 `INTERNAL_ERROR`；`catalog.list` 过滤未核验组合；订阅/退订按 operationId 分组递增且严格单调、退订后重放重建同一 `subscriptionId`；错误文本长度上限；秘密与本地路径不进入错误与事件。

契约版本标签：`contracts-v1.0.0` ↔ `API_VERSION = "1.0"`（已冻结，只读）；`1.1` 对应 `contracts-v1.1.0`，按 ADR 0005 §5.4 由编排者在合入后的**精确提交**上创建。**截至本修订 `contracts-v1.1.0` 尚未创建**；打标签 ≠ 平台验收，实现切片不提前 tag 未审 HEAD。

## 1.1 插件发现（S1）

`plugins.search` 与 `plugins.inspect` 是**全局**（`environmentId = null`）只读检索/详情方法，返回 `OperationRef`；终态结果经 `OperationSnapshot.output` 读取。二者不使用任何 GitHub 凭据，不受环境 `ENVIRONMENT_BUSY` 影响，且不改变任何环境组成。错误映射见 ADR 0005 D11/D16：`RATE_LIMITED` + `retryAfterSeconds`（`429`，或带可靠限流证据的 `403`）、`SOURCE_ACCESS_DENIED`（无可靠限流证据的 `403`，非重试）、`NETWORK_UNAVAILABLE`、`SOURCE_NOT_FOUND` 等。

## 1.1 DTO 与 OperationKind（归属）

`OperationKind` 当前取值：`create`、`start`、`stop`、`switch`、`openWebUI`、`export`、`search`、`inspect`、`preview`、`apply`、`restore`、`versions`、`composition`。`OperationSnapshot.output` 为 1.1 追加的**可选**终态载荷，逐 kind/状态必填规则见 ADR 0005 D5：只从 `operations.get` / `operations.cancel` 的终态快照读取，`operation.updated` 事件不携带 `output`；违规在 main 边界映射为 `INTERNAL_ERROR`。

1.1 新增 DTO：`PluginSearchResult` / `PluginSearchHit`、`PluginInspection`、`PluginSourceLock`、`ChangePlan` / `ChangePlanAction` / `ChangeBlockingReference`、`BuildScriptEntry` / `BuildAuthorization`、`ChangeApplication`、`GenerationSummary`、`InstalledPlugin` / `InstalledPluginsView`、`DshVersionListing` / `DshUpstreamVersion`、`ExpectedCompositionView`。既有 DTO 的 additive 可选字段：`ContractError.retryAfterSeconds?`、`CompositionLock.pluginSources?`、`GenerationSummary.dshCompatibilityWarning?`、`OperationSnapshot.output?`。字段权威与边界见 `packages/contracts/src/dto.ts`；`pluginSources` 等非摘要字段不进入 `compositionDigest`。

## 已接受的行为边界与未实测项

已接受的边界（不写成更强保证）：

- **版本管理**：支持范围 = 已有安装/验证证据的组合；未知版本不虚报为已支持（**未知 ≠ 危险**），逐版本安全审计不是永久门禁。同环境切换只由 `environments.switchCombination`（**仅 `stopped`**，操作专属前置，不传播为全局规则）与 `generations.restore` 承担。
- **包管理**：profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 变更**需重启**才生效（DSH 无 watcher）；共享/传递依赖按锁闭包保留，不承诺无损/未使用；安装期脚本默认拒执行，需显式精确授权（#78 retain）。
- **desired config（saved/pending）**：写 profile `cordis.patch.yml` 成功只表示 desired config 已原子保存；`patchReload=live` 时预计热重载但 HDSL 未观测，**保存 ≠ 运行期 ACTIVE**。保存/等待应用与显式重启 fallback 属产品接线切片，本契约不新增方法（[#116](https://github.com/YingkeSu/HDSL/issues/116)）。
- **动态 DSH 职责**：动态 load/unload 与影响判断交 DSH；HDSL 不 in-process 挂载 Cordis、不伪造认证会话、不承诺无损卸载、**不做静态服务依赖证明门禁**；服务核验只作 `riskItems` 信息项。
- **期望组成**：`compositions.expected` 的 `basis='dump-config'`、`runtimeVerification='unavailable'` 固定，**永不表示运行期 ACTIVE**。

未实测项（不作为契约保证）：

- Windows/Linux 平台（仅 macOS ARM64 有组合证据；Windows 未验证 → `UNSUPPORTED_COMBINATION`）。
- 仅 loopback（未用套接字清单证明独占）。
- 跨版本 home/session 兼容（R006；`dshCompatibilityWarning` 只提示，不迁移、不降级 schema）。
- `--dump-config` 离线解析集合与运行期实际加载集合的等价性（E9 未证）。
- `pluginInventory` 运行期 ACTIVE 观测（Remote/会话接入未验证）。

## 后续接口预留

`pack.inspect` / `pack.import` / `pack.export` 在 003 规格中定义，本契约不暴露。Registry 与小程序接口须另设版本化规格。1.1 白名单内的 21 个方法均已实现；行为边界、错误映射与证据分层见 [002 规格](../../002-plugin-transactions/spec.md) 与 [ADR 0005](../../../docs/adr/0005-plugin-contract-evolution.md)。
