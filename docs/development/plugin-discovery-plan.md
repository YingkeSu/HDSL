# S1 插件发现与详情：实现计划（#75）

状态：本片实现记录。契约权威出处为 [ADR 0005](../adr/0005-plugin-contract-evolution.md) 与
[002 规格](../../specs/002-plugin-transactions/spec.md)。本文件记录 S1 的落地边界、文件所有权与验证口径，
不替代上述设计资料。

## 范围（S1，停条件）

- 用户在桌面界面发起一次固定查询（默认 `topic:dsh-plugin fork:false archived:false`），
  看到仓库列表与详情，可复制与实际请求逐字符一致的精确查询字符串。
- 展示 `totalCount`/`incompleteResults`/`hasMore` 与 GitHub 1000 条结果上限口径。
- star/topic 仅展示，明确不作为安全或可安装性依据；显示“发现不代表可安装或安全”声明。
- 限流（403/429）、网络失败、取消三类失败可解释；取消为终态且无副作用；检索不改变环境组成。
- 检索路径不需要 GitHub 凭据，且与环境 `ENVIRONMENT_BUSY` 无关。
- 详情给出“来源预览入口”，并准确说明预览本体属于 S2、当前不实现（不伪造成功）。

## 明确不做（S2+）

- `changes.preview` / `changes.apply` / `generations.restore`、manifest/脚本解析、
  安装期脚本授权、任意环境组成写入。本片不声明这些能力已实现。

## 文件所有权

| 层 | 文件 |
| --- | --- |
| 契约 | `packages/contracts/src/{version,errors,ids,dto,methods,context,dispatcher,index}.ts`、`testing/{fixtures,reference-port}.ts` |
| 运行时（GitHub 只读适配器） | `packages/runtime/src/plugins/*`、`packages/runtime/src/index.ts` |
| core（组合与操作生命周期） | `packages/core/src/{operation-store,plugin-source,plugin-discovery-service,contract-port,index}.ts`、`tests/integration/plugins/*` |
| main | `apps/desktop/src/main/composition.ts` |
| renderer | `apps/desktop/src/renderer/{view-model,controller,App}.tsx`、`components/PluginDiscovery.tsx`、`format.ts` |
| 测试 | `tests/contracts/*`、`tests/renderer/*`、`tests/desktop/*`、`tests/plugins/*` |
| 文档 | ADR 0005 状态与 D5→D20 文案、`specs/001.../local-api.md` 字面量迁移、`specs/002-plugin-transactions/*`、`docs/README.md` |

## 契约版本与迁移

- `API_VERSION` 由 `1.0` → `1.1`（ADR §5.3/§5.4）。同步迁移：
  - `envelope-minor-mismatch` fixture `'1.1'` → `'1.2'`（只改 minor 行）。
  - `local-api.md` 的 wire 版本字面量与 fixture 表；`desktop-integration.md` 示例。
  - `tests/contracts/consumer-parity.test.ts` 的版本与方法表。
  - `tests/e2e/support/desktop-ui.ts` 的 `CONTRACT_API_VERSION` 改为引用共享 `API_VERSION`；
    `tests/e2e/support/fixtures/sender-frame-{parent,child}.html` 改用 `__HDSL_API_VERSION__`
    占位符，由 E2E 宿主在生成临时页时注入共享版本（当前无 QA owner 修改这些文件，本片承接）。
- 新 surface 只包含 S1 已实现的部分：`plugins.search`、`plugins.inspect`、
  `operationKind` 的 `search`/`inspect`、`OperationSnapshot.output?`、
  `ContractError.retryAfterSeconds?`、D11 的 15 个新错误码。
  `preview`/`apply`/`restore` 方法与 kind 由 S2+ 在同一未打标签的 1.1 内补齐（ADR §5.4 允许中间构建）。

## 测试 seam

- 默认 CI：契约 fixture + 受控 `fetch` 替身（无真实网络）。
- 真实 GitHub 只读探针：显式有界、不进默认 CI；本片不新增仓库/CI gate 名。
- 真实 desktop 验证：按 [测试指南](testing.md) 分别记录浏览器模拟层与 Electron 层，未测项保持未测。
