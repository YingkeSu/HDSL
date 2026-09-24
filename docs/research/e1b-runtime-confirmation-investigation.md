# E1b（#116）运行期确认/ACK 与 launcher 会话面调查

状态：**调查完成 — no-go（无可用的公开、可维护确认路径）**。本文件只记录研究结论与有界实验证据，不实现产品接线。

- 基线：`origin/main` = `1d2886ebf7cbd639898f9ac31c800a4e339e633f`（2026-09-23）。
- 前置：E1a desired-config 边界已交付（[验证记录](../development/plugin-runtime-entry-validation.md)、[E1 spec](../../specs/002-plugin-transactions/e1-runtime-entry/spec.md)）；事实台账 [#117](https://github.com/YingkeSu/HDSL/issues/117)。
- 本切片只回答问题：**HDSL 能否经官方 rc.2 接口、通过 launcher UI 可用的文档化会话路径，获得可靠的 loader readiness 与运行期 ACTIVE？** 答案：**否**（见 §6）。实验脚本：[`scripts/research/e1b-readiness-ack-probe.sh`](../../scripts/research/e1b-readiness-ack-probe.sh)（opt-in，不进默认 CI）。

## 1. 范围与非声明

- 只读上游安装包/上游 tag 源码 + 隔离实测；不执行未审第三方/模型代码、不用个人凭据、不改产品、不开 PR。
- 不是插件安全认证、不是桌面验收、不是 E9（dump == 运行期加载集合）等价性证明。
- 未测平台保持未测（Windows/Linux）；Node 22.19.0 未在本机复跑。

## 2. 精确版本与来源

| 项 | 值 |
| --- | --- |
| 受管 DSH | `@deepseek-ai/dsh@0.1.5-rc.2` |
| tarball sha256 | `f4c54839d69e82bf1c3a5a41a910c3ce1405cd9e9d97d753c0c04f406c7d7480` |
| npm integrity | `sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==`；shasum `2c78db39568d910868f1e4f34062a4f346d4815d` |
| 上游 tag | `dsh-v0.1.5-rc.2` = `fb2c4b9e698e30edb738bca4cf0618587db7d203` |
| 锁定组合 | cordis `4.0.2` / cordis-plugin-loader `1.0.3` / cordis-plugin-hmr `1.0.17`（`packages/runtime/catalog/dsh-0.1.5-rc.2/package-lock.json`） |
| 实验运行时 | Node `24.21.0`（受管组合之一）与 Node `25.6.1`（对照） |
| 上游源码引用 | 均按 tag `dsh-v0.1.5-rc.2` 的 file:line |

安装副本：`/tmp/dsh-015`（与受管锁定组合一致）。上游源码以 `git archive dsh-v0.1.5-rc.2 <paths>` 解出到临时目录，未改动本机 checkout。

## 3. 静态接口结论（rc.2）

### 3.1 唯一运行期只读面是 Remote-only 的 `pluginInventory/list`

- `packages/host/plugin-inventory/README.md:28`：**“The Remote is the only entry point: the service is Remote-only and deliberately declares no same-process Cordis `Context` merge.”**
- `README.md:12`：它是 **point-in-time、只读快照**，“cannot mutate plugins and provides no history, provenance, or change subscription”。
- `packages/host/plugin-inventory/src/types.ts:16-22`：每行只有 `{ entryId, moduleName, enabled, fiberPhase }` —— **没有 config、没有错误文本、没有 provenance**。`fiberPhase ∈ {pending, loading, active, failed, unloading, null}`。
- 结论：`config` 变更**不可被该面观测**；`enabled`/存在性可观测，但只能轮询、无订阅。

### 3.2 每条 Host RPC 都需要一个浏览器会话

- `packages/client/connection/README.md:35`：**“Every Host RPC method and WebSocket stream requires one browser session; there is no method-specific loopback tier.”**；`?token=` 仅在 `GET /` 兑换为 **authority-bound 签名 cookie**；HTTP carrier “accepts no query token outside the root exchange and no Authorization-header token.”
- `README.md:37`：cookie 为 **host-only、Path=/、HttpOnly、SameSite=Strict**（loopback HTTP 故无 `Secure`），签名绑定 normalized host+port。
- 无 Node/launcher SDK：unary 走 `ctx.connection.rpc.call('/api', endpoint, …)` 的 Typert 信封（`packages/api/gateway/README.md`），非文档化的外部客户端协议。

### 3.3 没有运行期 CLI 状态命令

`apps/cli/src/bin.ts` 只有 `profile` / `plugin` / `dump-config` 三种 mode：`plugin` = `pnpm add|remove|why`（包管理），`--dump-config` = **离线期望组成**。没有 `status`/`inventory` 类命令。

### 3.4 `dsh web:` ready line 不是 watcher-armed ack

- ready line 由 web-app 在 `loader.await()`（loader tree settle）后打印：`packages/bundle/web-app/src/index.ts:283-295`。
- 而 profile patch watcher 在 `runProfile` 于 `boot()` 返回**之后**才安装：`apps/cli/src/profile-boot.ts:372-389`（`watchUserPatches`，随后才 `appReady.commit()`）。
- `appReady` 作为 `ctx.appReady` 提供，但只被 stdio 一次性应用消费（`packages/boot/cmdline/src/index.ts:125`），**不经 Remote 暴露**。
- 因此 launcher 可见的 ready line 与“patch watcher 已武装”之间没有任何公开确认。

### 3.5 patch 热路径失败只进 in-process 事件/logger

- `vendor/hmr/src/index.ts:297-315`：`refreshConfig` 捕获 refresh 异常后 `ctx.logger.warn(...)` 并 `ctx.parallel('hmr/config-update-failed', …)`。
- 这些是 Cordis in-process 事件（`vendor/hmr/src/index.ts:22,29`），**不在**转发给客户端的 allowlist 内（`packages/api/remotes/src/remote-events.ts:17-35`，19 个事件，无 `hmr/*`）。
- web profile 默认 `hmr` 行 `disabled: true`（`--dump-config` 观察）；`runProfile` 会补建 watch-only 实例。该 profile 组合未挂 logger-console，故 `logger.warn` 在实测中**不落到 stdout/stderr**。

## 4. HDSL 会话/origin 事实

- HDSL **从不**在自己的窗口加载 DSH WebUI：`apps/desktop/src/main/security.ts:7` 注释“The managed DSH WebUI is never loaded in an HDSL window (main opens it natively after ownership verification) so a DSH page can never reach the launcher bridge.”
- 打开方式是主进程 `shell.openExternal(bootstrapUrl)`（`apps/desktop/src/main/app.ts:69`，经 `apps/desktop/src/main/webui.ts` 的 main-only `consumeWebUIBootstrap`），即**系统浏览器**；bootstrap URL 被视为密钥（`packages/runtime/src/process/readiness.ts:10,23`）。
- HDSL renderer 是 `window.loadFile(RENDERER_INDEX)`（`apps/desktop/src/main/app.ts:259`）⇒ **`file://` origin**。
- 结论：**不存在“实际 HDSL BrowserWindow 的 DSH origin/session”**。DSH cookie 在系统浏览器、HttpOnly、不可被 launcher 读取；HDSL renderer origin 与 DSH origin 不同。

## 5. 隔离实测（有界、自有 fixture、0 残留）

隔离自有 `HOME`/`DSH_HOME`/`TMPDIR`、`DSH_TELEMETRY_DISABLED=1`；fixture 只 `import node:fs`/`node:path`，无网络/子进程/模型/个人凭据；有界 SIGTERM→SIGKILL；证据目录已清理，0 残留进程。

### 5.1 关键回归：原子写 vs 非原子写（修正“预热窗口”归因）

| 写方式 | Node | 结果 |
| --- | --- | --- |
| 非原子 `cat > file`（截断+写） | 25.6.1 | 首次应用 attempts=8 / **37s**；`stdout` 恒为 83 B、`stderr` 0 B |
| 非原子 `cat > file` | 24.21.0 | **189s / 37 次重写仍未应用**；`stdout` 83 B、`stderr` 0 B |
| **原子 temp+rename** | 24.21.0 | **attempts=1 / 0s**；两行同 PID 加载 |
| **原子 temp+rename** | 25.6.1 | **attempts=1 / 0s**；两行同 PID 加载 |

Node 24.21.0 下用带 `hmr` 事件监听的自建诊断行复现：非原子写每次触发 `hmr/config-update-failed … must be a top-level YAML array`（即 watcher 读到截断/空快照，`parsePatchList` 抛错被 in-process 吞掉）；改用原子写后 **5s 内加载、无 `config-update-failed`**。

⇒ 先前记录的“约 12s 预热窗口（G8a）”**主要不是 HMR 预热，而是非原子写与 watcher 的竞态**：截断瞬间被观察为非法 patch，错误被 live 回调吞掉、launcher 全无可见信号。这直接印证 #116 AC1 的“原子写（临时文件 + rename；不得清空或留下半写文件）”。

### 5.2 合法非空数组移除（#116 硬前置，原子写）

| 运行 | 时间 (UTC) | Node | preheat | 移除尝试 | 结果 |
| --- | --- | --- | --- | --- | --- |
| A | 2026-09-23T10:58:41Z | 24.21.0 | 0s / 1 | 1 | `row-a` 同 PID（41937）`dispose`、`row-b` 保留、same_pid=yes、0 残留 |
| B | ~2026-09-23T10:59:09Z | 25.6.1 | 0s / 1 | 1 | 同上（PID 42238） |

证据（本机临时，已清理）：run A `console.txt` sha256 `d510529ad55e5e503461aff9d65feec4d7a6399b5aea26b41c4f6a8f51084034`、`events.log` sha256 `a85633b2af8515117712f013dc756ca79cc5c5c8625bd3c650ab0f0ce7e01c0a`；run B `console.txt` sha256 `bcb29c3d2fefc1374b16bfeb86d3f93f5166bf4290511e5c5f166a1e479b2a85`、`events.log` sha256 `9a8c57fcbd6a70c0a76c3b144965cbc13c06a16dbbb80006d801a6ae803f6089`。

### 5.3 非法 patch 吞错负控（原子写 mapping root）

原子写入 `foo: bar\n`（顶层非数组）：`stdout +0`、`stderr +0`、目标行**未卸载**、无任何可见诊断（Node 24/25 一致）。与 §3.5 一致：失败只进 in-process 事件。

### 5.4 会话面 / `pluginInventory` 可达性（研究演示，非产品路径）

同一隔离启动上：

- `GET /`（无 cookie）→ **401**。
- `POST /api/pluginInventory/list`（无 cookie）→ **401**。
- `POST /api/pluginInventory/list` + `Origin: file://` → **403**（Host/Origin fence 拒绝 HDSL renderer 的 file origin）。
- `GET /?token=…` → **303** + `Set-Cookie: dsh-auth-…=v1.<signed>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`（payload 绑定 `127.0.0.1:<port>`）。
- 用 ready line 的进程 token 兑换 cookie 后，`POST /api/pluginInventory/list`（信封 `{"type":"client-request","rpcId":…,"method":"pluginInventory/list","payload":{"args":{}}}`）→ **ok，157 条 entry**；fixture 行为 `{"entryId":"include:e1b-inv-fixture","moduleName":"e1b-ready-fixture","enabled":true,"fiberPhase":"active"}`，字段仅 `entryId,moduleName,enabled,fiberPhase`。

⇒ 技术上“可达”，但需要主进程用 ready line 的进程 token **自铸浏览器会话 cookie** 并实现 Typert 的 HTTP 信封——这正是 #116 非目标里“不假定 launcher BrowserWindow 天然有 DSH cookie / 不新增私有 bridge / 不伪造会话”的灰区，且不是文档化的 launcher SDK。

## 6. 为什么这仍然不构成产品级确认

即便接受上述会话自铸路径，`pluginInventory/list`：

1. **无法确认 `config` 变更**：行里没有 config；config 生效与否只能靠插件副作用间接推断，通用不了。
2. **无变化订阅**：point-in-time 快照，只能轮询；失败条目可能显示 `failed` 或直接消失，无法区分“尚未应用 / 已失败 / 已移除”。
3. **无法给 watcher-armed ack**：ready line 不等于 watcher 已武装；inventory 也不暴露 HMR 状态。
4. **仍吞错**：非法 patch 的失败只在 in-process 事件里；inventory 看起来只是“没变化”。
5. **会话自铸是产品/安全决策**：需要 HDSL 主进程持有并重用 DSH 会话 cookie（当前架构明确把 DSH 页面挡在 HDSL 窗口之外）。

因此：**没有公开、可维护、且在“实际 HDSL BrowserWindow origin/session”下可用的确认/ACK**。

## 7. 处置建议

- 保持 #116 **`needs-triage`**（不升级为 `ready-for-agent`）。
- 产品口径维持 E1a：写入只显示 **“已保存 / 等待 DSH 应用”**，并给**显式重启 fallback**；**不得**显示“已生效”，**不得**用 fixture marker 或 dump 冒充 ACTIVE。
- 若未来要做运行期 ACTIVE，应另开 issue 先做**会话所有权/安全决策**（是否允许 launcher 自铸会话、cookie 生命周期、与 ADR 0002 凭据边界的关系）；并且该面**仍无法确认 config 变更**，只能确认插入/禁用/移除的存在性与相位。
- E1b 由此关闭为“一次性有界调查”；除本文与实验脚本外不新增实现。

## 8. 复现命令

```bash
# 需要一份与受管锁定组合一致的 rc.2 安装（cordis 4.0.2 / loader 1.0.3 / hmr 1.0.17）
HDSL_E1_DSH_PACKAGE=<install>/node_modules/@deepseek-ai/dsh \
HDSL_E1_NODE=/path/to/node \
bash scripts/research/e1b-readiness-ack-probe.sh

# 可选超时覆盖（默认见脚本头部）
#   HDSL_E1B_PREHEAT_TIMEOUT=60 HDSL_E1B_UNLOAD_TIMEOUT=60 HDSL_E1B_SWALLOW_WAIT=10
```

上游静态核对：

```bash
git archive dsh-v0.1.5-rc.2 \
  packages/host/plugin-inventory packages/client/connection \
  apps/cli packages/boot/app-boot packages/bundle/web-app \
  packages/api/gateway packages/api/remotes vendor/hmr | tar -x -C <tmp>
```

## 9. 未测 / 局限

- Node **22.19.0** 未在本机复跑（无该版本）；本文的 0s/1 次原子写结果在 24.21.0 与 25.6.1 成立。E1a 历史记录声称 22.19.0 两次 PASS，未在本切片重验。
- 会话演示用 `curl` 复现了文档化 token→cookie 交换与 unary 信封，但**未**实现/产品化任何 Typert 客户端；演示仅是可达性证据。
- 未验证 `pluginInventory` 的 `websocket`/stream 面与 `$events` 订阅在 launcher 场景下的行为（也不需要：无会话）。
- Windows/Linux 未测；仅 loopback 未用套接字清单证明（不声称）。
- 上游 tag 源码为静态阅读；未对本切片引用的每个文件做逐字节安装对比（cordis 文件此前已比对一致）。
