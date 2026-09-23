# E1（#116）实施计划

基线 SHA：`79a15359b5a806fedf467210ca8ad678c8cd11f2`（2026-09-23）。不得回退其他贡献者改动。

## 1. 所有权

| 路径 | 本切片动作 |
| --- | --- |
| `packages/runtime/src/plugins/patch-config.ts` | **新增** desired-config 边界与原子写 |
| `packages/runtime/src/plugins/index.ts` | 导出新模块 |
| `packages/runtime/src/plugins/patch-references.ts` | 只读复用其 bounds 常量，不改语义 |
| `tests/plugins/patch-config.test.ts` | **新增** 单元/契约测试 |
| `scripts/research/e1-patch-removal-probe.sh` | **新增** 隔离有界移除实验 |
| `specs/002-plugin-transactions/e1-runtime-entry/**` | 本切片 spec/plan/contracts/tasks |
| `docs/development/plugin-runtime-entry-validation.md` | 实验与验证记录 |
| `packages/core/src/**`、`apps/desktop/src/renderer/**` | **未改动**（产品接线 blocked，见 §4） |

刻意**不触碰**：#113 版本发现、#115 包依赖、#108 进程状态、PR109/110、#97。

## 2. 已实现步骤

1. **合法数组解析**：`PatchConfigDocument.parse` 要求顶层序列；`[]` 合法；0 字节 / 映射根 / 多文档 / `insert` 非序列 → `INVALID_INPUT`。
2. **行模型**：`insert` 行与 `- id:` 覆盖行统一为 `PatchRowView`；`id`/`name` 只接受**无显式 tag** 的普通标量。
3. **四类编辑**：`enable` / `disable` / `config` / `remove`，基于 yaml AST 原地修改后 `toString()`，保留注释与 `!!js` 等未触碰内容。
4. **原子写**：temp → fsync → rename。写失败 → `INTERNAL_ERROR`，不产生半成品。
5. **诚实状态**：`saved` + `runtime: pending` + `runtimeVerification: unavailable` + `activation` / `restartRequired`。
6. **reload 解析**：`resolvePatchReloadMode` 只接受显式 `live` / `startup`，否则 `unknown`（→ 重启）。
7. **测试**：`tests/plugins/patch-config.test.ts` 17 例。
8. **实验**：合法非空数组移除，同 PID 卸载（详见验证记录）。

## 3. 明确的重启语义

- `activationOf('patch-entry', 'live')` = `live-reload-unverified`（文件已存，预计热加载，但无法确认 ACTIVE）。
- `activationOf('patch-entry', 'startup'|'unknown')` = `restart-required`。
- `activationOf('composition', *)` = `restart-required`（bundle / 依赖变更，上游 G6 启动快照）。
- 任何情况下 `restartRequired` 都为用户提供确定性 fallback。

## 4. 未完成 / blocked（不得伪装成功）

**Blocked：产品级运行期生效确认。** 没有已验证的公开运行期确认 API：

- `pluginInventory/list` 的 `fiberPhase` 是公开只读信号，但每次 RPC 需官方浏览器会话；HDSL 尚未核实 launcher 本地 UI 与 DSH WebUI 的 origin/cookie 归属。
- 因此**不实现**私有 Remote、不伪造 cookie、不在主进程假装观测到 ACTIVE。
- 未把本边界接入 `contracts` / preload / renderer；在运行期确认方案通过验证前，接线属 blocked。
- `setConfig` 替换整行 `config`（与 DSH 整行替换语义一致），不做深合并；对同一 `id` 的重复行按“最后一个命中行”处理（last-write-wins），未新增去重门禁。

**未实测**：仅 loopback 未证；`pluginInventory` Remote/会话接入未验；Windows/Linux 未测。

## 5. 验证命令

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py
# opt-in 实验（需要受管 0.1.5-rc.2 + Node 22.19.0）：
#   scripts/research/e1-patch-removal-probe.sh <generation-directory>
```

## 6. 停止条件

交付实验 + 可执行的 desired-config 边界 + 文档后停止；不 merge、不自审、不 close、不 tag。是否开 PR 由“AC 是否可满足”决定（见 spec §4；blocked 项意味着产品级 AC1 仍未满足，故仅本地交付）。
