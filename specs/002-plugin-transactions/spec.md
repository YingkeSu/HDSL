# 002 插件事务与插件发现（规格）

状态：**进行中（S1 已实现，S2–S4 未实现）**。
契约差异清单的权威出处是 [ADR 0005](../../docs/adr/0005-plugin-contract-evolution.md) §4；本文件只固定 002 的行为边界与实现进度，不复制会漂移的清单。

## 背景与范围

父需求见 GitHub Issue #73。插件能力拆成四个纵向切片：

| 切片 | 内容 | 状态 |
| --- | --- | --- |
| S1（[#75](https://github.com/YingkeSu/HDSL/issues/75)） | 插件发现与详情：GitHub 只读检索闭环 | 已实现（本规格） |
| S2（[#76](https://github.com/YingkeSu/HDSL/issues/76)） | 来源预览、变更计划、安装/卸载事务 | 未实现 |
| S3（[#77](https://github.com/YingkeSu/HDSL/issues/77)） | 卸载保护与生效观测 | 未实现 |
| S4（[#78](https://github.com/YingkeSu/HDSL/issues/78)） | 构建脚本授权 | 未实现 |

**本规格不声明 S2–S4 已实现**，也不把 ADR 的 `preview`/`apply`/`restore` 方法或 kind 加入可调用白名单。
未实现的入口在界面与文档中明确标注为 S2，而不是返回伪造的成功。

## SI：插件发现与详情（已实现）

### 方法

- `plugins.search`：输入 `{ requestId, query }`（`query` 1–256 字符），返回 `OperationRef`。
- `plugins.inspect`：输入 `{ requestId, source: { owner, name, ref? } }`，返回 `OperationRef`。
- 两者是**全局**操作（`environmentId = null`，`operationKind` 为 `search`/`inspect`），
  终态结果经 `OperationSnapshot.output` 读取（`PluginSearchResult` / `PluginInspection`）。
- `link:`/`file:`/本地路径/任意 URL/自由包名在输入层即 `INVALID_INPUT`；产品来源只有公开 GitHub 仓库。

### 行为与验收口径

| 要求 | 口径 |
| --- | --- |
| 精确查询可复制 | `PluginSearchResult.query` 是实际发出的查询字符串，逐字符一致；默认 `topic:dsh-plugin fork:false archived:false` |
| 结果计数语义 | 展示 `totalCount`、`incompleteResults`、`hasMore`；`hasMore` 已考虑 GitHub 检索只返回前 1000 条（`GITHUB_SEARCH_RESULT_LIMIT`），超限时界面说明被截断 |
| 非安全信号 | star/topic 标注为“仅展示，不作为安全或可安装性依据”；界面显示“发现不代表可安装或安全” |
| 详情 | `plugins.inspect` 返回公开仓库元数据；来源预览入口在界面预留，预览本体属 S2 |
| 限流 | 403/429 → `RATE_LIMITED`（`retryable`，携带可机读 `retryAfterSeconds`） |
| 网络失败 | 连接建立前失败 → `NETWORK_UNAVAILABLE`；建立后传输/解析失败 → `DOWNLOAD_FAILED` |
| 取消 | 取消为终态 `cancelled`，无环境或组成副作用；已终态取消 → `CANNOT_CANCEL` |
| 无凭据 | 检索路径不读取、不发送任何 GitHub 凭据（含环境变量） |
| 与环境无关 | 全局检索不受任何环境 `ENVIRONMENT_BUSY` 影响，也不改变环境组成 |

### 实现边界（ADR 0005 D17）

- `contracts`：版本 `1.1`、方法/输入 schema、`PluginSearchResult`/`PluginSearchHit`/`PluginInspection`、
  `OperationSnapshot.output?`、`ContractError.retryAfterSeconds?`、D11 错误码与 dispatcher 的逐 kind `output` 规则。
- `core`：`PluginDiscoveryService` 拥有全局操作生命周期（同一个持久化 `OperationStore`），
  取消为终态、失败映射为受控错误码；不联网、不起子进程。
- `runtime`：`createGitHubPluginSource` 只读适配器（可注入 `fetch`/时钟/超时），错误映射见 D11。
- `main`：组合根注入适配器；preload 白名单自动包含新方法；无通用 `invoke`。
- `renderer`：`发现插件` 页完成查询、结果、计数、详情与 S2 预览占位。

### 测试 seam（ADR 0005 D19）

- 默认 CI：契约 fixture + 受控 `fetch` 替身；不访问真实网络。
- 真实 GitHub 只读探针：显式有界、opt-in，不进默认 CI；本规格不新增仓库/CI gate 名。
- 真实 desktop：浏览器模拟层与 Electron 层分栏记录；本地 fixture 不构成真实 GitHub 链路证据。

## 未决与依赖

- S2 的 home 派生机制、含密文件处理与崩溃恢复是 [#76](https://github.com/YingkeSu/HDSL/issues/76) 的硬门禁（ADR 0005 D18/E10）。
- `--dump-config` 静态性与运行期加载集合的等价性待实证（E9）。
- 真实限流形态、闭包摘要推导与受管 pnpm 身份待实证（E1/E2/E6）。
