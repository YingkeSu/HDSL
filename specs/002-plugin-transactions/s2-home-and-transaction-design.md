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
- 代目录**不得**包含 `home/`、`sessions/`、`storages/`、`.credentials.yaml`；事务只写暂存组成。
- 一次性迁移（实现切片）：旧环境只有一个活动代，开环境时若 `<env>/home` 不存在而活动代有 `<gen>/home`，以"先复制并 fsync、再切换指针语义"的方式迁移，最后才删除旧位置；迁移中断可重跑（幂等），未迁移完成前不删旧目录。迁移不得复制到环境外。

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

- 提交前失败/取消：只清理本次 stage 代目录；环境组成、活动代际指针、共享 home 不变；journal/失败证据准确写入。
- 提交后取消：`CANNOT_CANCEL`；如实报告"已提交，可显式 `generations.restore`"，不得称已回滚（ADR 0005 D10）。
- 运行中 apply 拒绝（`ENVIRONMENT_BUSY`）；同环境并发 apply 仅一个事务（既有幂等/忙碌语义）。

## 4. 旧代可启动与数据回退限制

旧代可启动条件与数据回退限制见 ADR 0006 §4.2/§4.3。S2 实现必须：

- 回滚/失败**从不删除已提交的代目录**（当前 G4 会删除未提交 stage，这是允许的；不得扩大为删除已提交代）。
- `generations.restore` 只切换指针；运行中拒绝；目标代不存在/损坏 → 受控错误、无副作用。
- 在代际记录写入"最近一次以该代启动的 DSH 版本"，供 `restore` 呈现数据兼容告警（ADR 0006 §4.2-4）。
- 不承诺：数据 schema 降级、会话/存储字节还原、workspace 还原、删除新代写入的数据。

## 5. 故障注入公共形状

```ts
type ChangePhase = 'planned' | 'staged' | 'verified' | 'committed' | 'finalized';

interface ChangeFaults {
  readonly failAt?: ChangePhase;
  readonly pauseAt?: ChangePhase;
}
```

- `pauseAt: 'verified'` 对齐既有 `CreationFaults.pauseBeforeCommit`；`failAt: 'verified'` 对齐 `failBeforeCommit`。
- 每个边界支持**抛错**与 **`SIGKILL`** 两种注入。
- 事务不写 home，故不存在"home 派生中/派生后"相位；崩溃窗口为：stage 中、指针切换前、指针切换后（未 finalize）。

## 6. 验证方案与 seam

| 门禁 | seam | 断言 |
| --- | --- | --- |
| 事务不破坏运行数据 | 事务 seam（默认 CI，假执行器） | 崩溃/失败后 env 级 home 字节不变、可读、0600 保持 |
| 提交前失败旧代可启动 | 事务 seam | 指针未变、旧代完整、只有 stage 被删、状态可解释 |
| 提交/回滚对账 | 事务 seam + `recover()` | 每相位抛错与 `SIGKILL` 后 journal 解释正确 |
| 含密文件不外泄 | 既有导出/日志门禁 | canary 不出现 |
| 真实闭环 | 真实 desktop（opt-in） | 预览→安装→重启生效→卸载→失败回滚；本地受控来源 |

默认 CI 完全离线；真实 GitHub/真实安装不进默认 CI（ADR 0005 D19）。E9（`--dump-config` 等价性）**未证**：本阶段只做受控 marker 实证设计，未证前生效判据只写"活动代际记录 + 离线解析组合树"。

## 7. 本阶段已交付/未交付

- 已交付：ADR 0006 决策；本文档；可复现实证 `scripts/research/home-derivation-probe.mjs` 与记录 `docs/development/plugin-home-derivation-validation.md`。
- 未交付：任何生产实现（布局迁移、`changes.*`/`generations.restore`、受管 pnpm、home 数据版本告警）；E1/E9 实证；真实安装/桌面验收。
