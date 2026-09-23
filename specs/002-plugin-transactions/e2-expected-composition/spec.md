# E2（#118）：只读期望组成查看（期望 ≠ 运行期 ACTIVE）

状态：**已实现（默认 CI 内可验证）；运行期 ACTIVE 集合确认仍标 blocked**。

基线：`ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa`（2026-09-23）。父/关联：[#112](https://github.com/YingkeSu/HDSL/issues/112)、[#117](https://github.com/YingkeSu/HDSL/issues/117)、[#111 comment 5790424872](https://github.com/YingkeSu/HDSL/issues/111#issuecomment-5790424872)；desired-config 边界见 [E1](../e1-runtime-entry/spec.md)。

本文件固定 issue #118 的范围、口径与验收。实现候选：`packages/runtime/src/plugins/expected-composition.ts`（调用 + 解析）、`packages/core/src/expected-composition-service.ts`（操作生命周期与装配）、契约见 [contracts.md](contracts.md)、计划见 [plan.md](plan.md)、任务见 [tasks.md](tasks.md)。

## 1. 范围

只读**期望组成**查看：

- 离线运行受管 `dsh --profile <p> --dump-config`（不执行插件代码）；
- 解析分组 `# == <label>` YAML 为 `(id, name, disabled, config?)` 行集合，并展示 `bundles` / `patchReload` 元信息；
- UI 文案必须写明 **“期望组成（dump）≠ 运行期 ACTIVE”**；
- stderr 警告与解析失败**如实显示**（脱敏后），不静默。

## 2. 非目标

- **不做 ACTIVE 集合确认**（`pluginInventory` 会话接入未验证，见 #117）；本切片不新增私有 Remote、不伪造 DSH 会话/cookie。
- 不做写入 / entry 变更（[#116](../e1-runtime-entry/spec.md)）、不做包/版本变更、不做影响分析、不做插件安全认证、不做静态卸载门禁。
- 不把 `--dump-config` 与运行期加载集合的等价性（E9）声称为已证。

## 3. 核心口径

1. **分组非单文档**：`--dump-config` 输出是若干 `# == <label>` 段落的拼接，不是单一逻辑文档。解析器按段落切分，每段独立做**恰好一个** YAML 文档、顶层为序列的解析；无头前言、非序列根、YAML 错误 → 显式诊断，不静默丢弃。
2. **`!!js` 逐字保留、不求值**：`!!js`（`yaml` 解析为 `tag:yaml.org,2002:js`）与其它非字面 tag、alias、merge key 都作为**未求值数据**保留在 config 原文里；`disabled: !!js …` 表示为“未知”，不猜测布尔值。HDSL 绝不 `eval`/执行这些表达式，也不 resolve alias。
3. **诚实标签**：终态 `ExpectedCompositionView` 固定 `basis: 'dump-config'` 与 `runtimeVerification: 'unavailable'`，且 UI 必须显示“期望组成（dump）≠ 运行期 ACTIVE”。这使视图**不可能**被读成运行期 ACTIVE 插件集合。
4. **边界与隔离**：调用只使用该代际的受管 Node + DSH 入口，环境为隔离的 `HOME`/`DSH_HOME`/`TMPDIR`/`PATH`，不注入任何凭据变量，不继承宿主环境；使用文档化 CLI，不新增私有 bridge。
5. **运行中拒绝**：`--dump-config` 会重写该 profile 的派生 `cordis.yml`（ADR 0006 明确其为 live 派生状态，不进入代际身份）。running/starting/stopping 的环境一律 `ENVIRONMENT_BUSY`，避免影响活动进程。
6. **有界**：dump 原文、段落数、行数、config 原文、诊断数与 stderr 均有上限；超限以 `truncated` 诊断显式表示，绝不静默截断。

## 4. 验收映射（issue #118）

| AC | 状态 | 说明 |
| --- | --- | --- |
| 1. 受管安装上离线取得 dump，解析为行集合，明确显示“期望组成 ≠ ACTIVE” | **满足** | 运行时适配器 + 解析器 + UI；见 [验证记录](../../../docs/development/expected-composition-validation.md) |
| 2. 解析失败 / stderr 警告可解释、不静默；不执行插件代码、不使用凭据 | **满足** | 诊断 + stderr 原文（脱敏）；隔离环境无凭据 |
| 3. 记录命令、平台与结果；未验证平台保持未测 | **满足** | 见验证记录；Windows/Linux 未测 |

## 5. 明确排除

- 不提供 ACTIVE 集合、`fiberPhase`、会话接入。
- 不编辑 `cordis.patch.yml` / `package.json` / `pnpm-lock.yaml`。
- 不做包/版本管理，不做 E9 等价性声明。
