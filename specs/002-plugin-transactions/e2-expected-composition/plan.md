# E2（#118）实施计划

基线 SHA：`ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa`（2026-09-23）。不得回退其他贡献者改动。

## 1. 所有权

| 路径 | 本切片动作 |
| --- | --- |
| `packages/runtime/src/plugins/expected-composition.ts` | **新增** 分组解析 + 受管 `--dump-config` 调用 |
| `packages/runtime/src/install/run-command.ts` | 新增可选 `journalProcess?: boolean`（只读 inspection 不写子进程 journal） |
| `packages/runtime/src/plugins/index.ts` | 导出新模块 |
| `packages/contracts/src/{dto,methods,dispatcher,context}.ts` | 新增 `compositions.expected` + `ExpectedCompositionView` + 操作 kind `composition` |
| `packages/contracts/src/testing/{fixtures,reference-port}.ts` | 契约夹具与参考端口同步 |
| `packages/core/src/{ports,expected-composition-service,contract-port,index}.ts` | 操作生命周期、环境/代际解析、装配 |
| `apps/desktop/src/main/composition.ts` | 注入服务与运行时适配器 |
| `apps/desktop/src/renderer/**` | 只读面板 + 强制文案 + 控制器接线 |
| `specs/002-plugin-transactions/e2-expected-composition/**`、`specs/001-environment-lifecycle/contracts/local-api.md`、`docs/**` | 本切片 spec/契约/计划/任务与验证记录 |
| `tests/plugins/expected-composition.test.ts`、`tests/core/expected-composition.test.ts`、`tests/renderer/expected-composition.test.ts` | **新增** 解析/调用/服务/渲染测试 |

刻意**不触碰**：#114（版本切换）、#7（桌面验收）、#116 的 desired-config 边界、#115 bundles reconcile。

## 2. 已实现步骤

1. **分组解析**：按 `# ==` 段落切分，每段独立单文档/序列解析；前言、非序列根、YAML 错误、缺 id 行均为显式诊断。
2. **`!!js` 不求值**：`!!js`（`tag:yaml.org,2002:js`）与其它非字面 tag、alias、merge key 作为未求值数据保留；`disabled: !!js` 记为未知。
3. **有界**：dump/段落/行/config/诊断/stderr 上限，超限记 `truncated`。
4. **受管调用**：隔离环境、无凭据、无 journal、有界超时/abort、输出上限；拒绝宿主 `process.execPath`。
5. **诚实标签**：终态固定 `basis='dump-config'` / `runtimeVerification='unavailable'`；UI 显示“期望组成（dump）≠ 运行期 ACTIVE”。
6. **运行中拒绝**：running/starting/stopping → `ENVIRONMENT_BUSY`。
7. **契约接线**：方法、操作 kind、输出 schema、参考端口/夹具、`local-api.md` 同步。
8. **UI**：环境页只读面板展示 groups/rows/config/stderr/诊断/bundles/patchReload。
9. **测试**：解析（分组、`!!js`、malformed、stderr、alias/merge、空输入）、服务（终态/失败/取消/守卫/脱敏）、契约路由、渲染（强制文案 + stderr/诊断）。

## 3. 未完成 / blocked（不得伪装成功）

- **运行期 ACTIVE 确认 blocked**：`pluginInventory` 需官方会话，未验证；本切片不新增私有 Remote、不伪造 cookie、不把 dump 描述为 ACTIVE。
- **E9 未证**：dump 与运行期加载集合的等价性未实证；文档只写“离线解析出的期望组合树”。
- Windows/Linux 未测；仅 loopback 未证。
- 读-改-写/并发与本切片无关（本切片不写）。

## 4. 验证命令

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py
# opt-in 真实受管 dump（需受管 rc.2 安装）：
#   HDSL_EXPECTED_COMPOSITION_REAL=1 \
#   HDSL_EXPECTED_COMPOSITION_DSH=<gen>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
#   HDSL_EXPECTED_COMPOSITION_NODE=<gen>/node/bin/node \
#   pnpm exec vitest run tests/plugins/expected-composition.test.ts
```

## 5. 停止条件

实现 + 测试 + 文档 + 真实受管只读验证后停止；不 merge、不自审、不 close、不 tag。
