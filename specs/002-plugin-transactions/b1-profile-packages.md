# B1：profile 包依赖与 bundles 声明式增删（#115）

状态：**本片实现（reconcile 基准 + restart 语义 + 服务门禁 supersede）**。上游决策依据见
[#111 首条评论](https://github.com/YingkeSu/HDSL/issues/111#issuecomment-5790375006) 与
[#112 定位纠偏](https://github.com/YingkeSu/HDSL/issues/112)；本文件只固定 B1 的行为边界与取舍，
不复制会漂移的接口清单。

## 定位

HDSL = DSH 启动器 + 版本管理器 + 包依赖/bundles 的便捷管理。本片只处理
**某 profile 的包依赖与 `dsh.profile.bundles`**：增/删/精确 pin、并对账 bundle 层、明确 restart 语义。
运行期 entry（`cordis.patch.yml` 热加载）属 E1 [#116](https://github.com/YingkeSu/HDSL/issues/116)；
插件影响分析/无损卸载不承诺，**不作为门禁**。

## 执行路径取舍（a vs b）

| 路径 | 事实 | 结论 |
| --- | --- | --- |
| (a) 直接 `dsh plugin --profile <n> add\|remove` | 上游转发 pnpm，exit 0 时 reconcile `dsh.profile.bundles`；**写入活 profile 目录**（`$DSH_HOME/profiles/<n>`），无暂存代、无 journal/指针提交、无默认拒执行、无 `allowBuilds` 精确授权、无来源/摘要 pin 绑定 | 不采用：绕过 HDSL 的不可变代际/事务/凭据边界，无法在失败/取消时保留旧代 |
| (b) HDSL 薄适配 | 暂存声明 + 受管 pnpm（受管 Node、`--ignore-scripts` 默认拒执行、冻结 lock 逐字比对），提交点是活动代指针切换；把 `dsh plugin` 的 reconcile 语义当**对账基准** | **采用**：复用既有 `changes.preview`/`changes.apply` 事务，不复制 DSH 内部引擎 |

决定：**(b)**。理由是事务原子性、失败/取消保留旧代、安装期显式脚本授权（#78）与来源 pin 必须保留，
这些都是 (a) 无法提供的；`dsh plugin` 的实现只作为 reconcile 语义的对账基准，不作为执行路径。

## 本片改动

1. **bundle reconcile 基准**（`packages/runtime/src/plugins/profile-bundles.ts`，纯函数、可单测）：
   - 依赖包 manifest 声明 `dsh.bundle.patch`（非空字符串）⇒ 入 bundle 层；
   - 依赖被移除或**失去声明** ⇒ 出 bundle 层；
   - 非 profile 依赖的 bundle 条目（模板 in-box bundle）保持不动；
   - 声明**不可读**（`dsh.bundle` 存在但 `patch` 缺失/为 `null`/空串/非字符串，或 `dsh`/`dsh.bundle` 形态畸形）⇒ 保持原状并记为 `unresolved`，**不猜、不 `unknown ⇒ 禁止`**；调用方必须把 `unresolved` 消费成 `riskItems`（`unresolvedBundleRisk`），**不得丢弃**，以免静默伪称 bundle 已对账。
   - 接入点：`target-profile.ts`（安装目标声明，只有声明 bundle 的来源才入层，`unresolved` 汇入 `PluginPreviewResolution.riskItems`）与 `removal.ts`（卸载剪枝）；仅移除显式目标，**非字符串条目原样保留**。
2. **restart 语义进入操作终态**（`packages/core/src/plugin-preview.ts`）：install/remove 计划
   `riskItems` 均显式包含 `CHANGE_PLAN_RESTART_REQUIRED`，说明改依赖/bundles 无 watcher、需重启生效
   （#111 G6）；UI 已有的“重启环境后生效”文案由该终态可推导。
3. **服务核验政策 supersede**（`packages/runtime/src/plugins/removal.ts`）：
   ADR 0005 D21 的 `known`/`unknown ⇒ 阻塞卸载` 政策由 [#112](https://github.com/YingkeSu/HDSL/issues/112)
   supersede，本片落实为**信息项**：未核验/未命中消费方不再产生 `blockingReferences`，只进
   `riskItems`。**保留**的阻塞项：真实 in-box bundle 保护（`BUILTIN_BUNDLE_PROTECTED`）、其它层对目标
   的静态引用（`REFERENCED_BY_OTHER`）、以及无法解析的 patch 构造（fail-closed）。核验**事实基线**
   （记录格式、`lookupServiceVerification`）保留，不删除。

保留的不变量：来源/摘要 pin、事务原子性（journal/指针提交/recover）、凭据与秘密边界、安装期显式
构建授权（#78）、受管 pnpm 冻结 lock 逐字比对。

## 非目标 / 未做（诚实边界）

- **不**做运行期 entry（E1 #116）、**不**做版本切换（A2 #114）、**不**做影响分析、**不**承诺无损卸载。
- **不**新增 npm registry 包来源选择器：安装来源仍是公开 GitHub 仓库的精确 commit（见
  `preview-resolution.ts`）；直接 `pnpm add <pkg>@<ver>` 形态的 registry 来源是后续切片，本片不伪造该接口。
- **全闭包 reconcile 未实现**：安装时只按“新来源自己的 manifest”判定入层；把**既有**且已声明 bundle
  的依赖补齐入层、或驱逐失去声明的既有依赖，需要已物化的依赖闭包（当前只有 S4 脚本枚举路径会物化），
  留作后续。当前 reconcile 只在这两个已知 manifest 的接点生效。
- 不声称 `dsh.plugin` CLI 的 pnpm 解析结果与 HDSL 受管 pnpm 逐字节一致；两者都只是 reconcile 基准的不同执行者。

## 验收口径（本片可执行）

- 纯函数：`declaresBundle` 对 `dsh.bundle.patch` 字符串/缺失/畸形分别给出 `true`/`false`/`null`；
  `reconcileProfileBundles` 覆盖入层、失去声明出层、显式移除出层、unknown 保持、非依赖条目保持。
- 目标声明：`resolveTargetProfileLock` 只用声明 bundle 的来源入层；非 bundle 来源只加依赖不入层。
- 卸载：`resolvePluginRemoval` 对未知服务核验**不**产生 `blockingReferences`，但保留静态引用/in-box 阻塞。
- 计划终态：install/remove 计划 `riskItems` 含 restart 语义。

真实第三方安装/启停/卸载验收属 [#98](https://github.com/YingkeSu/HDSL/issues/98)；契约冻结与消费方一致性属
[#99](https://github.com/YingkeSu/HDSL/issues/99)。本片不声称平台验收。
