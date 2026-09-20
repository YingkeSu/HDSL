# 本地 API 契约 v0.2（草案）

实现位置计划为 preload 白名单桥，非任意 HTTP 远程控制接口。main 必须校验发送方和所有输入；TypeScript 类型不替代运行时校验。DTO 的权威字段定义与修订语义见 [data-model.md](../data-model.md)，本文件只定义调用方法、幂等、错误与事件语义。

本契约是实施前修订（2026-09-20），用于在 T001 证据补齐、T003 动工前冻结共享面。上游参数与真实平台验证尚未全部通过，本版本不声称任何业务实现或实机验收已完成。

## 契约版本

- 导出常量 `API_VERSION = "1.0"`（`major.minor`），位于 `packages/contracts/src`，renderer 与 main 共用同一构建产物。
- 每个请求与响应包络都携带 `apiVersion`。main 在产生任何副作用前比对：
  - major 不一致 → 拒绝，错误码 `CONTRACT_VERSION_MISMATCH`，不执行方法；
  - renderer 的 minor 高于 main（main 较旧）→ 允许调用，但未知字段仍严格拒绝；
  - 差异场景必须在 T003 的「方法 × 合法/非法 fixture × 期望错误码」表中逐条固化。
- 版本升级是显式变更并更新本文件；不得静默放宽字段或错误语义。

## 通用规则

- 请求包含 `requestId`（不透明字符串，长度受限），修改类方法包含 `expectedRevision`（`environments.create` 除外）。
- 幂等：相同 `requestId` + 相同方法 + 相同参数返回原结果，不重复副作用；相同 `requestId` 但参数不同 → `IDEMPOTENCY_CONFLICT`。幂等记录在操作日志持久化，保存期限至少覆盖操作与重试窗口，具体策略在实现规格锁定。
- 未知 `environmentId`/`operationId`/`subscriptionId` → `NOT_FOUND`，不得退化为创建或静默成功。
- `expectedRevision` 是**组成修订**，语义见 [data-model.md](../data-model.md)；不匹配 → `REVISION_CONFLICT`，不产生副作用。状态迁移由独立的 `stateVersion` 表示，不作为修改类方法的准入条件。
- 成功 `{ ok: true, apiVersion, value }`；失败 `{ ok: false, apiVersion, error: { code, message, retryable, operationId? } }`。不暴露栈、密钥、token、cookie 或任意本地路径。
- 输入结构严格拒绝未知字段、超长文本和非法 ID。

## 秘密边界（与上游真实行为协调）

- **受管用户 API 凭据**：由 main 的凭据适配器按 OS 凭据存储（keychain/credential manager）**引用**解析，在启动受管 DSH 时注入显式进程环境（对应 FR-003/FR-007）。凭据值不写入环境目录、操作日志、诊断导出、整合包或 Git。
- **上游生成的短期 Web secret**：DSH 首次 `web` 启动会在环境 home 写 `.credentials.yaml`（权限 0600，内含 Web 会话 grant secret）并在 `logs/` 写启动诊断。因此 HDSL 把环境 home 整体视为**含密目录**：不进入整合包、导出与普通日志，不跨环境复制，导出前脱敏。契约**不承诺上游不落盘凭据文件**；FR-007 的验收覆盖这两类，不把“上游不落盘”当作前提。

## 方法

| 方法 | 输入 | 返回 | 约束 |
| --- | --- | --- | --- |
| catalog.list | 无 | 已核验 RuntimeCombination[] | 含平台、来源与兼容证据；未核验组合不出现在列表 |
| environments.list | 无 | EnvironmentSummary[] | 只读摘要，不含秘密与本地路径 |
| environments.create | requestId, name, catalogCombinationId | OperationRef | name 1–80 字符；`catalogCombinationId` 必须映射到 CompositionLock；平台必须匹配 |
| environments.start | requestId, environmentId, expectedRevision | OperationRef | 重复启动不重复进程；组合修订变化则拒绝 |
| environments.stop | requestId, environmentId, expectedRevision | OperationRef | 仅终止自己拥有的进程；重复停止幂等 |
| environments.openWebUI | requestId, environmentId | OpenWebUIResult | 仅 main 原生打开属于当前受管进程的已验证 loopback endpoint；renderer 不接收携带 token 的 URL |
| operations.get | operationId | OperationSnapshot | 支持查询最终状态；重连后以此为准 |
| operations.cancel | requestId, operationId | OperationSnapshot | 尽力取消；提交后返回 CANNOT_CANCEL |
| operations.subscribe | requestId, operationId? | SubscriptionRef | 建立 `operation.updated` 推送；省略 operationId 表示订阅该窗口全部操作 |
| operations.unsubscribe | requestId, subscriptionId | void 结果 | 退订后不再推送；未知 subscriptionId → NOT_FOUND |
| diagnostics.export | requestId, environmentId | ExportResult | 由 main 原生选择路径并脱敏；幂等，失败返回 EXPORT_FAILED |

`OpenWebUIResult` 只返回 `{ opened: boolean, loopbackOrigin? }`；`loopbackOrigin` 为 `http(s)://127.0.0.1:<port>` 或 `[::1]` 形式，**不含 token、cookie 或查询串**。main 必须在打开前核对 `LaunchRecord.endpoint` 属于该环境的当前受管进程，且地址为 loopback；否则返回 `WEBUI_UNAVAILABLE`。

## 事件

事件通道 `operation.updated` 由 `operations.subscribe` 建立，携带：`subscriptionId`、`operationId`、递增 `sequence`、`phase`、`status`、`progress?`。百分比未知时不给假进度；事件不含 token、cookie 或本地路径。客户端重连以 `operations.get` 为准；取消不等于系统回滚。preload 白名单只暴露上述订阅/退订方法，不暴露任意通道发送。

## 错误码

| code | 语义 |
| --- | --- |
| INVALID_INPUT | 缺字段、类型错误、未知字段、超长文本或非法 ID |
| NOT_FOUND | 未知 environmentId/operationId/subscriptionId |
| IDEMPOTENCY_CONFLICT | 相同 requestId 携带不同参数 |
| CONTRACT_VERSION_MISMATCH | apiVersion major 不兼容 |
| UNSUPPORTED_COMBINATION | 组合未核验；覆盖不支持平台（含 Windows 未验证平台） |
| REVISION_CONFLICT | expectedRevision 与当前组成修订不一致 |
| ENVIRONMENT_BUSY | 环境运行中或存在并发修改事务 |
| WEBUI_UNAVAILABLE | 环境非 running，或 endpoint 不属于当前受管进程 / 非 loopback |
| DOWNLOAD_FAILED | 下载失败，可重试 |
| DIGEST_MISMATCH | 摘要与受审 catalog 不符 |
| DISK_FULL | 磁盘不足 |
| START_TIMEOUT | 就绪超时 |
| PORT_UNAVAILABLE | 端口冲突 |
| PROCESS_EXITED | 受管进程意外退出 |
| CANNOT_CANCEL | 操作已提交，无法取消 |
| EXPORT_FAILED | 诊断导出失败，未产出可用文件 |
| INTERNAL_ERROR | 未分类内部错误，message 需脱敏 |

## 后续接口预留

插件与升级采用 changes.preview / changes.apply，恢复采用 generations.restore；pack.inspect / pack.import / pack.export 在 003 规格中定义。当前未定义输入结构，不将它们暴露为可调用 API。Registry 与小程序接口须另设版本化规格。
