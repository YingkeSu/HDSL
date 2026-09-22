# 卸载闭环验证记录（#77 S3：卸载、内置保护与合法保留）

状态：**真实受控链在本机执行通过（opt-in，不进默认 CI）**。这是**真实 Node 链**证据（真实 `npm-ci` 受管安装 + 真实 GitHub 解析 + 冻结受管 pnpm 执行器 + 真实受管进程），**不是**桌面验收，也**不是** ADR 0005 E9（`--dump-config` == 运行期加载集合）等价性证明。完整联网桌面链由独立 QA 单列。

## 元数据

| 项 | 值 |
| --- | --- |
| 平台 | macOS（darwin arm64），Node `v24.21.0`（宿主，仅驱动探针） |
| 受管运行时 | node `22.19.0`（sha256 `c59006db…`）+ DSH `0.1.5-rc.2`（sha256 `f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480`）+ `@deepseek-ai/cordis` `4.0.2` + `@deepseek-ai/cordis-plugin-loader` `1.0.3` |
| 受控 fixture | `YingkeSu/hdsl-plugin-e2e-fixture` @ `e7825788cce5e056a0eee6c1ff1ffbbf7c1c8838`（manifest sha256 `ee613a2eb425a24bc44e946d84e36b7ceb2f594f1214913ff34dd0d0e450ba5c`，known empty providers） |
| 核验记录绑定 | [plugin-remove-service-verification.md](plugin-remove-service-verification.md) |
| 实现基线 | 分支 `ao/hdsl-34/plugin-remove-loop`（承接 hdsl-32 `d673b78`，含本片 core/runtime/contracts/desktop 接线） |
| 探针 | `scripts/research/a2-real-plugin-remove-probe.mjs` |
| 缓存（显式提供，只读复制到自有临时根） | `HDSL_A2_CACHE=<verified-artifacts>`、`HDSL_A2_NPM_CACHE=<verified-npm-cache>` |
| 凭据/模型 | 无个人凭据、无模型调用；仅受控 fixture |

## 复现命令

```sh
HDSL_REAL_PLUGIN=1 \
HDSL_A2_CACHE=<verified-artifacts-dir> \
HDSL_A2_NPM_CACHE=<verified-npm-cache-dir> \
node scripts/research/a2-real-plugin-remove-probe.mjs
```

探针在 `mkdtemp` 自有数据根内执行，使用真实生产适配器（`createGitHubPluginSource`、`createManagedPnpmExecutor`、`createPluginApplyPort`、`createPluginRemovalPort`、`createChangePreviewService`/`createChangeApplyService`（core 侧 `ChangePreviewService`/`ChangeApplyService`））。无凭据、无模型、只安装已审 fixture。

## 结果（17/17 PASS）

脱敏输出（精确 fixture commit）：

```text
CHECK PASS install recorded pluginSources for the exact fixture commit
CHECK PASS installed generation starts
CHECK PASS before removal: fixture apply marker appears
remove plan: removals=["dependency entry hdsl-plugin-e2e-fixture@github:YingkeSu/hdsl-plugin-e2e-fixture#e7825788…","enabled bundle reference hdsl-plugin-e2e-fixture"]
remove plan: retention=["user patch layer (home cordis.patch.yml)","environment data (home/ and data/)","plugin operation audit log","shared/transitive dependencies remain in the profile lock"]
CHECK PASS remove preview is unblocked for the reviewed fixture (known empty providers)
CHECK PASS remove preview lists the dependency entry + enabled reference
CHECK PASS remove preview retains the user patch layer + environment data
CHECK PASS negative control: unverified service binding BLOCKS (unknown, no applyability)
builtin negative control target=@deepseek-ai/dsh-base status=failed error=BUILTIN_BUNDLE_PROTECTED
CHECK PASS negative control: REAL in-box bundle name is BUILTIN_BUNDLE_PROTECTED
removal committed; generation=gen-005bfce25d474123 revision=3
CHECK PASS removal committed a NEW active generation
CHECK PASS active generation lock no longer enables the package
CHECK PASS active generation lock drops the package source binding
CHECK PASS user patch bytes are unchanged (never written back)
CHECK PASS environment home data preserved
CHECK PASS removed generation starts and becomes running
CHECK PASS after removal: removed generation writes NO new fixture marker
offline dump-config exit=0 mentionsFixture=false
CHECK PASS offline composition tree no longer contains the package
RESULT: PASS — 17/17 checks
```

### 分栏 1：卸载前（安装生效）

- 真实预览 → 真实 apply 安装 fixture；活动代 `gen-edcc4ac867544370`（`revision=2`），`composition.lock.json` 的 `plugins` 含 fixture、`pluginSources[fixture].commitSha` == `e7825788…`（精确来源绑定，不是 live 文件自建信任）。
- 启动该代：受管进程 `succeeded`，fixture 的 apply marker（`$HOME/hdsl-e2e-marker/applied`）出现 → 该 bundle 真实加载。

### 分栏 2：卸载（预览 + 提交）

- `changes.preview`（remove，精确 pluginId）：`blockingReferences=[]`；`removals` = 直接依赖条目 + 启用引用；`retention` = 用户 patch 层、环境数据（`home/`+`data/`）、审计日志、lock 中的共享/传递依赖。
- `changes.apply`：提交新活动代 `gen-005bfce25d474123`（`revision=3`）；新代 `composition.lock.json` 的 `plugins` 不再含 fixture，`pluginSources` 也移除该绑定；旧代目录保持可读。

### 分栏 3：重启与生效

- 移走探针自有的旧 marker 后启动卸载代：受管进程 `succeeded`（环境可用），整窗观察**未产生新 marker** → 卸载后的启用集合不再加载该 fixture。
- 离线 `--dump-config`（`--profile hdsl-<卸载代>`）退出码 0 且**不包含** `hdsl-plugin-e2e-fixture` → 「活动代际记录 + 受管 DSH 离线解析组合树」两面一致。
- 用户 patch 原字节不变（探针写入的固定字节读回完全相等）；环境 `home/` 用户数据文件保留。

### 分栏 4：负控（单列）

- **unknown 服务核验一律阻塞**：在自有临时代上把 `pluginSources[fixture].commitSha` 受控改为不匹配值（不改 fixture、不改用户数据），同一 remove 预览的 `blockingReferences` 出现「service dependencies for this plugin are not verified」→ 阻塞且不可 apply；随后恢复原字节。
- **内置保护负控使用当前安装的真实 in-box 名**：`@deepseek-ai/dsh-base`（来自当前受管 DSH 安装解析的 in-box 集合，且是当前 profile 的启用 bundle，但**不是** profile-lock 依赖）。预览以 `BUILTIN_BUNDLE_PROTECTED` 失败，不产生 plan、无副作用、不运行执行器。

## 能证明（精确边界）

- 生产 core 事务（preview/apply）与真实 runtime 移除端口在同一受控 fixture 上闭环：真实来源解析、真实受管 pnpm、真实 profile 发布/指针切换/journal/代际记录。
- 移除后「活动代际记录」与「受管 DSH 离线解析组合树」都不再包含该包；卸载代可启动且不再加载该 bundle（外部 marker 观察）。
- 共享/传递依赖保留为预期行为；用户 patch 原字节不被写回；环境数据保留。
- unknown 服务核验阻塞与内置保护（真实 in-box 名）均有确定性断言。

## 不能证明（不得外推）

- **不是桌面/Electron 验收**：未启动 HDSL 桌面 UI、未走 preload/IPC 白名单、未验证渲染层。
- **不是 E9 等价性证明**：`--dump-config` 与运行期实际加载集合的等价性仍开放（ADR 0005 E9）；本记录只把「活动代记录 + 离线组合树」作为生效判据，运行期加载由单一 marker 侧面观察（marker 出现=该 bundle 加载；marker 不出现不排除「进程存活但实际已加载」，见 home 派生实证的负控强度说明）。
- **不是任意第三方插件的可卸载性**：服务级耦合仅在 HDSL 受限声明 + 核验记录范围内可判定；绝无核验记录的插件一律 unknown 阻塞。
- 不覆盖 Windows/Linux；不覆盖真实桌面崩溃窗口的全相位 `SIGKILL`（见 `tests/core/a2-window-kill.test.ts`、`apply-window-kill.test.ts`）。

## AC9：卸载路径的失败分类（有界、可证伪）

**网络面事实**：卸载路径**不调用 GitHub API**（无 GitHub API 限流面）；但 preview 的 `pnpm install --lockfile-only` 与 apply 的 `pnpm install --frozen-lockfile --ignore-scripts` 由受管 pnpm 执行，executor 设置 `npm_config_registry`，pnpm 会从 registry 拉取剩余包、git 依赖从 codeload tarball 拉取 ⇒ **存在真实包获取网络面**。`EXECUTOR_UNAVAILABLE` **仅**表示受管执行器制品/身份问题，**不**覆盖包获取失败。

**非零退出分类**（`classifyManagedInstallFailure`，作用域仅限移除端口；不扩 S2）：

| 可观测证据（冻结 pnpm 11.7.0 的稳定 token） | 既有契约码 | retryable |
| --- | --- | --- |
| `ENOTFOUND` / `EAI_AGAIN` / `ECONNREFUSED`（连接未建立） | `NETWORK_UNAVAILABLE` | 是 |
| `ECONNRESET` / `EPIPE` / `ECONNABORTED` / `ERR_STREAM_PREMATURE_CLOSE` / `UND_ERR_SOCKET` / `UND_ERR_BODY_TIMEOUT`（连接已建立后中断） | `DOWNLOAD_FAILED` | 是 |
| `ERR_PNPM_TARBALL_INTEGRITY` / `ERR_PNPM_BAD_TARBALL_SIZE`（取物/校验失败） | `DOWNLOAD_FAILED` | 是 |
| 其它/不可靠识别 | `INTERNAL_ERROR`（脱敏） | 否 |

- **不编造限流映射**：冻结 pnpm 只对 401/403 有字面码且均路由到 `reportAuthError`（**403 是认证/权限，不是限流**），且不存在 `429`/`ERR_PNPM_FETCH_${status}` 模板 ⇒ registry 限流在本通道**不可靠识别**，保持 `INTERNAL_ERROR`；未设置 `retryAfterSeconds`（无机器可读依据）。
- **不外泄**：只做整 token 匹配，错误文案固定且**绝不包含 stderr 原文**（无路径/凭据泄漏面）。
- **跨版本失效**：该分类绑定受管 pnpm `11.7.0` 的稳定 token；换 pnpm 版本需重新核验。

**负控**（`tests/core/removal-apply.test.ts` / `tests/plugins/removal-port.test.ts` / `tests/renderer/plugin-removal.test.ts`）：preview 与 apply 的运行期非零退出分别命中上述码；旧代际/指针/revision 不变、计划未消费、stage 目录清理（仅保留旧代）、同一计划用新 `requestId` 可重试成功；不可识别 ⇒ `INTERNAL_ERROR` 非重试且不含原始文本；UI 对可重试失败给出准确文案并保留重试入口。

## 本片修复的真实缺陷（均有回归测试）

1. **完全剪除后的 lock 被判为不可解析**：`resolveLockClosure` 在 pruned lock 只剩根 importer、无 `packages`/`snapshots` 段时返回 `unsupported`，使「删掉最后一个直接依赖」的合法卸载失败。修复：根 importer 无直接依赖 ⇒ 空闭包（`ok`），仅在仍有直接依赖却无法解析时 fail-closed。回归 `tests/plugins/lock-closure.test.ts`。
2. **不在 profile-lock 中的内置 bundle 被报为通用内部错误**：真实 in-box bundle 是启用 bundle 而非 profile-lock 依赖，旧的移除端口先从 lock 闭包推导目标身份并 fail-closed，导致 `INTERNAL_ERROR` 而非 `BUILTIN_BUNDLE_PROTECTED`。修复：纯解析判定为内置后立即返回受保护结果、不运行执行器、无副作用。回归 `tests/plugins/removal-port.test.ts`、`tests/core/removal-apply.test.ts`。
3. **阻塞的 remove 计划在 apply 时被误报 `PLAN_STALE`**：预览为阻塞 removal 仍产出计划但故意不写 target-profile cache，旧的 apply 先读 cache 于是把“阻塞”降级为 cache 缺失。修复：`evaluateGuards` 在任何效果前对 `blockingReferences.length > 0` 的 remove 计划返回 `REFERENCED_BY_OTHER`（绕过 UI 的程序化调用者拿到真实原因）。回归 `tests/core/removal-apply.test.ts`（含“不运行执行器、不消费计划、不改环境”负控）。
4. **移除计划的绑定不足**：remove 计划 `sourceLock: null`，仅绑定 pruned declaration 摘要时，目标 repo/commit/manifest 或核验适用 runtime 漂移但 pruned declaration/lock 未变的情况无法被检出。修复（不增公开字段）：`planInputsDigest` 改为对「pruned declaration 绑定 + 精确 recorded commit/manifest + 受管 runtime 身份」的内部组合摘要；apply 用同一推导重算并在任何效果前拒绝漂移（`PLAN_STALE`），lock 仍由 apply 时重解析逐字比对。回归 `tests/core/removal-apply.test.ts`（记录 commit 漂移 ⇒ `PLAN_STALE`）。
5. **33 离线真实 UI 的 `INTERNAL_ERROR` 根因（旧代无 `pluginSources`）**：在 33 的证据根（`/tmp/qa33/s3-data`，只读，staging 落在自有临时目录）复现：该代 `composition.lock.json` 无 `pluginSources`，剪除唯一直接依赖后的 pruned lock 无 `packages`/`snapshots`，被旧 `resolveLockClosure` 判为不可解析。修复 1 后，同一输入得到 `blockingReferences` = 「service dependencies for this plugin are not verified」的**阻塞计划**（`serviceVerification=unknown`），符合 D21 既有代兼容：无精确来源/核验记录 ⇒ unknown 阻塞、正常运行不受影响，UI 呈现“无法验证服务依赖，暂不能卸载”，而非无解释 `INTERNAL_ERROR`。回归 `tests/core/removal-apply.test.ts`（pre-S3 无 `pluginSources`）与 `tests/renderer/plugin-removal.test.ts`（`source:null` + 阻塞文案）。

> 绑定边界说明：remove 计划保持 `sourceLock: null`；其 `planInputsDigest` 内部绑定 pruned declaration、目标精确 recorded commit/manifest 与受管 runtime 身份；composition lock 与 pruned lock 由 apply 时重解析逐字比对；user patch/引用漂移由 apply 时重扫拒绝。上述均为内部摘要/记录，未新增公开契约字段。
