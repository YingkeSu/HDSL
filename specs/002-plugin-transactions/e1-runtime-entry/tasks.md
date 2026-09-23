# E1（#116）任务

基线 `79a15359b5a806fedf467210ca8ad678c8cd11f2`。

| 任务 | 内容 | 状态 |
| --- | --- | --- |
| T-E1-001 | 合法数组解析：顶层序列、`[]` 合法、0 字节/映射根/`insert` 非序列 → `INVALID_INPUT` | 完成 |
| T-E1-002 | 行模型：`insert` 行 + `- id:` 覆盖；`id`/`name` 显式 tag/alias 不误判为字面名 | 完成 |
| T-E1-003 | 四类编辑 `enable`/`disable`/`config`/`remove`（AST 原地改，保留注释与 `!!js`） | 完成 |
| T-E1-004 | 原子写（temp→fsync→rename）；写失败 `INTERNAL_ERROR` | 完成 |
| T-E1-005 | 诚实状态：`saved` + `runtime: pending` + `runtimeVerification: unavailable` + `activation`/`restartRequired` | 完成 |
| T-E1-006 | `resolvePatchReloadMode` / `activationOf`（composition ⇒ 重启） | 完成 |
| T-E1-007 | 单元/契约测试 `tests/plugins/patch-config.test.ts`（17 例） | 完成 |
| T-E1-008 | 隔离有界实验：合法非空数组移除，确认同 PID 卸载 | 完成（见 [验证记录](../../../docs/development/plugin-runtime-entry-validation.md)） |
| T-E1-009 | spec/plan/contracts/tasks 文档 + 导航 | 完成 |
| T-E1-010 | 产品接线（contracts/preload/renderer）与运行期 ACTIVE 确认 | **blocked**（无经验证的公开只读确认面；见 [plan.md](plan.md) §4） |
| T-E1-011 | 仅 loopback 证明 | 未测（不声称） |
| T-E1-012 | `pluginInventory` Remote/官方会话接入实证 | 未测 |
