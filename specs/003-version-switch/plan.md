# A2（#114）实施计划

基线 SHA：`ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa`（2026-09-23，`origin/main`）。
本文件对应首个实现 PR（Tier 1 only）。不得回退其他贡献者改动。

## 1. 所有权（首个 PR）

| 路径 | 本切片动作 |
| --- | --- |
| `specs/003-version-switch/**` | **新增** 规格/计划/契约/任务 |
| `packages/core/src/creation-service.ts` | **新增** switch 事务、journal kind 分支、恢复、启动守卫、最近启动记录 |
| `packages/core/src/journal.ts` | **追加** 可选 `kind: 'create' \| 'switch'`（缺失默认 create） |
| `packages/core/src/environment-store.ts` | **追加** 可选 `lastStartedGenerationId`/`lastStartedDshVersion` |
| `packages/core/src/generation-version.ts` | **新增** DSH 版本读取/排序/提示 |
| `packages/core/src/plugin-apply.ts` | restore 输出追加非阻断提示；只读 core switch journal 做互斥 |
| `packages/core/src/contract-port.ts`、`index.ts` | 接线与导出 |
| `packages/contracts/src/{dto,methods,dispatcher,context}.ts` | 追加 `switch` kind + `environments.switchCombination` + 可选提示字段 |
| `packages/contracts/src/testing/{fixtures,reference-port}.ts` | fixture 与内存端口 |
| `specs/001-environment-lifecycle/contracts/local-api.md` | 方法表 + fixture 表 |
| `tests/{core,contracts,acceptance}` | 新增/同步用例 |
| `docs/development/version-switch-validation.md` | 证据与边界 |

刻意**不触碰**：`apps/desktop/src/renderer/**`、`packages/runtime/src/catalog/**`、
第二个 DSH 版本、`packages/runtime/src/**` 任何文件。并行：#118、#7。

## 2. 事务语义

```text
planned → staged → verified → committed → finalized
                          ^ 提交点（activeGenerationId 原子写入）
提交前失败/取消 → rolled-back（仅删新 stage 代目录；环境记录不变，不置 error）
提交后崩溃 → recover 只 finalize（指针权威）
```

- journal 记录带 `kind: 'create' | 'switch'`（缺失默认 `create`，向后兼容）。
- `#failSwitch`/`#rollBackSwitch`：删新 stage + 失败 operation + 不碰环境记录；
  create 维持既有 `#markEnvironmentError` 语义。
- `#commitSwitch`：**不**写 home/data migration `finalized`；写 `generation.json.dshVersion`；
  指针 → 新代、`revision+1`、`state='stopped'`。
- 幂等：`requestId` 账本同 create；目标 digest == 当前 digest → no-op 成功（不产生新代）。
- 崩溃窗口：复用 `CreationFaults.pauseAfterPublishBeforePointer` / `pauseAfterPointerSwitch`。

## 3. 已实现步骤

1. 契约：`OperationKind 'switch'`、`environments.switchCombination`、
   `SwitchCombinationCommand`、dispatcher 分支、fixture、`reference-port`、
   `generationSummarySchema` 追加可选 `dshCompatibilityWarning`。
2. core：`switchCombination`（stopped-only 守卫、no-op、迁移收敛、journal kind、异步安装、
   提交前失败保旧代、提交后恢复 finalize）。
3. 启动守卫：`start` 在环境存在未决 create/switch journal 时返回 `ENVIRONMENT_BUSY`。
4. 版本记录：`generation.json.dshVersion`；`environment.json.lastStarted*` 在 start 成功后写入。
5. 回退提示：`generations.restore` 输出追加非阻断 `dshCompatibilityWarning`；同版本/未知不提示。
6. 确定性测试：`tests/core/version-switch.test.ts`（11 例）、
   `tests/core/generation-version.test.ts`、`tests/core/restore-compatibility-warning.test.ts`。
7. 真实 opt-in 证据：见 `docs/development/version-switch-validation.md`。

## 4. 未完成 / blocked（不得伪装成功）

- **renderer UI 控件**（环境详情「切换版本」、回退确认框展示提示）**未实现**：本 PR 明确
  不修改 renderer（并行冲突最小化）。调用面已通过 preload 白名单暴露（`CONTRACT_METHODS`
  自动派生），但 UI 入口在后续子 PR。
- **扩展支持范围（第二个 DSH 版本）未实现**：会改 `packages/runtime/src/catalog/**`（A1 同
  文件），必须分 PR，且先有安装/验证证据。
- **Tier 2 跨版本真实证据未做**：Tier 1 的 C22↔C24 只覆盖 Node 轴 + 切换事务；不冒充跨版本。
- **真实 macOS ARM64 全链 opt-in 证据**：记录在验证文档；未运行的项保持未测。
- Windows/Linux 未测。

## 5. 验证命令

```bash
pnpm run typecheck
pnpm run build:desktop
pnpm test
python3 scripts/check_repository.py
```

## 6. Tier 2（#131）

Tier 1 只证明 Node 轴；Tier 2 把第二个 DSH 版本纳入已支持范围并补真实跨版本回退证据。

| 路径 | 本切片动作 |
| --- | --- |
| `packages/runtime/src/catalog/combinations.ts` | **修改**：新增 `0.1.7-rc.1` 工件常量 + `VERIFIED_DSH_RELEASES`；4 个组合（2 Node × 2 DSH）；`CATALOG_REVISION` 更新 |
| `packages/runtime/catalog/dsh-0.1.7-rc.1/**` | **新增**：独立 `package.json` / `package-lock.json` / `closure.json` |
| `tests/install/composition.test.ts`、`tests/catalog/npm-versions.test.ts` | **同步**：双 DSH 闭包与 supported 派生断言 |
| `tests/install/real-install.evidence.test.ts` | **同步**：不再硬编码单 DSH 版本/包数 |
| `tests/install/real-cross-version.evidence.test.ts` | **新增**：真实安装/启动/停止 + 真实降级提示四态 opt-in 证据 |
| `docs/research/dsh-compatibility.md` | **追加** R007（0.1.7-rc.1 只读事实）与 R006 补充 |
| `docs/development/version-switch-validation.md` | **追加** §5 Tier 2 真实证据 |

刻意**不触碰**：既有 `dsh-0.1.5-rc.2/**` 字节、`environments.switchCombination`/`generations.restore` 语义、schema、renderer。

未自动跟随 `latest`/`next`/`alpha`；未验证平台（Windows/Linux）保持未测；不承诺跨版本
home/session 迁移。真实 opt-in 证据只对实际执行的 head 成立。
