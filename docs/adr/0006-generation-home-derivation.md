# 0006：插件变更代的 home 派生与运行数据边界

- 状态：**proposed**（等待独立复审；批准前不据此改生产实现）
- 日期：2026-09-22
- 关联：#76（本决策 owner，Parent #73）；`Refs #9`（M2 插件/事务路线）；`Related #8`（Windows x64 未测门禁）；承接 [ADR 0005](0005-plugin-contract-evolution.md) D18 / E10 / §9.7 的 #76 硬前置
- 基线：HDSL main `21b653894dd58f92d4e59e42401e8e9e40dc8fe8`（PR #81 squash merge，含 ADR 0005 PR #80 `aa2a26e`）；上游固定 tag `dsh-v0.1.5-rc.2` = `fb2c4b9e698e30edb738bca4cf0618587db7d203`（不与 master 混用）
- 依据（可直接核对）：
  - [ADR 0005](0005-plugin-contract-evolution.md) D18（运行数据不变量）、E10（home 派生待实证）、§9.7（门禁登记）、F13
  - 实现 `packages/core/src/layout.ts`、`packages/core/src/creation-service.ts`（`#commit`/`#fail`/`#rollBack`/`recover`）、`packages/core/src/journal.ts`
  - 领域定义 `CONTEXT.md`（Generation = 组成快照，运行数据仍可变）
  - 上游 home 布局 [dsh-compatibility.md](../research/dsh-compatibility.md) R003（`$DSH_HOME` 下的 `sessions`/`storages`/`.credentials.yaml`/`cordis.patch.yml`）
  - 可复现实证 `scripts/research/home-derivation-probe.mjs`；记录 `docs/development/plugin-home-derivation-validation.md`

## 0. 范围与证据等级

**在范围**：插件安装/卸载/恢复事务的 `home` 派生机制选择；含密文件、可变运行数据的归属；旧代际可启动的精确条件与数据回退限制；事务提交点、相位名与故障注入公共形状；对应的 D18/E10 验证方案。

**不在范围**：实现任何插件方法或改生产代码（本 ADR 只给决策与设计；实现必须在独立复审批准后由 S2 切片落地）；修改 `version.ts`/`local-api.md`/`fixtures.ts`；执行第三方代码；真实 DSH 安装或模型请求。E9（`--dump-config` 静态性与运行期加载集合等价性）在本片**不宣称**已证，仅为后续闸门。

**证据等级**（SOP §7）：对现有代码与布局的事实陈述为 `verified`（文件与提交可核对）；上游 home 行为为 `raw`（固定 tag 实测，未在本片复验）；机制决策为 **design decision**；实证脚本结果是 `fixture`（合成运行时 + 真实事务/恢复代码，网络为零，**不构成真实 DSH 安装或桌面证据**）。

## 1. 背景

ADR 0005 D18 已把"插件事务不得破坏运行数据 / 旧代际可启动 / 运行数据不分叉 / 含密产物不外泄"定为契约级不变量，并把机制决策与实证列为 **#76 硬前置**（E10）。F13 记录当前每代目录为 `<generation>/home`，启动时 `DSH_HOME = HOME = homeDirectory`；`sessions`/`storages`/`.anonymous-user-id`/`.credentials.yaml` 都在其下。

当前实现事实（`verified`）：

| # | 事实 | 证据 |
| --- | --- | --- |
| G1 | 每代目录含独立的 `home/`、`config/`、`data/` 子目录 | `packages/core/src/layout.ts` `generationPaths` |
| G2 | 创建事务提交时只对 `home/`、`config/`、`data/` 执行 `ensureDirectory`，**不携带上一代运行数据**；未提交的 stage 会以 `removePath(generationDirectory)` 整体删除 | `creation-service.ts` `#commit`、`#fail`、`#rollBack` |
| G3 | 提交点 = `environment.json` 中 `activeGenerationId`/`revision` 的原子写入；`recover()` 以"指针是否已指向该代"区分 finalize 与 rollback | `creation-service.ts`、`journal.ts` |
| G4 | 回滚/失败会把整个未提交代目录删除，包括其 `home/` | `creation-service.ts` `#fail`/`#rollBack` |
| G5 | `CONTEXT.md` 定义 Generation 为"配置与插件组成固定、运行数据仍可变"的组成快照 | `CONTEXT.md` |
| G6 | 上游 home 级用户 patch 为 `$DSH_HOME/cordis.patch.yml`，`sessions`/`storages`/`.credentials.yaml` 均在 `$DSH_HOME` 下 | dsh-compatibility R003（`raw`，本片未复验） |

G2 + G4 是本决策的关键：**任何放进 stage 代目录的运行数据都会在提交前失败时被整体删除**，这是可复现的失效形状（见 §5 实证 A1/A2）。

## 2. 决策

**采用"环境级共享 home + 仅 stage 组成/profile"方案：运行数据与含密产物归环境所有，不进入任何代际快照；插件事务只暂存新的组成（运行时 + profile/lock），活动代际仅是一个指针。**

具体决定：

- **D-A 单一共享 home**：目标布局把可变 home 提升到环境级 `<env>/home/`，所有代际共享同一 `home`。事务**不复制、不覆盖、不删除** `home` 内容；`generationPaths().homeDirectory` 的目标落点是环境级路径（具体字段迁移由 S2 实现切片完成）。
- **D-B 代际只承载组成**：代目录只包含受管运行时产物、`composition.lock.json`、`generation.json`、`install-manifest.json` 与 profile/lock 三元组。代际是**不可变组成快照**，与 G5 的领域定义一致。
- **D-C 含密产物单份**：`.credentials.yaml` 只存在于环境级 home 一份，0600 不变；不得复制进代目录、不得进入导出/日志/整合包（ADR 0002 边界不变）。事务与恢复路径不得读取或改写其内容。
- **D-D 可变运行数据归环境**：`sessions/`、`storages/`、`.anonymous-user-id`、用户 patch `cordis.patch.yml` 以及进程 cwd 用的 `data/` 均为环境级、跨代共享、由用户/DSH 拥有；HDSL 事务不迁移、不改写、不回滚它们。
- **D-E 提交点与回滚范围收窄**：提交点仍是**活动代际指针的原子写入**。提交前的失败/取消只清理本次新建的 stage 代目录，**不触碰环境级运行数据**；提交后只做 finalize。
- **D-F 旧代可启动为条件性保证**：旧代可启动当且仅当 §4 的条件全部成立；其中"运行数据 schema 兼容"不由 HDSL 保证，必须在恢复前呈现为可解释状态，不得静默宣称成功。
- **D-G 恢复不动数据**：`generations.restore` 只切换活动代际指针，不撤销 workspace、会话、存储、凭据或新代写下的数据，也不做 DSH 版本降级（§4.2）。

该决策**取代** ADR 0005 D18 中"机制延后由 002 决定"的待定状态；D18 的四条不变量不变。

## 3. 替代方案比较

| 判据 | A. 复制上一代 home 进新代 | B. 覆盖共享（环境级 home，事务可写） | **C. 仅 stage 组成/profile（本决策）** |
| --- | --- | --- | --- |
| D18-1 事务不破坏运行数据 | 弱：复制/删除窗口可损坏 stage 内的副本 | 中：事务写共享 home 时出错会直接污染 | **强：事务从不写 home** |
| D18-2 提交前失败旧代可启动 | 中：旧代自有副本在 | 中：取决于写入是否原子 | **强：home 未被触碰** |
| D18-3 运行数据不分叉 | **差：新代写入后旧代副本陈旧**，切换回旧代看不到新数据 | 强：单份 | **强：单份** |
| 含密文件处理 | 差：每代一份 secret，扩大拷贝面 | 中：单份但允许事务写 | **强：单份且事务不写** |
| 崩溃窗口 | 新增"home 复制中/home 派生后"窗口（E10 明列的窗口） | 窗口在共享写 | **消除 home 派生窗口**；仅剩 stage 与指针两窗口 |
| 磁盘/时延成本 | 每代复制全部 sessions/storages | 无 | **无** |
| 与 G5 领域定义 | 冲突：把运行数据并入代快照 | 兼容 | **一致** |
| 数据 schema 降级风险 | 与 B/C 相同（上游数据版本问题） | 同 | 同，由 D-F 显式呈现 |

A 被否的核心理由：它把运行数据并入组成快照，违反 G5，并直接引入 D18-3 的分叉与 E10 的 home 派生崩溃窗口。B 与 C 的唯一差别是"事务是否允许写共享 home"；C 以"事务只读 home、只写 stage"把 D18-1 做成结构性保证，而不是靠写入顺序小心维持，因此选 C。

## 4. 归属、旧代条件与数据回退限制

### 4.1 归属表

| 对象 | 归属 | 事务行为 | 导出/整合包 |
| --- | --- | --- | --- |
| 受管运行时（node/dsh 产物） | 代际（不可变） | 新建 stage | 否（按摘要引用） |
| profile 三元组（`package.json` + `pnpm-lock.yaml` + 生成 `cordis.patch.yml`） | 代际（不可变） | 新建 stage | 组成摘要，不含凭据 |
| `composition.lock.json` / `generation.json` / `install-manifest.json` | 代际（不可变） | 新建 stage；提交后才可被指针引用 | 摘要/来源锁 |
| `home/` 目录 | 环境（可变、共享） | **只读校验，不复制不删除** | 否 |
| `.credentials.yaml`（0600，含密） | 环境（含密） | 只读校验存在性/权限，不读内容 | **永不** |
| `.anonymous-user-id` | 环境（私有） | 不触碰 | 否 |
| `sessions/`、`storages/` | 环境（可变运行数据） | 不触碰 | 否 |
| 用户 patch `$DSH_HOME/cordis.patch.yml` | 环境（用户拥有） | 不触碰；卸载若被其引用则 `REFERENCED_BY_OTHER`（D15） | 否 |
| `data/`（DSH 进程 cwd） | 环境（可变） | 不触碰 | 否 |
| 搜索/解析缓存、journal、计划 TTL 记录 | 应用数据（非环境组成） | 允许写；不算副作用 | 否 |

### 4.2 旧代际可启动的精确条件

`generations.restore`/旧代可用**当且仅当**以下全部成立：

1. 目标代目录完整（`install-manifest.json`、`composition.lock.json`、运行时产物可读），且从未被任何回滚删除（G4 要求回滚只删未提交 stage）；
2. 环境的共享 home 存在、可读；`.credentials.yaml` 若存在则权限仍为 0600；
3. 活动代际指针指向目标代（要么从未切换，要么由 `generations.restore` 显式切回）；环境不处于 running/starting/stopping；
4. **运行数据 schema 兼容**：自该代上次运行以来，没有更新的 DSH 版本迁移/重写过 home 数据。HDSL 不保证上游数据向后兼容，因此必须在代际记录中记录"最近一次以该代启动的 DSH 版本"，当 `restore` 目标早于最近写入者时以可解释告警呈现（不阻断用户显式意图，但不得静默宣称"数据可读"）。

条件 1–3 可由 HDSL 结构性保证；条件 4 是**诚实的上游限制**，列为未决/需后续实证（`storages` 的 `version-mismatch` 行为在 dsh-compatibility R006 只到格式版本与 home 形态证据，未做真实 session 迁移实验）。

### 4.3 数据回退限制（明确不做）

- 不撤销或还原 `sessions`/`storages`/`.credentials.yaml`/用户 patch 到切换前的字节；
- 不删除新代运行期间写入的数据；
- 不回滚 workspace（可能在环境外）；
- 不做 DSH 数据 schema 降级或迁移；不承诺"换回旧代后会话/存储逐字节相同"；
- 回滚（提交前失败）只清理本次 stage 代目录。

## 5. 事务提交点、相位与故障注入公共形状

### 5.1 相位名（提交点 = 活动代际指针切换）

```
planned → staged → verified → committed → finalized
                              ^ 提交点（指针原子写入）
失败/取消在 committed 之前 → rolled-back / failed（仅删 stage）
committed 之后 → 只 finalize，如实报告"已提交，可显式 restore"
```

| 相位 | 已完成 | 崩溃后可解释状态 |
| --- | --- | --- |
| `planned` | 计划已验证、journal/op 已建 | 指针未变；recover 判 rolled-back |
| `staged` | 新代目录 + 组成/profile 暂存完毕 | 指针未变；recover 删 stage |
| `verified` | 离线解析/校验通过；共享 home 只读校验通过 | 同 `staged` |
| `committed` | `environment.json` 已原子指向新代 | recover 判 finalized（**不删**） |
| `finalized` | journal 清除、幂等账本 completed | 无残留 |

### 5.2 故障注入公共形状（对齐 `CreationFaults`）

```ts
type ChangePhase = 'planned' | 'staged' | 'verified' | 'committed' | 'finalized';

interface ChangeFaults {
  /** 在进入该相位边界后抛受控错误（默认拒执行的失败路径同样走这里）。 */
  readonly failAt?: ChangePhase;
  /** 在该相位边界挂起，保留 journal 与 running operation，供 SIGKILL 注入。 */
  readonly pauseAt?: ChangePhase;
}
```

- `pauseAt: 'verified'` 对应既有 `CreationFaults.pauseBeforeCommit`；`failAt: 'verified'` 对应 `failBeforeCommit`。
- 每个边界都必须支持**抛错**与**`SIGKILL`**两种注入（`SIGKILL` 不经过应用清理，用于验证 recover）。
- 事务不写 home，因此**没有**"home 派生中/home 派生后"这一相位；崩溃窗口收敛为：stage 中（`planned`/`staged`）、指针切换前（`verified`）、指针切换后（`committed` 未 finalize）。

## 6. D18/E10 验证方案与本片证据

| 不变量 / 门禁 | 验证方式 | 本片状态 |
| --- | --- | --- |
| D18-1 事务不破坏运行数据 | 事务代码路径不引用 home 写；实证 A1–A4 | 结构性 + fixture 已证（合成运行时） |
| D18-2 提交前失败旧代可启动 | 实证 A0/A1（指针未变、只删 stage）；旧代完整保留 | fixture 部分；双代旧代启停属 S2 实现 seam |
| D18-3 运行数据不分叉 | 环境级单份 home；实证 A3/B1 | fixture 已证 |
| D18-4 含密产物不外泄 | home 单份 0600（A4）；导出/整合包排除属既有 ADR 0002 门禁 | 0600 已证；导出排除为既有门禁 |
| E10 home 派生机制 | 本 ADR 决策 + §5 相位/注入形状 | **已完成决策**；S2 按此实现 |
| E10 崩溃恢复 | 每相位抛错 + `SIGKILL` + `recover()` 解释 | 部分：rollback finalize/rollback 分支已证；全相位注入属 S2 |
| E9 `--dump-config` 等价性 | 受控 marker 实证 | **未证**，见 §7 |

## 7. 未决与后续闸门（不得当作已实现）

- **E9 未证**：`--dump-config` 的静态性（不 require/执行 bundle 模块）与"离线解析组合树 == 运行期实际加载集合"的等价性未在本片验证。本片未找到已核身份的受管 DSH 安装，且宿主 pnpm `11.7.0` **不作为**受管执行器证据；需后续以受控 marker 插件在受管 DSH 安装上做有界实证。在此之前，生效判据只写"活动代际记录 + 离线解析组合树"，不得写成"运行期实际加载集合"。
- **受管 pnpm 身份（E1）**：候选 `11.7.0` 仍未以受管方式冻结。本片只做了一次有界只读官方来源核对：`npm view pnpm@11.7.0`（registry.npmjs.org）返回 `dist.integrity = sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==`、`engines.node >= 22.13`。这是官方来源/版本约束核对，**不是**受管执行器冻结证据：仍需 S2 决定 HDSL 如何随包固定该 tarball 并在 apply 时校验摘要；宿主 pnpm `11.7.0` 不作为证据。
- **上游 home 数据版本兼容（§4.2 条件 4）**：需真实 session 迁移实验；当前只到格式版本/home 形态证据。
- **实现落地**：布局从 `<gen>/home` 迁到 `<env>/home` 需要一次性、可崩溃恢复的迁移（旧环境只有一个活动代），属 S2 实现切片；本 ADR 不落实现。
- **E5 事务崩溃对账**：S2 需按 §5 相位补齐 `SIGKILL` 注入与 `recover()` 断言。

## 8. 后果

- 事务的"D18-1 不破坏运行数据"变成结构性属性（事务不写 home），而不是靠复制/回滚的细致顺序。
- 插件变更不再随代际复制用户数据；磁盘与切换时延恒定。
- 代价：旧代与新代共享同一份 DSH 数据目录，因此**不支持跨代的数据 schema 降级**，恢复必须给出可解释告警（§4.2-4）。
- 目标布局与当前 `generationPaths().homeDirectory`（G1）不一致；迁移前不得宣称 D18 已交付实现。
- E9 未证前，"生效"证据等级不超过"活动代际 + 离线解析组合树"（ADR 0005 D15）。

## 9. 验证状态

- 决策：本 ADR 已给出（`proposed`）。**批准前不据此修改生产实现**。
- 实证：`scripts/research/home-derivation-probe.mjs` 在 macOS ARM64、Node `24.21.0`、合成运行时 + 真实 `@hdsl/core` dist 上 9/9 通过；记录见 [plugin-home-derivation-validation.md](../development/plugin-home-derivation-validation.md)。
- 未验证：E1、E9、E2/E4/E5/E6/E7 与真实安装/桌面路径；本片未运行任何第三方插件代码或真实 DSH 安装。
- 本 ADR 不关闭 #76，也不宣称 #76 门禁已完全满足（E9 与 S2 实现仍需后续；见 §7）。
