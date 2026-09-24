# 插件 pnpm transport 规格：固定 commit 的官方 codeload tarball（#141）

状态：**已实现**（refs #141）。范围：`packages/runtime/src/plugins`。本文只描述该变更与边界，不替代 [#141](https://github.com/YingkeSu/HDSL/issues/141) 的证据记录。

## 1. 变更与动机

- 现状：目标声明与 apply 的 profile 声明都把依赖写成 `github:<owner>/<repo>#<40hex>`。pnpm 在解析该简写时先走 `fromHostedGit → isRepoPublic` 的 GitHub **HEAD 探测**；该探测顶层没有 `timeout`，`retry` 又被硬编码为 0，因此在探测不返回时会一直等待（#141 插桩证据：`HEAD.probe` 仅 begin、无 end，受管 Node `22.19.0` 下同样复现）。
- 变更：HDSL 记录 **SOURCE** 仍为 GitHub 仓库 + 完整 commit（`PluginSourceLock.sourceKind === 'github'`、`repository`、`commitSha`、`manifestSha256`），但交给 pnpm 的 **TRANSPORT** 规格改为同一 commit 的官方 codeload tarball：
  `https://codeload.github.com/<owner>/<name>/tar.gz/<40hex>`。
- 两处构造点共用同一纯函数 `pluginTransportSpec`（`packages/runtime/src/plugins/source-spec.ts`）：`target-profile.ts` 的目标声明与 `apply-port.ts` 的 profile 声明。
- 该函数 fail-closed：commit 必须是 40-hex（拒绝分支/标签等浮动 ref）、host 固定 `codeload.github.com`、owner/name 只能是普通路径段。

## 2. 保持不变的语义

- **来源身份**：`sourceKind`/`repository`/`commitSha`/`manifestSha256` 均保留，未改成 tarball 来源，也未引入浮动来源。
- **锁与闭包**：生成锁的 `packages`/`snapshots` 键仍是 `name@<codeload URL>`，`resolution` 仍是 `{gitHosted: true, integrity, tarball}`；`resolveLockClosure`/`targetRetentionInLock` 与 `buildScriptKey`（`source: 'dependency'`）行为不变。
- **安全边界**：不绕过归档/lock `integrity`、`--ignore-scripts`、显式构建授权；未知服务仍只记为 risk。

## 3. 用户可见变化（必须明示）

- 持久化 profile 声明的 dependency **specifier** 由 `github:…` 变为 `https://codeload.github.com/…/tar.gz/<commit>`。这是 **transport 声明** 变化，**不是来源变化**：plan/preview 的 `sourceLock` 仍显示 GitHub 来源与精确 commit。
- 旧 generation / 旧 profile / restore 保持可读；**不自动迁移**旧声明。

## 4. 旧计划失效

`planInputsDigest`（`preview-resolution.ts`）现在把 transport 规格纳入绑定。旧代码生成的计划 digest 不含该绑定，因此 apply 在重新解析后于 **`apply-port.ts` 的 digest 校验处以 `PLAN_STALE` 拒绝，且发生在任何 profile 写入/安装副作用之前**；不依赖进程重启清缓存。新 preview 与 apply 使用同一公式，保持一致。

## 5. 证据边界

- 等价性仅在 **`Hisn00w/ASu-skills@feb77307b45e9c4a9890e385748eebe5a919eb1b`** 这一个 pin 上以隔离 lockfile-only 解析验证（`exit 0 / ~7s`，锁形状与历史 gitHosted 形状逐字段相同）。**不**证明所有 GitHub 包普遍兼容。
- 网络层停滞的最终相位（DNS/TLS/响应头/正文/服务端）仍未定位；本变更通过规范化 transport 规格规避该探测路径，而非宣称修复 pnpm 或 GitHub。

## 6. 验证

- 确定性测试：`tests/plugins/source-spec.test.ts`（完整 pin/host/字符约束、plan 绑定）、`tests/plugins/target-profile.test.ts`（目标声明使用 codeload URL）、`tests/plugins/apply-port-refusal.test.ts`（旧计划 `PLAN_STALE` 且无副作用）。
- 门禁：`pnpm run typecheck`、`pnpm run build:desktop`、`pnpm test`、`python3 scripts/check_repository.py`。
- 真实链：隔离组合树上以 PR 的 opt-in 第三方插件验收测试执行；结果见 #141 与本 PR 描述。
