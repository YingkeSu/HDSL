# Data Model（草案 v0.1）

| 实体 | 字段 | 约束 |
| --- | --- | --- |
| Environment | id, name, revision, activeGenerationId, state | id 为不透明内部 ID；revision 单调递增；name 不作为路径 |
| Generation | id, environmentId, compositionDigest, createdAt | 只属于一个环境；组成固定 |
| CompositionLock | schemaVersion, node, dsh, plugins | 精确版本、来源、摘要、平台；plugins 在首切片为空 |
| RuntimeArtifact | version, platform, arch, url, sha256 | URL 来自受审 catalog；摘要为 64 位十六进制 |
| Operation | id, environmentId, kind, phase, status, error | 状态 queued/running/succeeded/failed/cancelled，终态不可回退 |
| LaunchRecord | operationId, processIdentity, endpoint | 所有权标识不等同 PID；endpoint 只允许 loopback |

Environment 状态：creating → stopped → starting → running → stopping → stopped；失败进入 error，重启先 reconcile 再给出 stopped/running/error。操作失败与环境失败独立，下载失败不可伪造 running。

未来 ChangePlan 含 baseRevision、diff、warnings、expiresAt、目标组成摘要；执行时重新检查修订与兼容性，过期/被篡改不得执行。凭据值不属于任何这些可导出实体。
