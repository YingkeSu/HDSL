# S2 设计：代际 home 派生与变更事务（#76 门禁）

状态：**设计草案（proposed）**。机制决策见 [ADR 0006](../../docs/adr/0006-generation-home-derivation.md)；实现属 S2，本文件只固定 S2 的实现边界与验收口径，批准前不改生产代码。契约面仍以 [ADR 0005](../../docs/adr/0005-plugin-contract-evolution.md) §4 为权威。

本文件回答 [002 规格](spec.md) 中"未决与依赖"列出的 #76 硬前置（ADR 0005 D18/E10）：
home 派生机制、含密文件与可变运行数据归属、旧代恢复语义、崩溃恢复的相位/注入形状，以及 D18/E10 的验证方案。

## 1. 目标布局（S2 实现切片）

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `<env>/environment.json` | 环境 | 活动代际指针、revision、state |
| `<env>/home/` | 环境（共享、可变） | 目标 `DSH_HOME = HOME`；`sessions`/`storages`/`.credentials.yaml`/`.anonymous-user-id`/用户 `cordis.patch.yml` 均在其下 |
| `<env>/data/` | 环境（共享、可变） | DSH 进程 cwd |
| `<env>/generations/<gen>/` | 代际（不可变） | 运行时产物、`composition.lock.json`、`generation.json`、`install-manifest.json`、profile/lock 三元组 |

- 目标 `generationPaths().homeDirectory` = `<env>/home`，**不再**是 `<gen>/home`（当前实现见 ADR 0006 G1/G2）。
- 代目录**不得持久包含** `home/`、`sessions/`、`storages/`、`.credentials.yaml`；事务只写暂存组成。
- **profile 加载机制（P-A 方向）**：共享 home 下 DSH 固定读取 `$DSH_HOME/profiles/<name>`；本代 profile 必须发布到 `hdsl-<gen>` 命名空间的 profile 目录，启动 argv 传 `--profile hdsl-<gen>`。**组成身份取自 staged 声明源**（`package.json`/`pnpm-lock.yaml`/`cordis.patch.yml`）；boot 重写的 `cordis.yml`、`node_modules`、`profiles/node_modules` 回退 symlink 是 live 派生状态，**不得**参与身份或摘要重建。GC 仅限 `hdsl-` 命名空间；被指针引用的 profile 永不删。
- **`<gen>/config/`**：当前无消费者（`manager.ts` 只用 `dataDirectory` 作 cwd）；目标布局**不引入** `<env>/config/`，S2 删除该字段或明确其归属。

### 1.1 首次布局迁移（`<gen>/home` → `<env>/home`）

旧环境只有一个活动代，但迁移仍需作为**独立、可崩溃恢复、先于任何启动**的前置步骤，不能隐含在 `apply` 或 `start` 里。

- **持久标志**：`<env>/migration/home-v2.json`（`schemaVersion` + `sourceGenerationId` + `state ∈ pending|copying|copied|verified|finalized` + `createdAt`/`updatedAt` + 逐项摘要）。标志缺席 = 尚未迁移。
- **分支：空环境/无旧位置**：若 `activeGenerationId=null`（探针 A5 证明可达）或活动代无 `<gen>/home`，直接写 `state=finalized`（跳过复制，**不算失败**）。
- **分支：新布局下新建环境**：创建提交时直接建 `<env>/home` 并写 `state=finalized`（源代即本代，无旧位置），使 `recover` 不会尝试迁移新环境；“标志缺席”仅用于识别旧环境。
- **提交点**：`state=finalized` 的原子写入 + 旧位置删除完成。`finalized` 之前，`<env>/home` 不被任何启动/事务当作已就绪。
- **启动前恢复顺序**（在已验证 data-root lease 内）：`recover()` → 若标志存在且非 `finalized` → 先完成/重跑迁移 → 再允许 `start`/`create`/`apply`；未就绪时以可解释状态拒绝启动，不暴露"空 home"。
- **含密副本生命周期**：复制 `.credentials.yaml` 时保留 0600，只校验权限与存在性、不读内容；先复制到临时目录并 `fsync` 文件+目录，校验后原子 `rename` 到 `<env>/home`；**旧副本只在 `<env>` 副本校验通过后才删除**；迁移完成后断言环境级单份。
- **覆盖范围**：`home/`、`data/` 同步迁移；`<gen>/config/` 无消费者，不迁移（见 §1 目标表）。
- **已提交代不可变的一次性例外**：迁移会读取并（仅在校验通过后）删除既有活动代的 `<gen>/home`。这是**一次性、按环境一次、仅限 `home`/`data`、仅在未运行时**的显式例外，不改动该代的运行时产物/组成锁/manifest；必须在代纪录/迁移标志中留痕（tombstone）。除该例外外，已提交代目录不可变。
- **rename 不可见性 guard**：断言"`<env>/home` 存在 ⟺ 原子 rename 已完成"；不存在 `<env>/home` 的**部分内容**这种中间态（写入只发生在临时目录，最终整体 rename）。
- **半复制/fsync/删旧崩溃恢复**：
  - 崩于复制中：临时目录不完整、尚未 rename → `<env>/home` 不存在 → 丢弃临时、以旧位置为源重跑；
  - 崩于 rename 后、删旧前（`state=verified`）：以已校验的 `<env>` 副本为准，删除旧副本后进入 `finalized`；
  - 崩于删旧中：源仍然存在（删除不完整）→ 重跑删除即可；
  - `<env>` 副本已校验但标志未落盘：以内容/摘要重校验，幂等进入 `finalized`。
- 迁移不得把含密产物复制到环境外；失败证据不得包含凭据内容。

## 2. 归属与凭据（实现不变量）

- `.credentials.yaml`：环境级单份、0600；事务只做存在性/权限只读校验，不读内容、不复制、不改写、不进导出/日志/整合包（ADR 0002）。
- `sessions/`、`storages/`、`.anonymous-user-id`、用户 patch：环境级，事务不触碰；卸载若被用户 patch 引用 → `REFERENCED_BY_OTHER`（kind `userPatch`，ADR 0005 D15）。
- 计划缓存、journal、失败证据、TTL 记录：应用数据，允许写，不算副作用（ADR 0005 D6）。
- 错误与事件文本不得含 token/cookie/绝对路径/凭据（既有出站脱敏门禁）。

## 3. 事务相位与提交点

```
planned → staged → verified → committed → finalized
                              ^ 提交点 = environment.json 中 activeGenerationId/revision 的原子写入
```

| 相位 | 内容 | recover 解释 |
| --- | --- | --- |
| `planned` | 计划复核通过、op/journal 已建 | 指针未变 → rolled-back（仅清 stage） |
| `staged` | 新代目录与组成/profile 暂存 | 指针未变 → 删 stage |
| `verified` | 离线解析组合树 + 共享 home 只读校验通过 | 指针未变 → 删 stage |
| `committed` | 指针已指向新代；写来源锁/启用引用 | 指针已指向 → finalized（**不删**） |
| `finalized` | journal 清理、幂等账本 completed | 无残留 |

- 提交前失败/取消：只清理本次 stage 代目录与未被指针引用的本代 profile（若 E10b 选 P-A/P-B）；环境组成、活动代际指针、用户运行数据不变；journal/失败证据准确写入。
- 提交后取消：`CANNOT_CANCEL`；如实报告"已提交，可显式 `generations.restore`"，不得称已回滚（ADR 0005 D10）。
- 运行中 apply 拒绝（`ENVIRONMENT_BUSY`）；同环境并发 apply 仅一个事务（既有幂等/忙碌语义）。
- **与 profile 发布的顺序待 E10b 选定**（ADR 0006 §5）：若事务需发布共享 home 内的 profile，则提交点需同时覆盖"指针"与"profile 可被新代读取"，崩溃于两者之间时新 profile 为孤儿、由 recover 清理。

## 4. 旧代可启动与数据回退限制

旧代可启动条件与数据回退限制见 ADR 0006 §4.2/§4.3。S2 实现必须：

- 回滚/失败**从不删除已提交的代目录**（当前 G4 会删除未提交 stage，这是允许的；不得扩大为删除已提交代）。
- `generations.restore` 只切换指针；运行中拒绝；目标代不存在/损坏 → 受控错误、无副作用。
- 在代际记录写入"最近一次以该代启动的 DSH 版本"，供 `restore` 呈现数据兼容告警（ADR 0006 §4.2-4）。
- 不承诺：数据 schema 降级、会话/存储字节还原、workspace 还原、删除新代写入的数据。

## 5. 故障注入公共形状

> **`ChangePhase`/`ChangeFaults` 是设计提案，当前无实现、无测试、无公共导出**；不得被当作已交付 seam。

```ts
type ChangePhase = 'planned' | 'staged' | 'verified' | 'committed' | 'finalized';

interface ChangeFaults {
  readonly failAt?: ChangePhase;
  readonly pauseAt?: ChangePhase;
}
```

- `pauseAt: 'verified'` 对齐既有 `CreationFaults.pauseBeforeCommit`；`failAt: 'verified'` 对齐 `failBeforeCommit`。
- 每个边界支持**抛错**与 **`SIGKILL`** 两种注入。
- 事务不改用户运行数据，故不存在"home 派生中/派生后"相位；崩溃窗口为：stage 中、指针切换前、指针切换后（未 finalize）。若 E10b 选 P-A/P-B，还需覆盖 profile 发布与指针之间的窗口（ADR 0006 §5）。

## 6. 验证方案与 seam

| 门禁 | seam | 断言 |
| --- | --- | --- |
| 事务不破坏运行数据 | 事务 seam（默认 CI，假执行器） | 崩溃/失败后 env 级 home 字节不变、可读、0600 保持 |
| 提交前失败旧代可启动 | 事务 seam | 指针未变、旧代完整、只有 stage 被删、状态可解释（**双代场景，S2 实现后**） |
| 提交/回滚对账 | 事务 seam + `recover()` | 每相位抛错与 `SIGKILL` 后 journal 解释正确 |
| 每代 profile 加载（E10b） | 真实 rc.2 opt-in | 恢复后旧代实际加载集合 == 该代组成摘要；发布原子性/崩溃恢复 |
| 含密文件不外泄 | 既有导出/日志门禁 + 代目录无 `.credentials.yaml` 结构断言 | canary 不出现 |
| 真实闭环 | 真实 desktop（opt-in） | 预览→安装→重启生效→卸载→失败回滚；本地受控来源 |

默认 CI 完全离线；真实 GitHub/真实安装不进默认 CI（ADR 0005 D19）。E9（`--dump-config` 等价性）与 **E10b（每代 profile 加载等价性）均未证**：未证前生效判据只写"活动代际记录 + 离线解析组合树"，不得写"运行期实际加载集合"，也不得宣称旧代加载其自身组成。

### 6.1 最小实证 checklist（区分实现前机制证据 / 实现后生产回归）

> **实现前必须闭合**（review `5774788522`）：E10b-1～4 + 全相位抛错/`SIGKILL` 原型 + M1–M3。未闭合不得开生产实现。

**实现前（机制证据；仓库外废弃原型 / 入库 research 脚本）**
- [x] E10b-1（部分）真实 boot：选定 `--profile <gen>` 后运行期加载集绑定于声明集（web-app 就绪行 marker；负控为**存活 no-ready** + loader 已运行，非崩溃）。**待收尾**：在 profile 内实际安装一个已审 bundle，并断言完整加载集合与摘要绑定。
- [x] E10b-2 双代切换：A→B→A 各自加载自身集，互不污染。
- [x] E10b-3 发布/切换崩溃窗口 W1–W5 + 真实子进程 `SIGKILL`/抛错（`staged`/`published`/`pointed`）：旧代 lock 字节不变；**指针引用者永不删**；W5 roll-forward。
- [x] E10b-4 `profiles/node_modules` 回退 symlink：跨安装 per-boot heal，依赖单一活动代不变。
- [x] 迁移四类崩溃分支 + 空环境/新环境分支（设计 + 部分原型）。
- [x] M2 身份边界：身份取自 staged 声明源；live 派生状态排除；摘要不得从 live 重建；`restore` 重发布/复用规则。
- [ ] E9：`--dump-config` 静态性（受控 bundle 代码执行 marker）——**未闭合**。

**实现后（生产回归，需机制证据独立审核后）**
- [ ] 真实启动 argv `--profile hdsl-<gen>` 接线与提交顺序（先发布、后切指针）。
- [ ] 真实双代端到端：gen1 已提交 → gen2 stage → 提交前失败后仍指向 gen1、可启动且摘要不变。
- [ ] 真实布局迁移 + 崩溃恢复；`changes.*`/`generations.restore`。
- [ ] 默认拒执行哨兵（依赖闭包）；受管 pnpm 身份冻结（E1）。
- [ ] 真实安装/桌面（opt-in）；Windows 未测不声明。

## 7. 本阶段已交付/未交付

- 已交付：ADR 0006（rev 2 + 机制收敛）决策与 E10b 门禁；本文档；可复现实证 `scripts/research/home-derivation-probe.mjs`（11/11）、`scripts/research/dsh-profile-mechanism-probe.sh`（rc.2 P1–P3，含 web 未被改写断言）、`scripts/research/dsh-profile-runtime-marker-probe.sh`（真实 boot marker）、`scripts/research/e10b-publish-crash-prototype.mjs`（4/4，废弃原型）；记录 `docs/development/plugin-home-derivation-validation.md`。
- 未交付：任何生产实现（布局迁移、`changes.*`/`generations.restore`、受管 pnpm、home 数据版本告警、启动 `--profile` 接线）；**E10b 生产接线与双代端到端未证**；E9/E1 未证；真实安装/桌面验收。
