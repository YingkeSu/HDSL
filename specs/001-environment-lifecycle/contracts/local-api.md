# 本地 API 契约草案 v0.1

实现位置计划为 preload 白名单桥，非任意 HTTP 远程控制接口。main 必须校验发送方和所有输入；TypeScript 类型不替代运行时校验。

## 通用规则

请求包含 `requestId`，修改包含 `expectedRevision`（创建除外）。相同 requestId + 相同参数返回原操作；相同 ID 不同参数拒绝。幂等记录在操作日志持久化；保存期限至少覆盖操作与重试窗口，具体策略在实现规格锁定。
成功 `{ ok: true, value }`；失败 `{ ok: false, error: { code, message, retryable, operationId? } }`。不暴露栈、密钥、任意本地路径。输入结构严格拒绝未知字段、超长文本和非法 ID。

| 方法 | 输入 | 返回 | 约束 |
| --- | --- | --- | --- |
| catalog.list | 无 | 已核验 RuntimeCombination[] | 含平台、来源与兼容证据 |
| environments.list | 无 | EnvironmentSummary[] | 不含秘密 |
| environments.create | requestId, name, catalogCombinationId | OperationRef | name 1–80 字符，平台必须匹配 |
| environments.start | requestId, environmentId, expectedRevision | OperationRef | 重复启动不重复进程 |
| environments.stop | requestId, environmentId, expectedRevision | OperationRef | 仅终止自己拥有的进程 |
| operations.get | operationId | OperationSnapshot | 支持查询最终状态 |
| operations.cancel | requestId, operationId | OperationSnapshot | 尽力取消；提交后返回 CANNOT_CANCEL |
| diagnostics.export | environmentId | ExportResult | 由 main 原生选择路径并脱敏 |

事件 `operation.updated` 带 operationId、递增 sequence、phase、status、progress?；百分比未知时不给假进度。客户端重连以 operations.get 为准；取消不等于系统回滚。

## 错误码

INVALID_INPUT、UNSUPPORTED_COMBINATION、REVISION_CONFLICT、ENVIRONMENT_BUSY、DOWNLOAD_FAILED、DIGEST_MISMATCH、DISK_FULL、START_TIMEOUT、PORT_UNAVAILABLE、PROCESS_EXITED、CANNOT_CANCEL、INTERNAL_ERROR。

## 后续接口预留

插件与升级采用 changes.preview / changes.apply，恢复采用 generations.restore；pack.inspect / pack.import / pack.export 在 003 规格中定义。当前未定义输入结构，不将它们暴露为可调用 API。Registry 与小程序接口须另设版本化规格。
