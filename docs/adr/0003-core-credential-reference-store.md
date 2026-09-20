# 0003：core 环境凭据引用存储与 launch loader

- 状态：accepted（issue #52 / T005c，2026-09-20）
- 关联：#5（T005）、#6（组合根/界面）、#43（dataRoot 锁与核心生命周期）、#44（T005b 凭据解析与进程注入）、#51（T005b.2 生产强制完整 `service#account`）
- 依据：ADR [0002](0002-credential-boundary.md)、`docs/development/credentials.md`（#44 合并实现）

## 背景

ADR 0002 规定受管用户凭据只以 OS 凭据存储（keychain/credential manager）的**引用**保存，启动时解析并注入显式子进程环境。T005b（#44 / PR #46）已交付解析与注入机制：

- `createLaunchCredentialPort({ load })` 要求调用方提供 `LaunchCredentialLoader = (environmentId) => Promise<{ bindings, baseEnv }>`；
- 进程模块（#5 / PR #48）持有 `LaunchCredentialPort` 并调用 `resolveLaunchEnvironment(environmentId)`。

但**没有任何生产 loader，也没有 `CredentialReference` 的内部持久化来源**。进程模块读不到 core 的 `environment.json`，也不能 import core（`tests/engineering/workspace-boundaries.test.ts`）。因此需要在 core 内提供一个环境级、仅存引用的存储与 loader。

## 决策

1. **存储归 core**：新增 core-owned 环境级记录 `<dataRoot>/environments/<id>/credentials.json`，路径由环境 ID 内生生成，不接受调用方路径。
2. **只存引用**：记录仅含 `CredentialReference`（冻结 DTO `{ id, store, key }`）与环境变量绑定 `{ name, reference }`，绝不保存 secret 值；记录形状版本化并严格校验（未知字段拒绝）。
3. **内部受信 API**：写入/清除由 `EnvironmentService` 的受信方法提供，受 #43 的 dataRoot 独占锁与环境存在/状态守卫；**不新增任意 IPC 凭据查询方法**，不改变冻结 `contracts` 方法白名单。
4. **loader 归 core**：`EnvironmentService.launchCredentialRequest(environmentId)` 只读引用并用可信 `generationPaths` 构造显式 `baseEnv`（`HOME`/`DSH_HOME`/`DSH_AGENTS_HOME`/`PATH`/`TMPDIR`），不继承宿主 `process.env`。
5. **强制归 #44**：`service#account` 的 account 语义与 service-only 拒绝由 #51 的 `createLaunchCredentialPort` 生产路径统一强制；core 不重复实现 keychain 语义，也不加测试放行开关。
6. **fail-closed**：缺引用、记录损坏、失锁一律拒绝，无副作用，不隐式回退宿主环境或 `~/.dsh`。
7. **可见性**：记录权限 `0600`、原子写；引用与绑定不进入 `EnvironmentSummary`、renderer、诊断导出、普通日志或整合包。

## 替代方案

- **runtime 提供默认 loader 读 core 存储**：违反 core/runtime 不互相 import 的边界，拒绝。
- **把引用塞进 `environment.json` 或冻结 DTO**：改变冻结 wire 形状并有泄漏风险，拒绝。
- **只在内存/界面持有引用**：不跨重启持久化，重启后无法启动，拒绝。
- **单一全局 keychain item（固定 service/account）**：无法表达多环境不同凭据，且仍缺“来源”语义；作为 M1 的退化选项留给 #6 需求确认，不作为本决策的默认。

## 后果

- 新增 core-owned 存储 schema（版本化）；`EnvironmentSummary` 与冻结契约不变。
- #6 需要提供配置入口（受信 main 侧调用；不新增任意 IPC 查询），并在诊断导出默认排除该配置。
- #44/#51 负责 account 完整性与 service-only 拒绝；core 只保证产出完整引用绑定。
- 真实启动的组合（`createLaunchCredentialPort({ load })` + `createProcessManager({ credentials })`）由 #6 接线验收。

## 验证状态

- 实现：`packages/core/src/credential-store.ts`、`EnvironmentService` 接点；测试 `tests/core/credential-store.test.ts`。
- 已验证：完整引用返回、缺引用/损坏 fail-closed、状态守卫拒绝、`0600` 与原子写、baseEnv 构造、无 secret 落盘、core 不 import runtime。
- 待验证：#6 实际组合接线与真实 DSH opt-in 启动（归 #6/#5 后续）。
