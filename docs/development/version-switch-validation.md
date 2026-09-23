# A2 版本切换：验证记录（#114 / #131）

范围：同环境组成切换（`environments.switchCombination`）的事务、回滚、恢复、幂等与
回退数据兼容提示（Tier 1，Node 轴），以及 Tier 2（#131）纳入第二个 DSH 版本
`@deepseek-ai/dsh@0.1.7-rc.1` 后的真实跨版本回退证据。基线
`ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa`。

本记录区分**确定性证据**（离线 fixture / 合成运行时 / 受控执行器，可重复）与
**真实 opt-in 证据**（需要真实 macOS ARM64 受管运行时与网络）。未运行项保持**未测**。

## 1. 确定性证据（已运行）

命令：

```bash
pnpm run typecheck
pnpm exec vitest run tests/core/version-switch.test.ts tests/core/generation-version.test.ts tests/core/restore-compatibility-warning.test.ts
```

`tests/core/version-switch.test.ts`（真实磁盘 dataRoot + 真实 journal/operation store +
contract dispatcher；离线合成 tarball，仍校验 SHA-256；两个组合共享同一 DSH 版本、仅 Node
不同）：

| 用例 | 证明 |
| --- | --- |
| 成功路径 | 新代入代、profile 在切指针前发布、指针原子 → Y、`revision+1`、`stopped`、X 目录保留、`generation.json.dshVersion` 记录 |
| 幂等 no-op | 目标 == 当前 digest → 成功且 `revision`/指针不变、无第二个代目录；同 `requestId` 重放返回原 ref |
| 提交前失败（注入于提交点） | operation failed、X 指针/摘要/revision/state 不变且**不置 `error`**、只删新 stage、journal 清理、X 仍可 start |
| 下载失败（提交前） | `DOWNLOAD_FAILED`、X 指针不变 |
| 指针切后崩溃 | `recover()` finalize 到 Y、X 保留、journal 清理、operation succeeded |
| profile 发布后指针切前崩溃 | `recover()` 回滚、指针仍 X、X 保留、operation failed |
| 孤儿 switch operation（无 journal） | 受控失败、环境**不**置 `error`、指针仍 X、`in-progress` 幂等账本结清（重放返回受控失败而非 `ENVIRONMENT_BUSY`） |
| running 守卫 | `ENVIRONMENT_BUSY`、不切指针、状态仍 running、无新代 |
| 切换期间的 start/第二 switch | `ENVIRONMENT_BUSY`（未决 journal 互斥） |
| 未知/不支持组合 | `NOT_FOUND`/`UNSUPPORTED_COMBINATION`，无副作用 |

`tests/core/generation-version.test.ts`：DSH 版本排序（含 prerelease）、降级提示判定
（严格降级才提示；同版本/未知/不可解析不提示）。

`tests/core/restore-compatibility-warning.test.ts`：`generations.restore` 输出在降级时
携带非阻断 `dshCompatibilityWarning`；同版本（Node 轴）、升级、未知版本不提示；提示存在
时指针仍移动、`revision+1`；`generation.json` 缺 `dshVersion` 时从 manifest 回退读取。

契约：`tests/contracts/fixtures.test.ts` 覆盖 `environments.switchCombination` 的
合法/非法 fixture；`tests/contracts/consumer-parity.test.ts` 同步 preload 白名单。

## 2. 真实 opt-in 证据（未运行 → 未测）

以下需要真实 `VERIFIED_COMBINATIONS`（macOS ARM64）、真实网络与受管进程，**本 PR 未运行**，
因此**不声称已通过**：

- C22 → C24 真实 `npm-ci` 安装 + preflight + 真实 profile 发布 + 切指针。
- 用 Y 的 Node 可执行文件启动 Y 到 ready，确认 `profiles/node_modules` 指向 Y 安装路径。
- `generations.restore` 回 X，逐字节比对 home/sessions/storages/凭据不变。
- 真实降级（第二个 DSH 版本）提示路径：**不可**用 C22↔C24 冒充（DSH 相同）。

真实安装入口与启用方式见 [测试指南](testing.md) 与
[t004 安装证据](t004-install-evidence.md)。未验证平台（Windows/Linux）保持未测。

## 3. 边界与已知限制

- 本切片 Tier 1 只覆盖 Node 轴 + 切换事务；**不**承诺跨版本 home 兼容（ADR 0006 D6 / R006）。
  Tier 2（#131）补充第二个 DSH 版本与跨版本回退证据，见 §5；仍不承诺迁移/回滚。
- #114 首个 PR **未**触碰 renderer；renderer 接线见 §4（#132，UI-only，未改变事务语义）。
- 第二个 DSH 版本与 `packages/runtime/src/catalog/**` 由 #131 单独改动：新增
  `dsh-0.1.7-rc.1` 组合与独立闭包，`CATALOG_REVISION` 更新；既有 `0.1.5-rc.2` 组合
  的 id/字节不变。
- 跨服务互斥：`switchCombination` 与 apply/restore 通过各自的 journal 命名空间互斥；
  未新增跨进程全局锁（沿用既有 data-root lease 与单事务不变量）。
- 孤儿 `in-progress` switch 账本（账本写入与 journal 写入之间崩溃）由 `recover()` 在无
  活跃 switch 事务时结清为受控失败；create 侧同形窗口不在本切片范围（既有行为）。
- 提交前失败/回滚只删新 stage 代目录；已发布但未被引用的 `hdsl-<gen>` profile 保留在
  共享 home（沿用 MF1 无 GC 决策），属已知残留。

## 4. renderer 接线（#132，UI-only）

范围：只把已合入的 `environments.switchCombination` 与
`generations.restore` 的 `dshCompatibilityWarning` 接到桌面界面，**不**新增事务/契约语义。

- 新增独立组件 `apps/desktop/src/renderer/components/SwitchVersion.tsx`（不编辑 A1 的
  `DshVersions.tsx`）：目标组合 = `catalog.list` 中 `compatibility.status === 'verified'`
  **且**由 `versions.dsh` 已支持条目 `catalogCombinationIds` 引用的**已支持组合**；未支持/
  未知组合不作为可切换项。
- 仅 `stopped` 环境可发起切换；`running`/`starting`/`stopping` 禁用入口并提示先停止，
  不自动停进程。发起时携带当前 `environment.revision`，终态经既有 `OperationPanel` 跟踪；
  成功后代控制器刷新环境（新代、`revision+1`、仍 `stopped`），失败保留旧代并显示受控脱敏错误。
- `generations.restore` 终态的非阻断 `dshCompatibilityWarning` 存于 renderer 状态并在代际
  面板结果处展示；同版本/未知版本（契约返回 `null`）不提示，不撤销已写数据。
- 证据：`tests/renderer/switch-version.test.ts`（controller 用 TEST-ONLY reference runtime
  与 stub client；markup 用 `react-dom/server`）。真实受管安装/进程与 Electron 仍**未测**。

<a id="tier-2-real-evidence"></a>

## 5. Tier 2 真实跨版本证据（#131，已运行）

范围：把 `@deepseek-ai/dsh@0.1.7-rc.1` 纳入**已受审组合**（新增独立组合与闭包，不改
基线字节），并用真实 macOS ARM64 安装/启动与 `generations.restore` 证明降级提示的真实
触发路径。只读来源复核见 [dsh-compatibility.md R007](../research/dsh-compatibility.md#r007)。

命令（本机 macOS 26.3 arm64 / Node 24.21.0 / pnpm 11.7.0）：

```sh
HDSL_REAL_CROSS_VERSION=1 HDSL_EVIDENCE_KEEP=1 \
HDSL_REAL_CROSS_VERSION_DATA_ROOT=/tmp/hdsl-131-evidence \
  pnpm exec vitest run tests/install/real-cross-version.evidence.test.ts --reporter=verbose
```

结果：`1 passed`（60.6s）。在单个真实环境内完成：

- 以 `darwin-arm64-node22_19_0-dsh0_1_7-rc_1` 创建新代、真实 `npm ci` 闭包安装：
  `packageCount=586`、`lockSha256=444df5ea…54dc`、DSH `treeDigest=7a71a217…46c0`。
  `install-manifest.json` / `composition.lock.json` 的 DSH 版本与 sha256 与 catalog 绑定。
- 用受管 Node 执行 `dsh -V`，输出精确 `0.1.7-rc.1`。
- `environments.switchCombination` 到 `darwin-arm64-node22_19_0-dsh0_1_5-rc_2`：
  新代入代、环境仍 `stopped`、`revision+1`、基线组合字节未变。
- 真实启动 `0.1.7-rc.1`：打印的 loopback URL 可达（无 cookie `401`）；`environments.stop`
  （SIGTERM）后无残留进程（`isProcessAlive(pid)=false`、loopback 不再可达）。
- 真实 `generations.restore` 四态：lastStarted 未知 / 同版本（`0.1.7-rc.1`）/ 升级 →
  **无**提示；目标 `0.1.5-rc.2` 严格早于 lastStarted `0.1.7-rc.1` → 非阻断
  `dshCompatibilityWarning`，且指针已切换、`revision+1`、两代目录保留。
- 真实启动 `0.1.5-rc.2` 同样到 ready 并 SIGTERM 停止；宿主 `~/.dsh` 清单纯照前后一致。

`dshCompatibilityWarning` 原文（有界、无路径、无 secret）：

> the target generation runs DSH 0.1.5-rc.2, older than the last successfully started DSH
> 0.1.7-rc.1; workspace data written by the newer version is not guaranteed to be compatible

证据 JSON（已去除绝对路径与 token）关键字段：

| 字段 | 值 |
| --- | --- |
| `tier2CombinationId` | `darwin-arm64-node22_19_0-dsh0_1_7-rc_1` |
| `baselineCombinationId` | `darwin-arm64-node22_19_0-dsh0_1_5-rc_2` |
| `tier2Install.packageCount` | 586 |
| `tier2Install.lockSha256` | `444df5ea…54dc` |
| `tier2Install.treeDigest` | `7a71a217…46c0` |
| `tier2Install.reportedVersion` | `0.1.7-rc.1` |
| `warnings.unknown` / `warnings.same` / `warnings.upgrade` | `null` |
| `warnings.downgrade` | 非阻断提示字符串（见上） |
| `homeUntouched` | `true` |

### 5.1 home / session 行为（按 R006 如实记录）

- `0.1.7-rc.1` tag 源码 `SESSION_FORMAT_VERSION = 4`；基线 `0.1.5-rc.2` = `3`。
  本轮未创建真实 session，故**不声称**做过 session 迁移/回退实验。
- HDSL 只提示：**不**迁移、**不**回滚、**不**删除/撤销新版写入的数据。旧版对更高格式
  fail-closed；新版写入的 session 在旧版可能被拒绝（R006）。
- 真实启动会在环境 home 生成/更新 `.credentials.yaml`（`0600`，上游 Web grant secret，
  非 HDSL 管理的 API key）、`storages/`、`profiles/hdsl-<gen>` 与 `.tmp`；这些文件与
  token/secret **不进入日志或证据**。
- 跨版本 home/session 迁移保证、schema 降级、撤销新版数据均为**非目标**。

### 5.2 边界与未测

- 仅 macOS ARM64；Windows/Linux 未测，不声称支持。
- 真实证据只对实际执行的 head 成立；`0.1.5-rc.2` 组合的 id/字节未改（golden 摘要不变）。
- 未自动跟随 `latest`/`next`/`alpha`；dist-tag 指向的版本保持 `supported: false`。
- Tier 1 的 C22↔C24 真实 opt-in（T109）仍**未运行**，不受本轮 Tier 2 证据影响。

### 5.3 受管安装矩阵（`HDSL_REAL_INSTALL`，4 组合）

同一 `tests/install/real-install.evidence.test.ts` 已扩展为覆盖全部 4 个已受审组合
（此前只覆盖 rc.2 × 两个 Node）。命令：

```sh
HDSL_REAL_INSTALL=1 HDSL_EVIDENCE_KEEP=1 \
HDSL_EVIDENCE_DATA_ROOT=/tmp/hdsl-131-evidence \
  pnpm exec vitest run tests/install/real-install.evidence.test.ts --reporter=verbose
```

结果：`1 passed`（105.9s）。四个组合都走真实官方下载 + 完整 `npm ci` 闭包 + 预检：

| 组合 | Node | DSH | `packageCount` | `lockSha256` | `treeDigest` | `npm ci` npm | `dsh --version` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `…dsh0_1_5-rc_2` | 22.19.0 | 0.1.5-rc.2 | 585 | `da075539…a5cd` | `f5af577d…d5cb` | 10.9.3 | `0.1.5-rc.2` |
| `…dsh0_1_5-rc_2` | 24.21.0 | 0.1.5-rc.2 | 585 | `da075539…a5cd` | `f5af577d…d5cb` | 11.19.0 | `0.1.5-rc.2` |
| `…dsh0_1_7-rc_1` | 22.19.0 | 0.1.7-rc.1 | 586 | `444df5ea…54dc` | `7a71a217…46c0` | 10.9.3 | `0.1.7-rc.1` |
| `…dsh0_1_7-rc_1` | 24.21.0 | 0.1.7-rc.1 | 586 | `444df5ea…54dc` | `7a71a217…46c0` | 11.19.0 | `0.1.7-rc.1` |

`preflight` 每个组合都 `exitCode=0`，`node --version` / `dsh --version` / `dsh --help` 均通过；
宿主 `~/.dsh` 清单纯照前后一致。rc.2 组合的 `packageCount`/`lockSha256`/`treeDigest` 与
[T004 记录](t004-install-evidence.md)一致，说明 #131 未改写基线闭包字节。
