# E1（#116）任务

基线 `79a15359b5a806fedf467210ca8ad678c8cd11f2`。

| 任务 | 内容 | 状态 |
| --- | --- | --- |
| T-E1-001 | 合法单文档数组解析：恰好一个文档、顶层序列、`[]` 合法；0 字节/映射根/**多文档**/`insert` 非序列 → `INVALID_INPUT` | 完成 |
| T-E1-002 | 行模型：`insert` 行 + `- id:` 覆盖；`id`/`name` 显式 tag/alias 不误判为字面名 | 完成 |
| T-E1-003 | 四类编辑 `enable`/`disable`/`config`/`remove`（AST 原地改，保留注释与 `!!js`；`config` 按文件顺序 last-write-wins 写最后命中项） | 完成 |
| T-E1-004 | 锚定原子写 `writePatchFileWithinRoot`：不可预测 temp + `O_EXCL`/`O_NOFOLLOW` + mode 0600 + fsync/rename + 失败清 temp + 目录 fsync best-effort；写失败 `INTERNAL_ERROR` | 完成 |
| T-E1-005 | 诚实状态：`saved` + `runtime: pending` + `runtimeVerification: unavailable` + `activation`/`restartRequired` | 完成 |
| T-E1-006 | `resolvePatchReloadMode` / `activationOf`（composition ⇒ 重启） | 完成 |
| T-E1-007 | 单元/契约测试 `tests/plugins/patch-config.test.ts`（24 例，含复审回归） | 完成 |
| T-E1-008 | 隔离有界实验：合法非空数组移除，确认同 PID 卸载 | 完成（见 [验证记录](../../../docs/development/plugin-runtime-entry-validation.md)） |
| T-E1-009 | spec/plan/contracts/tasks 文档 + 导航 | 完成 |
| T-E1-013 | `enable` 只 prune 本次清空 `disabled` 的目标 override；`changed`/dirty/`rows()`/落盘一致 | 完成 |
| T-E1-014 | 路径轴定（写路径必须位于 profile 根内），公开写入口单一 | 完成 |
| T-E1-015 | id-only 匹配/`name` 不消歧、无 CAS 的已知限制文档化（不作安全声明） | 完成 |
| T-E1-010 | 产品接线（contracts/preload/main/renderer） | **完成（desired config）**：#135（E1-T1）新增 `entries.patch`（契约 1.2）、core `EntryPatchService`、`createEntryPatchPort`、main composition 与 renderer `EntryPatch` 面板；写入目标严格为环境共享 home 用户 patch，UI 只显示“已保存 / 等待 DSH 应用（未确认 ACTIVE）”并提供显式重启 fallback。**运行期 ACTIVE 确认仍 blocked**（E1b no-go） |
| T-E1-011 | 仅 loopback 证明 | 未测（不声称） |
| T-E1-012 | `pluginInventory` Remote/官方会话接入实证 | 未测 |
