# E1（#116）运行期 entry 验证记录

范围：本记录只对**下列精确版本/平台/条件**有效。它不是桌面验收、不是安全认证、也不是 E9（离线组合树 == 运行期加载集合）等价性证明。历史计数与 SHA 不自动跟随当前提交。

- 上游版本：受管 `@deepseek-ai/dsh@0.1.5-rc.2`（tag `dsh-v0.1.5-rc.2` = `fb2c4b9e698e30edb738bca4cf0618587db7d203`），cordis `4.0.2` / cordis-plugin-loader `1.0.3`。
- 运行时：Node `22.19.0`（受管/隔离副本）。
- 方式：隔离自有 `HOME`/`DSH_HOME`/`TMPDIR`，`DSH_TELEMETRY_DISABLED=1`；无网络、无第三方代码、无模型、无个人凭据。
- 前置实验：[#111 第二阶段评论 5790424872](https://github.com/YingkeSu/HDSL/issues/111#issuecomment-5790424872)。

## 1. 补做的实验：合法非空数组的移除（#116 硬前置）

### 1.1 为什么必须补

#111 第二阶段“移除行”步骤把 profile patch **截断为 0 字节**。0 字节不是合法 patch（`parsePatchList` 要求顶层数组），写入落在被吞掉的错误路径（G8），行**未卸载**。因此“由 patch 移除行”当时**未真正验证**。

本实验只补这一步：用**合法且仍然非空**的顶层数组移除一行，保留一个兄弟行，确认在**同一 PID** 内卸载。

### 1.2 脚本与安全边界

`scripts/research/e1-patch-removal-probe.sh`（opt-in，不进默认 CI）：

1. `--dump-config` 离线初始化 profile（`17072 B`，stderr 0，`patchReload=live`）；
2. 自建可逆 fixture（只 `import node:fs`/`node:path`；apply 写自己的 marker，`ctx.effect` 内 dispose 删除 marker 并记事件）；
3. 启动 DSH，等待 `dsh web: http://127.0.0.1:<port>` ready 行；
4. 写入合法非空数组 `- insert: [row-a, row-b]`，轮询直到两行都加载（覆盖预热窗口）；
5. 改写为合法非空数组 `- insert: [row-b]`（移除 `row-a`，保留 `row-b`）；
6. 观察 `row-a` 的 dispose + marker 删除、`row-b` 仍在、DSH PID 不变；
7. 有界 SIGTERM → SIGKILL，检查 0 残留。

无网络、无子进程、无模型、无个人凭据；fixture 只读写自己的临时目录。

### 1.3 结果（两次独立运行，均 PASS）

| 运行 | 时间 (UTC) | ready | DSH PID | 加载尝试/耗时 | 移除结果 | 残留 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-09-23T07:02:27Z | `127.0.0.1:58938` | 2078 | attempts=5 | `row-a` unloaded=yes，`row-b` kept，same_pid=yes | 0 |
| 2 | 2026-09-23T07:03:02Z | `127.0.0.1:59274` | 6000 | attempts=1 / 1s | `row-a` unloaded=yes，`row-b` kept，same_pid=yes | 0 |

运行 2 的事件日志（脱敏，`$HDSL_E1_EVIDENCE_DIR/events.log`）：

```text
{"event":"load","marker":"a","token":"6000-…","pid":6000}
{"event":"load","marker":"b","token":"6000-…","pid":6000}
{"event":"dispose","marker":"a","token":"6000-…","pid":6000}
```

- `row-a` 只有 `dispose`，`row-b` 没有中途 `dispose` ⇒ 移除精确作用于目标行。
- 实验结束时对进程 SIGTERM，`row-b` 随后 dispose（收尾），不属于实验中的移除。
- 写入的最终 patch 仍为合法非空数组（92 B）：

```yaml
- insert:
    - id: e1-row-b
      name: e1-removal-fixture
      config:
        marker: b
```

### 1.4 结论与边界

- **通过**：在 `patchReload=live` 下，用合法非空顶层数组移除一行，可在**同一 PID** 内卸载；兄弟行保留。
- 与第一阶段一致：**bundle/依赖变更仍需重启**（上游启动快照）。
- **预热窗口真实存在且不确定**：运行 1 首次写入被忽略（约 5 次重写后才生效），运行 2 首次即生效。⇒ 实现**不得假设 ready 即可热改**，必须明确“未确认/需重启”。
- 未证：仅 loopback（未用套接字清单证明）；`pluginInventory` 的 Remote/官方会话接入。
- 证据目录（本机临时，未入库）：`$TMPDIR/hdsl-e1-removal-xsNql6/`（`console.txt` sha256 `525c5aef6315e1a43f6eb335e0618a14afcd9ec46dc3580de9c7d8d2e94e7e51`）。

## 2. desired-config 边界验证（默认 CI）

`packages/runtime/src/plugins/patch-config.ts` + `tests/plugins/patch-config.test.ts`（24 例）：

- 合法单文档数组解析：`[]` 合法；0 字节 / 映射根 / 非法 YAML / **多文档** / `insert` 非序列 → `INVALID_INPUT`（多文档拒绝，避免编辑后静默丢弃后续文档）。
- 身份位置显式 tag（`name: !!js …`）不被当作字面包名；`config` 内 `!!js` 在编辑无关行时逐字保留。
- `enable` / `disable` / `config` / `remove` 语义与 `NOT_FOUND` / `INVALID_INPUT`；`config` 按文件顺序 last-write-wins（含 insert + 后续 override）；`enable` 只 prune 本次清空的 `id`-only 目标 override，不误删无关 override/注释；`changed`/dirty/`rows()`/落盘一致。
- 锚定原子写 `writePatchFileWithinRoot`：越界路径拒绝；0600；符号链接不被 follow；无临时文件残留；`applyPatchOperation` 返回 `saved` + `runtime: pending` + `runtimeVerification: unavailable` + `activation`。

复审修复轮（hdsl-54 CHANGES_REQUESTED @ `2e5ca33`）覆盖：#1 多文档拒绝、#2 insert+override 同 id `config` last-write-wins、#3 最小化 prune、#4 dirty 一致性、#5 原子写安全（O_EXCL/O_NOFOLLOW/0600/清 temp）、#6 写路径锚定。

运行：

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py
```

## 3. 未测 / blocked

- **运行期 ACTIVE 确认 blocked**：无经验证的公开只读确认面；`pluginInventory/list` 需官方 WebUI 会话，HDSL 不伪造会话、不新增私有 bridge。E1b 已把该结论查实并给出精确证据：见 [E1b 调查](../research/e1b-runtime-confirmation-investigation.md)（no-go：Remote-only + 每条 RPC 需浏览器会话；HDSL 从不把 DSH WebUI 载入自己的窗口，renderer 为 `file://`，对 `/api` 请求被 403；即便自铸会话，inventory 只有 `entryId/moduleName/enabled/fiberPhase`，无法确认 config 变更）。
- **“预热窗口”归因修正**：E1b 复现表明先前观察到的“ready 后约 12s 预热”主要不是 HMR 预热，而是**非原子写（截断+写）与 watcher 的竞态**：截断瞬间被 `parsePatchList` 视为非法数组，refresh 失败只进 in-process 事件（`hmr/config-update-failed`），launcher 无任何可见信号。改用原子 temp+rename 后，Node 24.21.0 与 25.6.1 均在首次原子写（0s / attempts=1）内应用。这印证 AC1 的原子写约束；产品口径不变（写成功仍不得声称 ACTIVE）。详见 [E1b 调查 §5.1](../research/e1b-runtime-confirmation-investigation.md)。
- 未接入 `contracts`/preload/renderer（产品接线 blocked，见 [plan.md](../../specs/002-plugin-transactions/e1-runtime-entry/plan.md) §4）。
- 仅 loopback 未证；Windows/Linux 未测。
