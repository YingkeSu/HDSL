# 0006：插件变更代的 home 派生与运行数据边界

- 状态：**proposed**（等待独立复审；批准前不据此改生产实现）
- 修订：rev 2（回应独立审核 `5773952049` CHANGES_REQUESTED：拆开"共享 home"与"每代 profile 加载"、新增 E10b 硬门禁；补首次迁移细节；撤销对 creation 探针的过度归因；声明相位/注入形状无实现）
- 日期：2026-09-22（rev 2：2026-09-22）
- 关联：#76（本决策 owner，Parent #73）；`Refs #9`（M2 插件/事务路线）；`Related #8`（Windows x64 未测门禁）；承接 [ADR 0005](0005-plugin-contract-evolution.md) D18 / E10 / §9.7 的 #76 硬前置
- 基线：HDSL main `21b653894dd58f92d4e59e42401e8e9e40dc8fe8`（PR #81 squash merge，含 ADR 0005 PR #80 `aa2a26e`）；上游固定 tag `dsh-v0.1.5-rc.2` = `fb2c4b9e698e30edb738bca4cf0618587db7d203`（不与 master 混用）
- 依据（可直接核对）：
  - [ADR 0005](0005-plugin-contract-evolution.md) D18（运行数据不变量）、E10（home 派生待实证）、§9.7（门禁登记）、F13
  - 实现 `packages/core/src/layout.ts`、`packages/core/src/creation-service.ts`（`#commit`/`#fail`/`#rollBack`/`recover`）、`packages/core/src/journal.ts`
  - 领域定义 `CONTEXT.md`（Generation = 组成快照，运行数据仍可变）
  - 上游 home 布局 [dsh-compatibility.md](../research/dsh-compatibility.md) R003（`$DSH_HOME` 下的 `sessions`/`storages`/`.credentials.yaml`/`cordis.patch.yml`）
  - 可复现实证 `scripts/research/home-derivation-probe.mjs`（事务删除作用域）与 `scripts/research/dsh-profile-mechanism-probe.sh`（固定 rc.2 profile 选择机制）；记录 `docs/development/plugin-home-derivation-validation.md`

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

- **D-A 单一共享 home 承载运行数据**：目标布局把可变 home 提升到环境级 `<env>/home/`，所有代际共享同一 `home`。事务**不复制、不覆盖、不删除**用户运行数据（`sessions`/`storages`/`.anonymous-user-id`/`.credentials.yaml`/用户 patch）；`generationPaths().homeDirectory` 的目标落点是环境级路径（具体字段迁移由 S2 实现切片完成）。
- **D-B 代际承载组成快照**：代际是**不可变组成快照**（受管运行时 + `composition.lock.json`/`generation.json`/`install-manifest.json` + 本代 profile 组成），与 G5 的领域定义一致。
  - **但"组成快照"不等于"已被 DSH 加载"**：共享 home 下，DSH 的 profile 固定解析在 `$DSH_HOME/profiles/<name>`（见 §2.3）。代际 profile 的**物理加载路径与选择机制是未决项**，由 **E10b** 硬门禁约束；在 E10b 通过前，不得声称某代际的 profile 组成已生效，也不得把 D18-2 的插件集部分或 D15 的生效观测写成已满足。
- **D-C 含密产物单份**：`.credentials.yaml` 只存在于环境级 home 一份，0600 不变；不得复制进代目录、不得进入导出/日志/整合包（ADR 0002 边界不变）。事务与恢复路径不得读取或改写其内容。
- **D-D 可变运行数据归环境**：`sessions/`、`storages/`、`.anonymous-user-id`、用户 patch `cordis.patch.yml` 以及进程 cwd 用的 `data/` 均为环境级、跨代共享、由用户/DSH 拥有；HDSL 事务不迁移、不改写、不回滚它们。
- **D-E 提交点与回滚范围收窄**：提交点仍是**活动代际指针的原子写入**。提交前的失败/取消只清理本次新建的 stage 代目录，**不触碰环境级运行数据**；提交后只做 finalize。
- **D-F 旧代可启动为条件性保证**：旧代可启动当且仅当 §4 的条件全部成立；其中"运行数据 schema 兼容"不由 HDSL 保证，必须在恢复前呈现为可解释状态，不得静默宣称成功。
- **D-G 恢复不动数据**：`generations.restore` 只切换活动代际指针，不撤销 workspace、会话、存储、凭据或新代写下的数据，也不做 DSH 版本降级（§4.2）。

### 2.3 未决：共享 home 与"每代 profile"的加载机制（E10b 硬门禁）

**冲突陈述**：D-A 让 home 共享 ⇒ `DSH_HOME` 共享；而 DSH 把 profile 固定解析在 `$DSH_HOME/profiles/<name>`，启动 argv 目前只有 `web`（= `--profile web`）。因此若不做机制处理，所有代际会加载**同一个** `web` profile：代目录里的组成不会被读取，`generations.restore` 只换运行时、不换插件集，与 D-B/D18-2/D15 矛盾。**不能两边都声称。**

**固定 rc.2 机制证据（verified，本片实测）**：

| # | 事实 | 证据 |
| --- | --- | --- |
| P1 | `--profile <name>` 选择 `$DSH_HOME/profiles/<name>`；`web` 是 `--profile web` 的硬编码别名；profile 不存在时从 shipped 模板自动初始化 | rc.2 `lib/bin.js`（`--profile <name>` 说明与 `web` 别名）+ `scripts/research/dsh-profile-mechanism-probe.sh` |
| P2 | 组合的 bundle 层来自该 profile 的 `package.json` `dsh.profile.bundles`；改写它（base-only）使 dump 的 bundle 头从 20 降到 1 | 同上（fresh `web`=20 头；`genA` 默认=20；`genA` base-only=1） |
| P3 | 同一个共享 `DSH_HOME` 下两个 profile 目录（`web`/`genA`）**并存并被各自选中**；改写 `genA` 的 bundles 不改变 `web` 的 dump | 同上（修改 `genA` 后重 dump `web` 字节相同） |

**真实 boot 运行时 marker（本片实测，`raw`→接近可执行证据）**：用自有已审 fixture + 固定完整性 rc.2，同一个共享 `DSH_HOME` 建两代 profile：

| 观察 | 结果 | 证据 |
| --- | --- | --- |
| `genA`（base+web-app）真实 boot | `dsh web: http://127.0.0.1:<port>/` 就绪行在 ~4s 出现 | `scripts/research/dsh-profile-runtime-marker-probe.sh` |
| `genB`（base-only）真实 boot | 无 web 就绪行（web-app 未被加载） | 同上 |
| 切回 `genA` | 再次出现就绪行；`genA` bundles 未被 `genB` 影响 | 同上 |
| boot 后 profile 目录 | DSH 每次 boot **重写** `<profile>/cordis.yml` → profile 目录是**可变运行状态**，不属于"不可变已提交代" | 同上 |

就绪行来自 `@deepseek-ai/dsh-web-app`（与 HDSL 现有 `readiness.ts` 解析同一行），因此它是**运行期实际加载 web-app bundle** 的 marker，不是 `--dump-config`。这收敛了机制方向，但**尚未**完成 E10b：HDSL 生产启动 argv / 提交顺序未接线，"旧代加载集合 == 组成摘要"的双代端到端未证。

**发布/切换崩溃窗口（废弃原型，非生产）**：`scripts/research/e10b-publish-crash-prototype.mjs` 4/4 验证了 P-A 排序（先发布 profile、后切指针）的四个崩溃窗口：W1 发布前、W2 发布中、W3 发布后切指针前、W4 切指针后；并得出**回收必须由事务 journal 键控**（而非"非当前活动代"），否则会错误删掉仍可供 `restore` 的旧代 profile。仅排序语义，不含 fsync/持久性保证。

证据等级：P1–P3 为 `raw`（config 解析路径）；运行时 marker 为 `raw`（真实 boot 自有 fixture）；崩溃原型为**原型**（非生产，无持久性保证）。

**候选机制（仍不预选；P-A 为当前证据支持方向）**：

| 方案 | 机制 | 需要的证据（E10b） | 风险 |
| --- | --- | --- | --- |
| P-A 共享 home + 每代 `--profile <genName>` | 启动传 `--profile <generation-profile-name>`；每代组成落在 `$DSH_HOME/profiles/<name>` | 真实 boot（非仅 dump）中"旧代加载集合 = 旧代组成摘要"；profile 发布的原子性与崩溃恢复；`profiles/node_modules` 回退 symlink 在换 DSH 安装时的行为 | 事务需要发布/切换共享 home 内的 profile 目录，D-A 需改写为"不修改用户运行数据，但可发布自己的代际 profile" |
| P-B 每代 `DSH_HOME` + 共享运行数据 | 保留 `<gen>/home` 与各代 profile；把 `sessions`/`storages`/凭据等 symlink/挂载到环境级 | symlink 跟随、rename 跨 symlink、上游写入语义、半初始化崩溃 | **未证 symlink 安全**，不得预判 |
| P-C 共享 home + 环境级单一 profile | 接受插件集是环境级 | 则必须修订 D-B/§4.1/D18-2：`restore` 不还原插件组成，插件回滚不在本 MVP | 与 #73/#76 的"代际回滚插件"目标冲突 |
| P-D 独立 config 根覆盖 | 若上游支持 profile 根覆盖 | 需要 rc.2 实测支持；当前源码只显示 `$DSH_HOME/profiles` | 证据不足 |

**硬门禁 E10b**：在固定 rc.2 上（真实 boot）证明所实现机制满足"**恢复后旧代实际加载集合 == 该代组成摘要**"（已收敛为 P-A 方向并有运行时 marker 证据），**并**把该机制接入 HDSL 启动/提交顺序、在双代接缝上端到端证明（旧代失败后仍可启动、摘要不变、发布/切换崩溃恢复）。后两者未完成，因此 E10b **仍未关闭**；在此之前 §2 D-B 的代际组成只作设计目标，不得当作已交付能力。

该决策在获批后取代 ADR 0005 D18 中"机制延后由 002 决定"的待定状态；**批准前 D18 待定状态不变**（获批时再更新 ADR 0005 §9.7/D18 指针）。D18 的四条不变量不变。

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

**与 §2.3 的关系（重要）**：上表比较的是**运行数据**的派生方式，**不是**"每代 profile 如何被 DSH 加载"。creation 探针（§6）只观察到删除作用域，**不能单独否证复制方案**（其场景没有已提交旧代）；复制方案的否定依据是 G5/D18-3/E10 的设计推理，不是该探针。profile 加载机制另见 §2.3/E10b。

## 4. 归属、旧代条件与数据回退限制

### 4.1 归属表

| 对象 | 归属 | 事务行为 | 导出/整合包 |
| --- | --- | --- | --- |
| 受管运行时（node/dsh 产物） | 代际（不可变） | 新建 stage | 否（按摘要引用） |
| profile 三元组（`package.json` + `pnpm-lock.yaml` + 生成 `cordis.patch.yml`） | **组成身份**归代际；**物理加载位置未决（E10b）** | 新建 stage；共享 home 下需经批准机制发布到 `$DSH_HOME/profiles/<name>` 或等价位置 | 组成摘要，不含凭据 |
| `composition.lock.json` / `generation.json` / `install-manifest.json` | 代际（不可变） | 新建 stage；提交后才可被指针引用 | 摘要/来源锁 |
| `home/` 目录 | 环境（可变、共享） | **只读校验，不复制不删除** | 否 |
| `.credentials.yaml`（0600，含密） | 环境（含密） | 只读校验存在性/权限，不读内容 | **永不** |
| `.anonymous-user-id` | 环境（私有） | 不触碰 | 否 |
| `sessions/`、`storages/` | 环境（可变运行数据） | 不触碰 | 否 |
| 用户 patch `$DSH_HOME/cordis.patch.yml` | 环境（用户拥有） | 不触碰；卸载若被其引用则 `REFERENCED_BY_OTHER`（D15） | 否 |
| `data/`（DSH 进程 cwd） | 环境（可变） | 不触碰 | 否 |
| `<gen>/config/` | 当前**无消费者**（`manager.ts` 只把 `dataDirectory` 当 cwd；`configDirectory` 仅透传） | S2 删除该字段或明确归属；**目标布局不引入 `<env>/config/`** | 否 |
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

> **实现状态：`ChangePhase`/`ChangeFaults` 目前只是设计提案，无实现、无测试、无公共导出。** 不得当成已交付 seam 或被 QA 引用为现有接口。

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

**与 profile 发布的顺序（E10b 未定前不写定）**：若 E10b 选择 P-A/P-B（事务需要发布/切换共享 home 内的 profile），则提交点必须同时覆盖"指针"与"profile 已可被新代读取"。候选顺序（待 E10b 选定）：先发布本代 profile（未提交、未被指针引用），再原子切换指针；崩溃于两者之间 → 指针仍指旧代，新 profile 为未被引用的孤儿，由 recover 清理。在 E10b 通过前，本表只描述指针提交点。

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
| D18-1 事务不破坏运行数据 | 事务代码路径不写用户运行数据；实证 A1–A4 | 结构性推理 + 合成 fixture（事务删除作用域）；**非真实 DSH 数据安全证据** |
| D18-2 提交前失败旧代可启动 | 需 S2 双代 seam：gen1 已提交 → gen2 stage → 提交前失败后仍指向 gen1、可启动且摘要不变 | **未证**（creation 探针是单代 create 事务，无已提交旧代，不能代替） |
| D18-3 运行数据不分叉 | 环境级单份 home（设计选择）；A3/B1 仅为删除作用域观察 | 设计选择；探针的 env home 是 harness 自建、当前代码不认识该路径 |
| D18-4 含密产物不外泄 | 结构断言 A6/B3（任何代目录下无 `.credentials.yaml`）；导出/整合包排除属既有 ADR 0002 门禁 | A6/B3 已证；导出排除为既有门禁 |
| E10 运行数据派生（home/data） | 本 ADR §2 决策 + §5 相位/注入形状 | **数据部分已决策**；实现属 S2 |
| **E10b 每代 profile 加载机制** | rc.2 真实 boot 证明"恢复后旧代实际加载集合 == 该代组成摘要" + profile 发布原子性/崩溃恢复 | **部分**：P1–P3（`--profile` 选 `$DSH_HOME/profiles/<name>`、 bundles 来自 profile `package.json`、两个 profile 可分别选择）已实测；**加载等价性与原子性未证** |
| E10 崩溃恢复 | 每相位抛错 + `SIGKILL` + `recover()` 解释 | 部分：rollback/finalize 分支已证；全相位注入属 S2 |
| E9 `--dump-config` 等价性 | 受控 marker 实证 | **未证**，见 §7 |

## 7. 未决与后续闸门（不得当作已实现）

- **E10b 未关（阻塞 D18-2/D15 的插件集部分）**：§2.3 已在固定 rc.2 上（真实 boot）证明 `--profile` 选择 profile 且 web-app marker 绑定于所选 profile 的 bundle 集，并用废弃原型验证 P-A 的四类发布/切换崩溃窗口（含"回收由 journal 键控"）。但**HDSL 生产启动 argv / 提交顺序未接线**，双代端到端（真实 HDSL 事务 + 真实 boot）未证。候选机制 P-A 为当前证据支持方向，P-B **不预判 symlink 安全**。E10b 未关前不得宣称旧代加载其自身组成，也不得把 D18-2/D15 写成已满足。
- **E9 未证**：`--dump-config` 的静态性（不 require/执行 bundle 模块）以及"离线解析组合树 == 运行期实际加载集合"的等价性仍未验证。本片的 E10b 运行时 marker（§2.3）证明的是"真实 boot 加载 web-app bundle"，**不能**替代 E9（它没有证明 dump-config 与运行时加载集合逐项等价，也未做 bundle 代码执行 marker）。在 E9 前，生效判据仍只写"活动代际记录 + 离线解析组合树"。
- **受管 pnpm 身份（E1）**：候选 `11.7.0` 仍未以受管方式冻结。本片只做了一次有界只读**网络**官方来源核对：`npm view pnpm@11.7.0`（`https://registry.npmjs.org/pnpm`）返回 `11.7.0`、`dist.integrity = sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==`、`engines.node >= 22.13`。这是官方来源/版本约束核对，**不是**受管执行器冻结证据：仍需 S2 决定 HDSL 如何随包固定该 tarball 并在 apply 时校验摘要；宿主 pnpm `11.7.0` 不作为证据。
- **上游 home 数据版本兼容（§4.2 条件 4）**：需真实 session 迁移实验；当前只到格式版本/home 形态证据。
- **实现落地与首次迁移**：布局从 `<gen>/home` 迁到 `<env>/home` 需要一次性、可崩溃恢复的迁移；具体持久标志/提交点/启动前恢复顺序/含密副本生命周期/已提交代不可变的一次性例外见 [S2 设计 §1.1](../../specs/002-plugin-transactions/s2-home-and-transaction-design.md)；实现属 S2。
- **E5 事务崩溃对账**：S2 需按 §5 相位补齐 `SIGKILL` 注入与 `recover()` 断言。

## 8. 后果

- 事务的"D18-1 不破坏运行数据"变成结构性属性（事务不写 home），而不是靠复制/回滚的细致顺序。
- 插件变更不再随代际复制用户数据；磁盘与切换时延恒定。
- 代价：旧代与新代共享同一份 DSH 数据目录，因此**不支持跨代的数据 schema 降级**，恢复必须给出可解释告警（§4.2-4）。
- 目标布局与当前 `generationPaths().homeDirectory`（G1）不一致；迁移前不得宣称 D18 已交付实现。
- E9 未证前，"生效"证据等级不超过"活动代际 + 离线解析组合树"（ADR 0005 D15）。

## 9. 验证状态

- 决策：本 ADR 已给出（`proposed`，rev 2）。**批准前不据此修改生产实现**。
- 实证：
  - `scripts/research/home-derivation-probe.mjs`（合成运行时 + 真实 `@hdsl/core` dist，零网络）在 macOS ARM64、Node `24.21.0` 上 **11/11 通过**：只证明事务删除作用域与指针提交点。
  - `scripts/research/dsh-profile-mechanism-probe.sh`（自有副本 + 已核身份的真实 rc.2 安装）实测 P1–P3：`--profile <name>` 选 `$DSH_HOME/profiles/<name>`，bundle 集来自 profile `package.json`，两个 profile 并存被各自选中。
  - `scripts/research/dsh-profile-runtime-marker-probe.sh`（真实 boot、自有 fixture、零模型/凭据）：Web-app 就绪行作为运行时 marker，证明选定 `--profile` 决定运行期加载集，A→B(无 web-app)→A 可切换且互不影响。
  - `scripts/research/e10b-publish-crash-prototype.mjs`（**废弃原型**，非生产）4/4：P-A 发布/切换四类崩溃窗口，旧代 lock 字节不变，孤儿回收必须由 journal 键控。
- 记录见 [plugin-home-derivation-validation.md](../development/plugin-home-derivation-validation.md)。
- 未验证：**E10b 生产接线与双代端到端未证**；E1、E9、E2/E4/E5/E6/E7 与真实安装/桌面路径未证。本片运行了固定完整性 rc.2 自身的真实 boot（自有副本、无第三方插件代码），未调用模型、未读个人凭据。
- 本 ADR 不关闭 #76，也不宣称 #76 门禁已满足（E10b 与 S2 实现仍需后续；见 §7）。
