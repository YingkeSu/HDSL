# Data Model（草案 v0.2）

实施前修订（2026-09-20）：补齐契约引用的 DTO、修订语义、摘要规范与凭据边界。字段为权威定义；调用方法与错误码见 [contracts/local-api.md](contracts/local-api.md)。

## 实体

| 实体 | 字段 | 约束 |
| --- | --- | --- |
| Environment | id, name, revision, stateVersion, activeGenerationId, state | id 为不透明内部 ID；name 不作为路径；见下方修订语义 |
| EnvironmentSummary | id, name, revision, stateVersion, state, activeGenerationId, compositionDigest | `environments.list` 的只读视图；不含秘密、token 或本地路径 |
| Generation | id, environmentId, compositionDigest, createdAt | 只属于一个环境；组成固定 |
| CompositionLock | schemaVersion, node, dsh, plugins | node/dsh 为 RuntimeArtifact 引用；精确版本、来源、摘要、平台；plugins 在首切片为空 |
| RuntimeCombination | id, platform, arch, node, dsh, compatibility | `catalog.list` 的返回项；compatibility 至少含 status 与 evidenceRef，未核验组合不入列表 |
| RuntimeArtifact | version, platform, arch, url, sha256 | URL 来自受审 catalog；sha256 为 64 个十六进制字符（256 位，小写） |
| Operation | id, environmentId, kind, phase, status, sequence, error | 状态 queued/running/succeeded/failed/cancelled，终态不可回退；sequence 单调递增 |
| LaunchRecord | operationId, environmentId, processIdentity, endpoint, createdAt | processIdentity 为所有权标识，不等同 PID；endpoint 只允许 loopback，且必须归属该环境当前受管进程 |
| CredentialReference | id, store, key | 仅指向 OS 凭据存储；不含凭据值，不进入任何导出/打包实体 |

## 契约引用映射

- `catalogCombinationId` 是 RuntimeCombination.id。`environments.create` 用它选定组合，并在创建时将其解析为一个不可变 CompositionLock 写入新 Generation；后续启动、摘要计算都以 CompositionLock 为准，不再重新解析 catalog。
- `EnvironmentSummary.compositionDigest` 等于 `activeGenerationId` 对应 Generation.compositionDigest；无活动代际时为 null。
- `OperationRef` 为 `{ operationId }`；`OperationSnapshot` 在 Operation 基础上含最终 `error` 与 `progress?`；`SubscriptionRef` 为 `{ subscriptionId }`；`ExportResult` 为 `{ exported: boolean, redacted: true }`，不含导出路径。

## 修订语义（revision / stateVersion）

- `revision`：**组成修订**。仅在创建环境、以及活动代际指针成功切换（未来变更/恢复提交）时递增。它回答“组成是否变化”。
- `stateVersion`：**状态修订**。每次状态迁移（stopped→starting→running→stopping→stopped、失败进入 error 等）递增。它回答“状态视图是否过期”。
- 修改类方法的 `expectedRevision` 校验的是 `revision`，因此单纯启停**不**改变 `revision`，客户端无需在每次启停后重读修订；状态变化通过 `stateVersion` 与 `operation.updated` 感知。
- 任一计数器只增不减；不得用时间戳或 PID 冒充修订号。

## 组成摘要（compositionDigest）规范

- 输入是 CompositionLock 的**规范化 JSON**：键按 UTF-8 字节序升序、无多余空白、字符串 UTF-8、数组保持语义顺序（插件按已定义排序键排序）、包含 `schemaVersion`。
- 摘要在平台无关的规范化字节上计算：`SHA-256`，输出 64 个小写十六进制字符。
- 相同语义输入跨平台必须得到同一摘要；T004 必须包含跨平台稳定性测试。来源 URL 与摘要一并记录，但摘要只覆盖组成内容，不覆盖下载位置。

## 状态机与运行数据

Environment 状态：creating → stopped → starting → running → stopping → stopped；失败进入 error，重启先 reconcile 再给出 stopped/running/error。操作失败与环境失败独立，下载失败不可伪造 running。

## 凭据边界

- 受管用户 API 凭据只以 CredentialReference 形式存储，由启动时解析并注入显式进程环境，不写入上述任何可导出实体。
- 上游 DSH 会在环境 home 生成 `.credentials.yaml`（0600，Web 会话 grant secret）与 `logs/` 诊断。环境 home 因此整体视为含密目录：不进入整合包、导出、普通日志与 Git，不跨环境复制。数据模型不假设上游从不写凭据文件。

## 未来

未来 ChangePlan 含 baseRevision、diff、warnings、expiresAt、目标组成摘要；执行时重新检查修订与兼容性，过期/被篡改不得执行。R005/R006 的插件锁版本与升级迁移边界在 M2 记录并细化，不在 M1 证明。
