# home 派生、rollback 删除作用域与 rc.2 profile 机制实证（#76 门禁 / ADR 0005 D18 + E10/E10b）

状态：**在本会话候选上真实执行**。两份证据分开记录：**合成运行时的事务/回滚探针**（零网络）与**固定 rc.2 的 profile 选择机制探针**（只读自有副本、无模型、无第三方插件代码）。两者都**不是**产品安全保证或桌面验收，也不冒充真实 GitHub 链路。

## 元数据

| 项 | 值 |
| --- | --- |
| 任务 | [#76 S2 前置设计与有界实证](https://github.com/YingkeSu/HDSL/issues/76)，Parent #73 |
| 基线（已 fetch 核对） | `origin/main` = `21b653894dd58f92d4e59e42401e8e9e40dc8fe8`（PR #81 squash merge，含 ADR 0005） |
| 设计依据 | [ADR 0006](../adr/0006-generation-home-derivation.md)（rev 2）、[S2 设计](../../specs/002-plugin-transactions/s2-home-and-transaction-design.md) |
| 探针 1 | `scripts/research/home-derivation-probe.mjs`（合成运行时 + 真实 `@hdsl/core`/`@hdsl/runtime` dist） |
| 探针 2 | `scripts/research/dsh-profile-mechanism-probe.sh`（真实 rc.2 安装的自有副本） |
| 执行平台 | macOS（Darwin arm64），Node `v24.21.0`，pnpm `11.7.0`（宿主版本仅用于构建，**不是**受管执行器证据） |
| rc.2 安装身份 | `/tmp/hdsl-qa-model-env/.../gen-f8036e5e94f14e93`：`installMode=npm-ci`、`dsh.version=0.1.5-rc.2`、`dsh.sha256=f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480`（= `VERIFIED_COMBINATIONS`）、node `22.19.0`；探针只读该源，实验在 `mkdtemp` 自有副本内 |
| 网络（探针 1/2） | **无**。全文另有一次性 `npm view pnpm@11.7.0` 网络只读查询，单独标注，见"网络证据分栏" |
| 第三方插件代码 / 模型 / 个人凭据 | 未运行、未调用、未读取 |

## 证据 1：事务删除作用域与提交点（`home-derivation-probe.mjs`）

```sh
pnpm run build
node scripts/research/home-derivation-probe.mjs
```

结果 **11/11**：

```text
PASS A0 commit never happened: activeGenerationId=null state=creating
PASS A1 staged generation directory removed by rollback
PASS A2 structural: a file written under the staged generation home is removed by rollback
PASS A3 structural: environment-level home is outside the transaction delete scope and stays readable
PASS A4 credential-shaped file under env home survives with 0600: mode=600
PASS A5 rollback is explained: no active generation, operation failed
PASS A6 structural: no secret-shaped file left under any generation dir after rollback
PASS B0 commit switches the active generation pointer only after success
PASS B1 structural: commit does not touch the environment-level home written by the harness
PASS B2 committed generation home is a separate, empty directory (per-generation home baseline)
PASS B3 structural: no secret-shaped file left under any generation dir after commit
```

**能证明（精确边界）**

- 提交前失败的回滚/失败会删除**本次未提交的 stage 代目录**（含其中 `home/`）：`#fail`/`#rollBack` 的 `removePath(generationDirectory)`。A1/A2。
- 提交点 = 活动代际指针原子写入：提交前 `activeGenerationId=null`（A0），成功后才指向新代（B0）。
- 结构性观察：当前 creation 代码的删除作用域是**代目录**，因此 harness 写在 `<env>/home`（当前代码不认识的路径）上的文件在其回滚/提交后仍可读、0600 保持（A3/A4/B1）；提交/回滚后代目录下无 `.credentials.yaml`（A6/B3）。
- 现有基线为每代创建独立空 `home/`（B2）。

**不能证明（明确更正）**

- **不能否证"复制上一代 home"方案**：场景 A 没有已提交的旧代（A0 `activeGenerationId=null`，新建环境），副本是 harness 写进 **stage** 的。A1/A2 只说明"唯一副本放 stage 不安全"。复制方案的否定依据是 ADR 0006 §3 的 G5/D18-3/E10 设计推理，不是本探针。
- **不是旧代可启动/恢复证据**：没有双代场景，跑的也是 **creation** 事务，不是 S2 的 `changes.apply`。D18-2 需 S2 双代 seam（gen1 已提交 → gen2 stage → 提交前失败后仍指向 gen1、可启动且摘要不变）。
- **不是运行数据安全保证**：A3/A4/B1 中 `<env>/home` 由 harness 自建，当前代码不认识该路径，是同义反复式的"作用域观察"，不是真实 DSH 数据安全证据。
- 未做真实 DSH home 读写、数据 schema 兼容、全相位 `SIGKILL`、E9。

## 证据 2：固定 rc.2 profile 选择机制（`dsh-profile-mechanism-probe.sh`）

```sh
scripts/research/dsh-profile-mechanism-probe.sh <generation-directory>
# 本会话：
# scripts/research/dsh-profile-mechanism-probe.sh \
#   /tmp/hdsl-qa-model-env/environments/env-244d7d9a7be14517/generations/gen-f8036e5e94f14e93
```

输出（自有副本、fresh `DSH_HOME`、零网络）：

```text
identity OK: dsh 0.1.5-rc.2 sha256 f4c54839d69e82bf… installMode=npm-ci
P1/P2: initialise profile web from the shipped template and dump it
  web bundle-layer headers: 20
P3: initialise a second profile genA from web in the SAME home
  genA created at $DSH_HOME/profiles/genA
P2: rewrite genA bundles to base-only and re-dump
  web headers=20 genA-default headers=20 genA-baseonly headers=1
PASS: profile name selects the directory under $DSH_HOME/profiles; bundle set comes from that profile's package.json
NOTE: --dump-config output is config resolution, not proof of the runtime-loaded set (E9 remains open).
```

**能证明（机制可行）**

- P1：`--profile <name>` 选择 `$DSH_HOME/profiles/<name>`；`web` 是 `--profile web` 的硬编码别名；profile 不存在时从 shipped 模板初始化。也有 rc.2 `lib/bin.js` 源码佐证。
- P2：组合的 bundle 层来自该 profile `package.json` 的 `dsh.profile.bundles`（base-only 时 bundle 头 20 → 1，dump 行数 539 → 332）。
- P3：**同一个共享 `DSH_HOME`** 下 `web` 与 `genA` 两个 profile 可分别选择、互不覆盖。

**不能证明（→ 硬门禁 E10b）**

- **不等于运行期实际加载集合**：这是 `--dump-config` 的 config 解析路径；与真实 boot 加载集合的等价性属 E9，仍未证。
- **不等于 HDSL 可安全发布/切换 profile**：尚未证明在共享 home 内发布本代 profile 与指针切换的原子性、崩溃恢复；**未预判 symlink 安全**（候选 P-A/P-B/P-C/P-D 未选定，见 ADR 0006 §2.3）。
- 未证明 `profiles/node_modules` 回退 symlink 在跨代 DSH 安装变化下的行为。
- 因此：在 E10b 通过前，**不得**声称某代 profile 已生效、旧代加载其自身组成，或 D18-2/D15 已满足。

## 证据 3：E10b 真实 boot 运行时 marker（`dsh-profile-runtime-marker-probe.sh`）

同一个共享 `DSH_HOME` 下两代 profile，用 `@deepseek-ai/dsh-web-app` 的运行时就绪行 `dsh web: http://127.0.0.1:<port>/?token=…`（仅当 web-app bundle 实际加载后才打印）作为 marker。

```sh
scripts/research/dsh-profile-runtime-marker-probe.sh <generation-directory>
```

```text
identity OK: dsh 0.1.5-rc.2 sha256 f4c54839d69e82bf… installMode=npm-ci
  genA bundles=['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  genB bundles=['@deepseek-ai/dsh-base']
boot genA (web-app) -> ready|yes|-|4s
boot genB (base-only) -> no-ready|yes|-|25
boot genA again (switch back) -> ready|yes|-|3s
RESULT: PASS — the selected --profile determines the runtime-loaded bundle set;
        two profiles in one DSH_HOME are independent and switchable.
negative control: genB live no-ready for the full 25s window (exit code -), loader ran, so 'not loaded' is not a crash;
margin: web-app marker appeared in 4s vs 25s window (21s spare).
```

**能证明**：真实 boot（非 `--dump-config`）下运行期加载集绑定于所选 `--profile` 的声明 bundle 集；两代 profile 在同一 home 下独立且可切换。**负控强度**（review M1）：`genB` 必须显式 `no-ready` 且**窗口内进程存活**（`exited`/非零退出判 FAIL）、loader 确实运行（`<profile>/cordis.yml` 存在）；输出保留脱敏日志尾部与退出码。“未加载”不是“崩溃”。**不能证明**：完整加载集合与组成摘要的逐项绑定（web-app 就绪 line 是单一 marker）；HDSL 生产启动 argv/提交顺序已接线；也**不**替代 E9。

**附带发现**：DSH 每次 boot **重写** `<profile>/cordis.yml` → profile 目录是可变运行状态，不应放进"不可变已提交代"目录（支持 P-A）。

**本探针不含真实 `SIGKILL`**（用于 marker 绑定），真 `SIGKILL`/抛错见证据 5。

## 证据 4：P-A 发布/切换崩溃窗口（废弃原型，非生产）

`scripts/research/e10b-publish-crash-prototype.mjs`（仅文件系统层建模，无 fsync/持久性保证）：

```text
PASS W1 crash before publish: actions=[no profile hdsl-gen2, removed stage gen2]
PASS W2 defensive partial publish (atomic-rename gap, orphan removed): actions=[removed orphan profile hdsl-gen2]
PASS W3 crash after publish before pointer (orphan removed)
PASS W4 crash after pointer switch + committed journal (finalize, gen1 restorable)
PASS W5 pointer switched, journal uncommitted (roll-forward; active profile never deleted)
PASS N1 user/default `web` profile never touched by GC
PASS N2 GC confined to hdsl- namespace (non-managed name refused)
# 7/7 checks passed
```

**能证明（原型级）**：P-A 排序（先发布、后切指针）下旧代 composition lock 字节不变；**指针为权威**（被 `activeGenerationId` 引用的 profile 永不删，W5 roll-forward）；**journal 仅识别待处理事务**；**GC 限于 `hdsl-` 命名空间**（`web`/用户 profile 负控）；W2 在原子 rename 下不可达，仅为防御项。**不能证明**：真实 fsync/持久性、真实 HDSL 事务与真实 boot 的端到端。

## 证据 5：真实子进程 `SIGKILL`/抛错各相位（废弃原型）

`scripts/research/e10b-phase-kill-prototype.mjs` 真实 spawn `e10b-phase-worker.mjs`，在各可达相位发真 `SIGKILL`（观察 `signal==='SIGKILL'`）或让其抛错：

```text
PASS KILL@staged: signal=SIGKILL active=gen1 oldGenKept=true actions=[removed stage gen2]
PASS KILL@published: signal=SIGKILL active=gen1 oldGenKept=true actions=[removed orphan hdsl-gen2]
PASS KILL@pointed: signal=SIGKILL active=gen2 oldGenKept=true actions=[roll-forward: pointer references gen2; kept hdsl-gen2]
PASS THROW@staged: exit=1 active=gen1 newProfileKept=false actions=[removed stage gen2]
PASS THROW@published: exit=1 active=gen1 newProfileKept=false actions=[removed orphan hdsl-gen2]
PASS THROW@pointed: exit=1 active=gen2 newProfileKept=true actions=[roll-forward: pointer references gen2; kept hdsl-gen2]
# 6/6 checks passed
```

**能证明（原型级）**：真 `SIGKILL` 与抛错在各相位后，旧代 lock 字节不变、旧代保留；提交点后的失败（`pointed`）roll-forward 而非谎报回滚。**不能证明**：真实 HDSL 事务/journal 接线的 `recover()`。

## 证据 6（E10b-4）：跨代 DSH 安装的回退 symlink

`scripts/research/e10b-4-module-fallback-probe.sh`：两个自有 rc.2 安装副本 + 共享 home，真 boot：

```text
after boot genA (installA): home fallback -> <work>/installA/node_modules/@deepseek-ai/dsh
after boot genB (installB): home fallback -> <work>/installB/node_modules/@deepseek-ai/dsh
after re-boot genA (installA): home fallback -> <work>/installA/node_modules/@deepseek-ai/dsh
RESULT: PASS — the shared $DSH_HOME/profiles/node_modules fallback is healed per boot
        to the currently booting generation's DSH install.
```

**能证明**：共享回退路径每次 boot 被治愈到当前代际安装（A→A、B→B、再 A→A）。**设计含义**：该路径会随 boot 摆动，正确性依赖**单一活动代**不变（HDSL 已禁止并发 start/change）；并发 boot 竞态不在范围。**身份边界**：回退 symlink 是 live 派生状态，不参与组成身份。


- 探针 1/2：**零网络**（合成 fixture / 自有副本上的本地 dump）。
- 独立一次性只读查询（**有网络**，E1 官方来源核对）：`npm view pnpm@11.7.0` → `https://registry.npmjs.org/pnpm`，观测 `version=11.7.0`、`dist.integrity=sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==`、`engines.node>=22.13`。这是来源/版本约束核对，**不是**受管执行器冻结证据。

## 复现注意事项

- 探针 1 需要先 `pnpm run build`，读取 `packages/*/dist`；`--keep` 保留临时 data root。
- 探针 2/3/6 拒绝身份不符的安装；只复制 `dsh`（与 `node`）到临时目录，源不变；`KEEP=1` 保留工作目录。
- 探针 4/5 无外部依赖，直接 node 运行（探针 5 会真实 spawn 子进程并 `SIGKILL`）。
- **如何取得受管的 `npm-ci` rc.2 安装**（探针 2/3/6 依赖，未入库路径）：用 HDSL 自身在 macOS ARM64 上 `environments.create` 一个 `darwin-arm64-node22_19_0-dsh0_1_5-rc_2`（或 node24）环境，得到 `<dataRoot>/environments/<env>/generations/<gen>/`；探针会校验其 `install-manifest.json` 的 `installMode=npm-ci` 与 `dsh.version/sha256`，不符即 REFUSE。
- 所有探针只写 `mkdtemp` 目录，不触碰宿主 home。
