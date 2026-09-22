# home 派生与回滚实证（#76 门禁 / ADR 0005 D18 + E10）

状态：**在本会话候选上真实执行**（合成运行时 + 真实 `@hdsl/core` 事务/恢复代码；零网络）。这是布局/事务边界证据，**不是**真实 DSH 安装或桌面验收，也不冒充真实 GitHub 链路。

## 元数据

| 项 | 值 |
| --- | --- |
| 任务 | [#76 S2 前置设计与有界实证](https://github.com/YingkeSu/HDSL/issues/76)，Parent #73 |
| 基线（已 fetch 核对） | `origin/main` = `21b653894dd58f92d4e59e42401e8e9e40dc8fe8`（PR #81 squash merge，含 ADR 0005） |
| 设计依据 | [ADR 0006](../adr/0006-generation-home-derivation.md)、[S2 设计](../../specs/002-plugin-transactions/s2-home-and-transaction-design.md) |
| 探针 | `scripts/research/home-derivation-probe.mjs` |
| 执行平台 | macOS（Darwin），Node `v24.21.0`，pnpm `11.7.0`（宿主版本仅用于构建，**不是**受管执行器证据） |
| 运行时 | 假 `ManagedRuntimePort`（合成 `install-manifest.json`，`artifacts-only`），真实 `EnvironmentService`/journal/`recover()` |
| 网络 / 第三方代码 | 无；未运行任何插件代码，未读宿主 `$HOME`/`~/.dsh` |

## 命令

```sh
pnpm run build   # 探针 import packages/*/dist
node scripts/research/home-derivation-probe.mjs
```

## 结果（9/9）

```text
PASS A0 commit never happened: activeGenerationId=null state=creating
PASS A1 staged generation directory removed by rollback: generationDirectory exists=false
PASS A2 data inside the staged generation home is destroyed (proposition A refuted)
PASS A3 environment-level home survives rollback and stays readable: env home sentinel readable=true
PASS A4 credential-shaped file under env home survives with 0600: mode=600
PASS A5 rollback is explained: no active generation, operation failed: reconciled=1 rolledBack=1 activeGenerationId=null
PASS B0 commit switches the active generation pointer only after success: operation=succeeded activeGenerationId=gen-…
PASS B1 commit leaves an environment-level home untouched and readable
PASS B2 committed generation home is a separate, empty directory (per-generation home baseline): generation home entries=0
# 9/9 checks passed
```

## 解释

- **命题 A 被否证**（A1/A2）：提交前失败触发回滚/失败时，`#fail`/`#rollBack` 会 `removePath(generationDirectory)` 删除整个未提交 stage 目录，包括其中的 `home/`。因此"把用户运行数据复制进新代目录"的机制在提交前失败时会丢失 stage 内副本。这是可复现的失效形状，直接支持 ADR 0006 §3 否决方案 A。
- **命题 B 被确认**（A3/A4/B1）：环境级 home 在回滚（A3/A4）与提交（B1）后均未变化、可读，含密形状文件权限保持 0600。事务不写环境级 home。
- **提交点**（A0/B0）：提交前 `activeGenerationId` 始终为 `null`；只有成功后指针才指向新代。与 ADR 0005 D10 的提交点定义一致，也是 `recover()` 区分 finalize/rollback 的依据（A5）。
- **当前基线**（B2）：现有 `#commit` 为每代创建独立 `home/` 且为空；若插件变更沿用"新代 = 新 home"，用户会话/存储/凭据不会随代际延续。这正是 ADR 0006 要求把 home 提升到环境级的原因。

## 本证据不能证明

- 真实 DSH home 行为（`sessions`/`storages`/`.credentials.yaml`/用户 patch 的真实读写、数据 schema 兼容）；上游 home 行为仍是 `raw`（dsh-compatibility R003），本片未复验。
- 每个提交边界的 `SIGKILL` 注入与全相位 `recover()` 解释（本片覆盖 rollback/finalize 两分支与提交点；全相位属 S2 事务 seam）。
- 双代旧代启动/恢复的端到端（当前无 `changes.*`/`generations.restore` 公开方法；属 S2 实现）。
- `--dump-config` 静态性与运行期加载集合等价性（E9，未证）。
- 受管 pnpm 身份与未执行哨兵（E1，未证）。
- 真实安装、Electron 桌面或 Windows（Windows 未测，不声明支持）。

## 复现注意事项

- 探针需要先 `pnpm run build`；它读取 `packages/*/dist`，因此执行的是构建产物而非源码。
- `--keep` 保留两个临时 data root 供检查；默认自动清理。
- 探针只在 `mkdtemp` 目录内写文件，不触碰宿主 home。
