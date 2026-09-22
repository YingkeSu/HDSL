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
| 详情 | `plugins.inspect` 返回公开仓库元数据；详情面板展示检索命中元数据，并提供按钮按 `plugins.inspect` 重新获取权威仓库详情；来源预览入口在界面预留，预览本体属 S2 |
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
- `renderer`：`发现插件` 页完成查询、结果、计数、详情与 S2 预览占位；选中命中后可按 `plugins.inspect` 重新获取详情，并对展示文本做转义（无 `dangerouslySetInnerHTML`）。

### 测试 seam（ADR 0005 D19）

- 默认 CI：契约 fixture + 受控 `fetch` 替身；不访问真实网络。
- 真实 GitHub 只读探针：显式有界、opt-in，不进默认 CI；本规格不新增仓库/CI gate 名。
- 真实 desktop：浏览器模拟层与 Electron 层分栏记录；本地 fixture 不构成真实 GitHub 链路证据。
  E2E harness（`tests/e2e/support/desktop-ui.ts` 与 `sender-frame-*.html` fixtures）使用共享
  `API_VERSION`（fixtures 通过版本占位符注入），避免版本硬编码漂移。

## S3：卸载、内置保护与合法保留（#77）

- rc.2 `cordis.patch.yml` 结构（真实受管安装样本 + dsh-base 注释）：**根为序列**，条目 `- insert: [ {id, name, disabled?, config?} ]` 与 `- id: X` 行覆盖；`name` 是**包引用**，`id` 是 profile 内的行身份；`inject` 是 **Cordis 服务名**（`webStartup`/`loader`/`acpAppStartup`/…），不是包引用。
- **可静态判定并拦截**（`REFERENCED_BY_OTHER`，`blockingReferences` 带来源；detail 为安全标识，不含本地绝对路径）：其它源 insert 行 `name` == 被移除包；其它源以 `- id: X` 行覆盖命中被移除插件 insert 的 `rowIds`。`insert` 值不是行序列、行不是映射、缺标量 `id`、`name` 为 block scalar 或非字符串、别名/merge key/显式 tag、多文档、根既非序列也非映射、超尺寸/节点/深度 → **unknown ⇒ 阻塞**（宁过报不漏报、无解析能力不降级为"无引用"）。
- **可静态判定并拦截**（已实现）：其它源 insert 行 `name` == 被移除包；其它源行覆盖（`- id: X`）命中被移除插件 insert 的 `rowIds`；其它源 insert 了与之一致的行 `id`（`last-write-wins`）。
- **服务级耦合（判定口径：ADR 0005 D21）**：固定 rc.2 **无声明性 service provider/consumer 映射**（提供方在代码里）。采用 HDSL 命名空间受限声明 + HDSL 核验记录：`knownProviders(被移除插件) ∩ 保留 patch consumers` → `REFERENCED_BY_OTHER`；**无映射/未核验/与 repo+commit+摘要不匹配 → 明确 unknown 阻塞**（不默认可卸载）；无关服务不阻塞；UI 呈现“无法验证服务依赖，暂不能卸载”，不得呈现为“插件安全/无影响”。自报空声明不等于“无服务”；源码升级使记录失效。
- **保留项**：共享/传递依赖按**完全 pin 的 lockfile** 保留（不要求同包在 lock/安装目录全部消失，预览 `retention` 说明）；用户 patch 层（`home/cordis.patch.yml`，**原字节不被写回**）、环境数据（`home/`/`data/`）、审计日志为保留项。
- **内置保护**：`isBuiltin` 由**当前受管 DSH 安装**解析出的 in-box bundle 集合判定（F12a）；缺失或不可信路径 → 拒绝（不是空集合），同名 profile 依赖不改变保护；负控用真实 in-box 名。
- **验收**：同 fixture **安装 → 卸载 → 重启**，以「活动代际记录 + 受管 DSH 离线解析组合树」判定启用集合不再包含该包；配置解析被破坏必须表现为可见受控失败。E9（离线组合树 == 运行期加载集合）等价性仍待实证，不作为唯一判据。

## 未决与依赖

- S2 的 home 派生机制、含密文件处理与崩溃恢复是 [#76](https://github.com/YingkeSu/HDSL/issues/76) 的硬门禁（ADR 0005 D18/E10）：**运行数据部分**决策见 [ADR 0006](../../docs/adr/0006-generation-home-derivation.md)，实现与验证边界见 [S2 home/事务设计](s2-home-and-transaction-design.md)，可复现实证见 [记录](../../docs/development/plugin-home-derivation-validation.md)。**决策已给出，但生产实现未落地**：在实现与 `SIGKILL` 全相位对账完成前，不得宣称"旧代际可启动/数据保留"已实现。
- **每代 profile 加载机制（E10b）未决**：共享 home 下 DSH 固定在 `$DSH_HOME/profiles/<name>` 读取 profile（rc.2 实测 P1–P3）。候选机制未选定，**不得预判 symlink 安全**；在 E10b（真实 boot 证明"恢复后旧代实际加载集合 == 该代组成摘要" + 发布原子性/崩溃恢复）通过前，不得声称旧代加载其自身组成。
- `--dump-config` 静态性与运行期加载集合的等价性待实证（E9）；本阶段未证，生效判据仍只到"活动代际记录 + 离线解析组合树"。
- 真实限流形态、闭包摘要推导与受管 pnpm 身份待实证（E1/E2/E6）。
