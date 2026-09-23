# A2 版本切换：验证记录（#114）

范围：同环境组成切换（`environments.switchCombination`）的事务、回滚、恢复、幂等与
回退数据兼容提示。基线 `ea7f5717c8c2eb9cb051c451fcb4298b3bb71bfa`。

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

- 本切片只覆盖 Node 轴 + 切换事务；**不**承诺跨版本 home 兼容（ADR 0006 D6 / R006）。
- renderer「切换版本」控件与回退确认框**未实现**（本 PR 不触碰 renderer）。
- 第二个 DSH 版本与 `packages/runtime/src/catalog/**` **未**改动。
- 跨服务互斥：`switchCombination` 与 apply/restore 通过各自的 journal 命名空间互斥；
  未新增跨进程全局锁（沿用既有 data-root lease 与单事务不变量）。
- 孤儿 `in-progress` switch 账本（账本写入与 journal 写入之间崩溃）由 `recover()` 在无
  活跃 switch 事务时结清为受控失败；create 侧同形窗口不在本切片范围（既有行为）。
- 提交前失败/回滚只删新 stage 代目录；已发布但未被引用的 `hdsl-<gen>` profile 保留在
  共享 home（沿用 MF1 无 GC 决策），属已知残留。
