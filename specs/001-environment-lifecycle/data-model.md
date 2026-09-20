# Data Model（草案 v0.2）

实施前修订（2026-09-20）：补齐契约引用的 DTO、修订语义、摘要规范与凭据边界。字段为权威定义；调用方法与错误码见 [contracts/local-api.md](contracts/local-api.md)。

## 实体

| 实体 | 字段 | 约束 |
| --- | --- | --- |
| Environment | id, name, revision, stateVersion, activeGenerationId, state | id 为不透明内部 ID；name 不作为路径；见下方修订语义 |
| EnvironmentSummary | id, name, revision, stateVersion, state, activeGenerationId, compositionDigest | `environments.list` 的只读视图；不含秘密、token 或本地路径 |
| Generation | id, environmentId, compositionDigest, createdAt | 只属于一个环境；组成固定 |
| CompositionLock | schemaVersion, node, dsh, plugins, sources | node/dsh 为 RuntimeArtifactRef（不含 url）；`sources` 并列保留下载 url 与 sha256 供来源追溯；plugins 在首切片为空 |
| RuntimeCombination | id, platform, arch, node, dsh, compatibility, artifactLocations | node/dsh 为 RuntimeArtifactRef；`catalog.list` 的返回项；compatibility 至少含 status 与 evidenceRef，未核验组合不入列表；artifactLocations 并列记录下载 URL，不进入组成摘要 |
| RuntimeArtifactRef | version, platform, arch, sha256 | 进入 CompositionLock 与组成摘要的字段子集；sha256 为 64 个十六进制字符（256 位，小写）；**不含 url** |
| RuntimeArtifact | version, platform, arch, url, sha256 | 受审 catalog 的完整产物记录；url 仅作并列位置，不参与摘要 |
| Operation | id, environmentId, kind, phase, status, sequence, error | 状态 queued/running/succeeded/failed/cancelled，终态不可回退；`sequence` 为**每 operation** 单调递增计数 |
| LaunchRecord | operationId, environmentId, processIdentity, endpoint, createdAt | processIdentity 为所有权标识，不等同 PID；endpoint 只允许 loopback，且必须归属该环境当前受管进程 |
| CredentialReference | id, store, key | 仅指向 OS 凭据存储；不含凭据值，不进入任何导出/打包实体 |

## 契约引用映射

- `catalogCombinationId` 是 RuntimeCombination.id。`environments.create` 用它选定组合，并在创建时将其解析为一个不可变 CompositionLock 写入新 Generation；后续启动、摘要计算都以 CompositionLock 为准，不再重新解析 catalog。
- `EnvironmentSummary.compositionDigest` 等于 `activeGenerationId` 对应 Generation.compositionDigest；无活动代际时为 null。
- `OperationRef` 为 `{ operationId }`；`OperationSnapshot` 在 Operation 基础上含最终 `error`、`sequence` 与 `progress?`；`SubscriptionRef` 为 `{ subscriptionId }`；`ExportResult` 为 `{ exportId, exported: true, redacted: true }`，不含导出路径；相同 requestId+参数重复请求返回原 ExportResult 且不重做副作用。
- `sequence` 域为**每 operation**：`Operation.sequence`、`OperationSnapshot.sequence` 与 `operation.updated` 事件的 `sequence` 同属该 operation 的计数；多操作订阅时按 operationId 分组递增。

## 修订语义（revision / stateVersion）

- `revision`：**组成修订**。仅在创建环境、以及活动代际指针成功切换（未来变更/恢复提交）时递增。它回答“组成是否变化”。
- `stateVersion`：**状态修订**。每次状态迁移（stopped→starting→running→stopping→stopped、失败进入 error 等）递增。它回答“状态视图是否过期”。
- 修改类方法的 `expectedRevision` 校验的是 `revision`，因此单纯启停**不**改变 `revision`，客户端无需在每次启停后重读修订；状态变化通过 `stateVersion` 与 `operation.updated` 感知。
- 任一计数器只增不减；不得用时间戳或 PID 冒充修订号。

## 组成摘要（compositionDigest）规范

- 输入是 CompositionLock 的**规范化 JSON 子集**（issue #15 N3）：`schemaVersion`、`node`/`dsh`（各为 RuntimeArtifactRef 的 `version/platform/arch/sha256`）与排序后的 `plugins`。CompositionLock 可以携带 `sources`（下载 url 与 sha256）用于来源追溯，但 `sources` **不属于**摘要输入，永不进入摘要。键按 UTF-8 字节序升序、无多余空白、字符串 UTF-8、数组保持语义顺序（插件按已定义排序键排序）。
- 摘要在平台无关的规范化字节上计算：`SHA-256`，输出 64 个小写十六进制字符。可执行投影与规范化函数见 `packages/contracts/src/digest.ts`（`compositionDigestInput` / `serializeCompositionDigestInput`）；T004 负责对规范化字节做 SHA-256 与持久化。
- 相同语义输入跨平台必须得到同一摘要；T004 必须包含跨平台稳定性测试。下载 `url` 属于 RuntimeArtifact/RuntimeCombination 的并列记录与 CompositionLock.sources，**不进入**组成摘要；镜像或带签名查询串的 URL 变化不得改变摘要。

## 状态机与运行数据

Environment 状态：creating → stopped → starting → running → stopping → stopped；失败进入 error，重启先 reconcile 再给出 stopped/running/error。操作失败与环境失败独立，下载失败不可伪造 running。

创建/安装阶段的未完成操作也要有持久化 journal 与重启对账：T004 负责创建/安装事务的 journal 与恢复入口，T005 的 `reconcile/**` 统一覆盖“未完成创建”与“未结束进程”两类，所有权约定见 [tasks.md](tasks.md)。

## 凭据边界

范围决策见 [ADR 0002](../../docs/adr/0002-credential-boundary.md)。

- 受管用户 API 凭据只以 CredentialReference 形式存储，由启动时解析并注入显式进程环境，不写入上述任何可导出实体。
- 上游 DSH 据 PR #14 探针（未合并，固定 commit [c092f67](https://github.com/YingkeSu/HDSL/blob/c092f67b25f7233bd49e0c1452bdd0df2cd3516a/docs/research/dsh-behavior-probes.md)）会在环境 home 生成 `.credentials.yaml`（0600，Web 会话 grant secret）与 `logs/` 诊断。环境 home 因此整体视为含密目录：不进入整合包、导出、普通日志与 Git，不跨环境复制。该项**待 T001 复核转正**，复核前按待验证处理；数据模型不假设上游从不写凭据文件，也不要求该产物改由 OS 凭据存储引用。

## 未来

未来 ChangePlan 含 baseRevision、diff、warnings、expiresAt、目标组成摘要；执行时重新检查修订与兼容性，过期/被篡改不得执行。R005/R006 的插件锁版本与升级迁移边界在 M2 记录并细化，不在 M1 证明。
