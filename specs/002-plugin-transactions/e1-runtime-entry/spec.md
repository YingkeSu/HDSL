# E1（#116）：运行期 entry 的 desired-config 管理边界

状态：**设计 + 可验证的 desired-config 边界已实现；产品级“运行期生效确认”标 blocked**。

基线：`79a15359b5a806fedf467210ca8ad678c8cd11f2`（2026-09-23）。父/关联：[#112](https://github.com/YingkeSu/HDSL/issues/112)、[#111](https://github.com/YingkeSu/HDSL/issues/111)；接口研究前置见 [plugin-runtime-entry-validation.md](../../../docs/development/plugin-runtime-entry-validation.md)。

本文件把 issue #116 的范围、验收口径与已实现边界固定下来。实现候选位于 `packages/runtime/src/plugins/patch-config.ts`，契约见 [contracts.md](contracts.md)，计划见 [plan.md](plan.md)，任务见 [tasks.md](tasks.md)。

## 1. 范围与非目标

**范围**：把 DSH **公开文档化**的 profile patch 文件（`cordis.patch.yml`，根为顶层 YAML 数组）作为**声明面**，提供最薄的 `enable` / `disable` / `config` / `remove` 四类 desired-config 编辑与原子写入。

**非目标**（与 issue 一致）：

- 不使用 loader 内部行 CRUD（`EntryTree` / `EntryGroup.remove` 等）做运行期管理。
- 不使用 `dynamicCordisRunner/*` + `dsh-tool-cordis` 当持久插件管理。
- 不做包依赖 / bundles（B1 #115）、不做版本切换（A2 #114）、不做影响分析。
- 不新增私有 Remote、不伪造 DSH 浏览器会话 / cookie、不新增进程内私有 bridge。
- bundle / 依赖变更**不属于**本边界；它们需要重启（上游 G6）。

## 2. 核心口径：写入成功 = desired config 已保存，不等于 ACTIVE

上游与 #111 第二阶段实测事实：

- `patchReload=live` 时，watcher 重读 profile patch 并热重载；enable / 改 config 可在**同一 PID** 生效（[证据](../../../docs/development/plugin-runtime-entry-validation.md)）。
- 但 ready 后存在**预热窗口**（第一/第二次写入可无效果且无 stderr）；live 回调**吞掉解析错误**（G8）；`pluginInventory/list` 的只读相位需**官方 WebUI 会话**且尚未实证接入。

因此 HDSL **不得**把“文件写入成功”表示为“运行期已生效”。本边界返回：

- `saved: true` —— 原子写入完成；
- `runtime: 'pending'` + `runtimeVerification: 'unavailable'` —— 未观测运行期集合；
- `activation` —— `restart-required` 或 `live-reload-unverified`，两者都不声称 ACTIVE；
- `restartRequired` —— 明确重启 fallback（重启后按同一文件确定性加载）。

**重启 fallback 满足验收**：写入后明确“需重启（或 live 未确认）”，并在 ready 后覆盖预热窗口——HDSL 绝不会在预热期把写入当作已生效的静默成功。

## 3. 合法数组解析与无效 patch 的可解释错误

- 文件必须是**恰好一个** YAML 文档且**顶层为数组**：`[]`（合法空数组）表示“无 overlay”；0 字节 / 仅注释 / 映射根 / **多文档** / `insert` 非序列 → `INVALID_INPUT`，可解释，不静默。多文档必须以错误拒绝，避免只编辑第一个文档而静默丢弃后续文档（数据丢失）。
- 这与“用空文件冒充删除”相反：空删除必须写成合法空数组或删除对应 `insert` 行，而不能是 0 字节文件。
- `insert` 必须是行序列；行必须是映射。身份位置（`id` / `name`）上的**显式 tag / alias / 块标量 / 非字符串**不会被误判为字面包名（与 #107 事实修正、AC4 一致）；`config` 子树里的 `!!js` 等是数据，AST 往返**逐字保留**。
- **行匹配**：仅按行 `id`、按文件顺序跨 `insert` 行与 `- id:` 覆盖行；重复 id 为 last-write-wins（`config` 写最后一个命中项），与 DSH 层合成一致。不匹配 `name`，重复 id + 不同 `name` 不消歧（已知限制，不作安全声明）。
- **原子写与锚定**：唯一公开写入口 `writePatchFileWithinRoot(profileRoot, patchPath, text)` 先做词法包含校验；不可预测临时名 + `O_CREAT|O_EXCL|O_NOFOLLOW` + mode 0600 + file fsync → rename，失败清临时文件，rename 后目录 fsync 按平台能力 best-effort。
- 不把静态影响分析设为本切片门禁。

## 4. 验收映射（issue #116）

| AC | 状态 | 说明 |
| --- | --- | --- |
| 1. live 下写入可被确认，或明确需重启；覆盖预热窗口 | **部分（诚实重启路径）** | 明确 `restart-required` / `live-reload-unverified`，不静默；运行期 ACTIVE 确认 blocked（无可靠公开观测面） |
| 2. 空/非法 patch 为可解释错误；移除行独立验证 | **满足** | `INVALID_INPUT`；合法非空数组移除已同 PID 实测（见验证记录） |
| 3. 只读公开面观测；区分期望配置与实际 ACTIVE；不假定 launcher 会话、不新增私有 bridge | **满足（边界级）** | 本边界只写 desired config，不伪造会话；运行期观测标 blocked |
| 4. 未知/可执行 tag 不误判为字面名；不保留“unknown ⇒ 禁止卸载”政策 | **满足** | `hasExplicitTag` 拒绝身份位置显式 tag；不引入影响分析门禁 |
| 5. 不执行未审第三方/模型代码；内建插件正常执行并显式列出 | **遵守** | 实验只用自建 `node:fs` fixture，无网络/子进程/模型/个人凭据 |
| 6. 不声称仅 loopback | **遵守** | 未用套接字清单证明，文档不声称 |

## 5. 与既有规格的关系

- 本切片复用 [spec.md](../spec.md) 对 rc.2 patch 结构的既有结论（根为序列、`name` 为包引用、`inject` 为服务名）。
- 与 S2/S3 的代际不可变模型不冲突：本边界是**独立于事务**的声明面编辑候选，产品写入目标（profile patch 还是 home 用户 patch）与运行中环境的并发策略属产品接线，见 [plan.md](plan.md) 的 blocked 说明。
- **并发/CAS 本片不解决**：读-改-写无锁，同 id 匹配不区分 `name`；产品接线时必须落实串行化或 revisions CAS，本层不声称并发安全。
